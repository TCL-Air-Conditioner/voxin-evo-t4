"""Build Pages with inline covers, stable media versions and a product-scoped cache."""
import base64
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
COVER = "<!-- VIDEO_COVER -->"


def read_cover(video):
    for seek in ("0.15", "0"):
        result = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-ss", seek, "-i", str(video),
                "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=480:-2",
                "-c:v", "mjpeg", "-q:v", "8", "-threads", "1",
                "-f", "image2pipe", "pipe:1",
            ],
            check=False, capture_output=True, timeout=60,
        )
        if result.returncode == 0 and result.stdout.startswith(b"\xff\xd8"):
            return result.stdout
    raise RuntimeError(f"Could not extract a cover from {video.relative_to(ROOT)}")


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(destination):
    templates = sorted(
        path for path in ROOT.glob("*/index.html")
        if COVER in path.read_text(encoding="utf-8")
    )
    if not templates:
        raise ValueError("No video page templates were found.")
    player = (ROOT / "player.js").read_text(encoding="utf-8")
    worker = (ROOT / "sw-template.js").read_text(encoding="utf-8")
    first_page = templates[0].read_text(encoding="utf-8")
    links = re.findall(r'<a class="video-link" href="../([^/]+)/"[^>]*>(.*?)</a>', first_page)
    if len({slug for slug, _ in links}) != len(templates):
        raise ValueError("The directory and page templates do not match.")

    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("The destination must be empty.")
    (destination / "covers").mkdir()
    shutil.copyfile(ROOT / "brand-logo.png", destination / "brand-logo.png")
    logo_version = digest_file(ROOT / "brand-logo.png")[:16]
    assets = ["brand-logo.png?v=" + logo_version]
    topics = []
    for slug, label in links:
        video = ROOT / slug / (slug + ".mp4")
        item = {"slug": slug, "title": html.unescape(label), "file": None, "cover": None}
        if video.is_file():
            media_hash = digest_file(video)
            cover = read_cover(video)
            cover_name = "covers/" + slug + "." + hashlib.sha256(cover).hexdigest()[:16] + ".jpg"
            (destination / cover_name).write_bytes(cover)
            item.update({
                "file": slug + "/" + video.name + "?v=" + media_hash[:16],
                "hash": media_hash,
                "bytes": video.stat().st_size,
                "cover": cover_name,
            })
            assets.append(cover_name)
        topics.append(item)

    version_input = player + worker + Path(__file__).read_text() + json.dumps(topics, sort_keys=True)
    version_input += "".join(path.read_text() for path in templates)
    version_input += (ROOT / "index.html").read_text() + logo_version
    version = hashlib.sha256(version_input.encode()).hexdigest()[:16]
    catalog = {"version": version, "topics": topics}
    by_slug = {item["slug"]: item for item in topics}

    def attach_player(page, relative_root):
        page = re.sub(r"\s*<script>.*?</script>", "", page, flags=re.S)
        data = dict(catalog, root=relative_root)
        data_json = json.dumps(data, ensure_ascii=False).replace("<", r"\u003c")
        scripts = '<script id="videoCatalog" type="application/json">' + data_json + "</script>\n"
        scripts += "<script>\n" + player + "</script>\n"
        page = page.replace("</body>", scripts + "</body>")
        page = re.sub(
            r'(src="(?:\./|\.\./)brand-logo\.png)"',
            lambda match: match[1] + "?v=" + logo_version + '"',
            page,
        )
        return page

    for template in templates:
        slug = template.parent.name
        item = by_slug[slug]
        page = template.read_text(encoding="utf-8")
        target = destination / slug
        target.mkdir()
        if item["file"]:
            raw = (destination / item["cover"]).read_bytes()
            image = '<img src="data:image/jpeg;base64,' + base64.b64encode(raw).decode() + '" alt="">'
            if page.count(COVER) != 1:
                raise ValueError(f"Expected one cover marker in {template}")
            page = page.replace(COVER, image)
            media_name = slug + ".mp4"
            media_url = media_name + "?v=" + item["hash"][:16]
            page = page.replace('src="' + media_name + '"', 'src="' + media_url + '"')
            page = page.replace('href="' + media_name + '"', 'href="' + media_url + '"')
            page = page.replace('id="trainingVideo"', 'id="trainingVideo" crossorigin="anonymous"')
            shutil.copyfile(template.parent / media_name, target / media_name)
            print(slug + ": cover, version and original video ready")
        else:
            page, count = re.subn(
                r'<div class="video-stage">.*?</button>\s*</div>',
                '<div class="video-unavailable">Video coming soon.</div>',
                page, count=1, flags=re.S,
            )
            if count != 1:
                raise ValueError(f"Expected one video player in {template}")
        page = attach_player(page, "../")
        (target / "index.html").write_text(page, encoding="utf-8")

    home = attach_player((ROOT / "index.html").read_text(encoding="utf-8"), "./")
    (destination / "index.html").write_text(home, encoding="utf-8")
    config = {
        "version": version,
        "pages": ["./"] + [item["slug"] + "/" for item in topics],
        "assets": assets,
        "videos": [
            {"url": item["file"], "bytes": item["bytes"], "hash": item["hash"]}
            for item in topics if item["file"]
        ],
    }
    (destination / "sw.js").write_text(
        worker.replace("__CACHE_CONFIG__", json.dumps(config, separators=(",", ":"))),
        encoding="utf-8",
    )
    print("Build version " + version)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 build_pages.py OUTPUT_DIRECTORY")
    build(Path(sys.argv[1]))
