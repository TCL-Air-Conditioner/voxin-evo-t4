# VoxIN EVO T4 视频预览

将本目录的内容放到 `TCL-Air-Conditioner/voxin-evo-t4` 仓库根目录，包含隐藏的 `.github` 文件夹。主分支使用 `main`。在仓库的 Settings → Pages 中，将 Source 设为 GitHub Actions。

将每条 MP4 放入下表对应位置。提交到主分支后，工作流读取视频，截取开头画面并把封面嵌入发布的 HTML。视频字节直接复制，封面只存在于部署产物中。若某条视频尚未上传，对应页面显示待发布状态，目录仍可浏览。

| # | 页面名称 | 仓库内视频路径 |
|---|---|---|
| 1 | Deflector Assembly Removal | `deflector-assembly-removal/deflector-assembly-removal.mp4` |
| 2 | Deflector Assembly Installation | `deflector-assembly-installation/deflector-assembly-installation.mp4` |
| 3 | Healthy Filter | `healthy-filter/healthy-filter.mp4` |
| 4 | Wide Range Dual-louver Design | `wide-range-dual-louver-design/wide-range-dual-louver-design.mp4` |
| 5 | Gentle Breeze | `gentle-breeze/gentle-breeze.mp4` |
| 6 | Self-Cleaning | `self-cleaning/self-cleaning.mp4` |
| 7 | GEN Mode | `gen-mode/gen-mode.mp4` |
| 8 | Horizontal Swing | `horizontal-swing/horizontal-swing.mp4` |
| 9 | APP Connection | `app-connection/app-connection.mp4` |
| 10 | Smart Energy Saving | `smart-energy-saving/smart-energy-saving.mp4` |
| 11 | Smart Voice Control | `smart-voice-control/smart-voice-control.mp4` |
| 12 | Voice Language Switching | `voice-language-switching/voice-language-switching.mp4` |

## 本地构建

安装 Python 3 和 FFmpeg。运行 `python3 build_pages.py /tmp/voxin-site`，然后用静态服务器预览该目录。输出目录须为新建或空目录。
