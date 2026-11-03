"""Build the deployable Pages site and embed a real frame for each uploaded MP4."""
import base64
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
                "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=640:-2",
                "-c:v", "mjpeg", "-q:v", "5", "-threads", "1",
                "-f", "image2pipe", "pipe:1",
            ],
            check=False, capture_output=True, timeout=60,
        )
        if result.returncode == 0 and result.stdout.startswith(b"\xff\xd8"):
            return base64.b64encode(result.stdout).decode("ascii")
    raise RuntimeError(f"Could not extract a cover from {video.relative_to(ROOT)}")


def build(destination):
    templates = sorted(ROOT.glob("*/index.html"))
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("The destination must be empty.")
    for name in ("index.html", "brand-logo.png"):
        shutil.copyfile(ROOT / name, destination / name)

    for template in templates:
        slug = template.parent.name
        video = template.parent / f"{slug}.mp4"
        page = template.read_text(encoding="utf-8")
        target = destination / slug
        target.mkdir()
        if video.is_file():
            image = f'<img src="data:image/jpeg;base64,{read_cover(video)}" alt="">'
            if page.count(COVER) != 1:
                raise ValueError(f"Expected one cover marker in {template}")
            page = page.replace(COVER, image)
            shutil.copyfile(video, target / video.name)
            print(f"{slug}: cover generated")
        else:
            page, count = re.subn(
                r'<div class="video-stage">.*?</button>\s*</div>',
                '<div class="video-unavailable">Video coming soon.</div>',
                page, count=1, flags=re.S,
            )
            if count != 1:
                raise ValueError(f"Expected one video player in {template}")
            page = re.sub(r"\s*<script>.*?</script>", "", page, count=1, flags=re.S)
            print(f"{slug}: awaiting {video.name}")
        (target / "index.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 build_pages.py OUTPUT_DIRECTORY")
    build(Path(sys.argv[1]))
