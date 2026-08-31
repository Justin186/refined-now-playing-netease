# Refined Now Playing + AI 逐字歌词

本项目基于 [solstice23/refined-now-playing-netease](https://github.com/solstice23/refined-now-playing-netease) 进行二次开发，在原版精美的沉浸式播放界面与歌词动画基础上，新增了 AI 逐字歌词对齐功能。

本插件集成了本地 AI 逐字歌词对齐功能：从 [LibFrontendPlay](https://github.com/MicroCBer/LibFrontendPlay) 获取当前播放音频，连同歌词文本发送到本地 LRC-Maker AI 后端，用返回的逐字歌词替换 `dynamicLyric`，并通过 `lyrics-updated` 事件提供给其他插件（如LyricBar）。

> 感谢 [solstice23](https://github.com/solstice23) 制作了原版插件并开源，为本项目提供了坚实的基础。如果你喜欢本项目，也请去给原仓库一个 ⭐ Star 支持一下！

## 效果

（视频中的逐字时间戳均由AI处理得到）

https://github.com/user-attachments/assets/e2568e3d-8390-4682-9798-f8e0d5b24755

## 使用前提

1. 已安装并启用 [LibFrontendPlay](https://github.com/MicroCBer/LibFrontendPlay) 插件
2. 本地已启动 [LRC-Maker AI 后端](https://github.com/Justin186/LRCMaker-AI-Backend)（默认监听 `127.0.0.1:8000`，端口探测范围 8000~8009）

## 启用

1. 打开网易云音乐 → 进入CD页 → 右上角设置 → 歌词 → 勾选「AI 逐字歌词」
2. 切换歌曲触发歌词处理

> 该选项默认关闭。关闭时不会探测本地端口、不会下载音频。

## 调试

按 `F12` 打开开发者工具，Console 中会输出 `[AI Lyric]` 前缀的日志：

- `[AI Lyric] 探测到后端端口: 8000` — 端口探测成功
- `[AI Lyric] standard_lrc:` / `[AI Lyric] enhanced_lrc:` — 后端返回的原始 LRC（由「AI 逐字歌词调试输出」开关控制，见下）
- `[AI Lyric] 原始歌词:` — 处理前的歌词行（时间 + 文本）
- `[AI Lyric] 合并后歌词:` — 合并后的歌词行（时间 + 文本 + 是否有逐字 + 逐字拼接文本）
- `[AI Lyric] 已应用 AI 逐字歌词` — 处理成功

### 调试输出开关

设置 → 杂项 → 勾选「AI 逐字歌词调试输出」后，会在 Console 中额外输出后端返回的原始 LRC（`standard_lrc` / `enhanced_lrc`），便于排查后端对齐结果。默认关闭。

如果 Console 中完全没有 `[AI Lyric]` 输出，请检查：

1. 是否已在设置中勾选「AI 逐字歌词」（该开关默认关闭）
2. 是否已重启网易云音乐（让新代码生效）
3. 是否切换了歌曲（歌词处理在切歌时触发）
4. Console 顶部的过滤条件是否误设为只显示错误/警告
5. 是否有使用日志拦截插件

# 开发与部署

## 环境要求

- [Node.js](https://nodejs.org/)（含 npm）

## 构建

```bash
# 首次使用先安装依赖
npm install

# 构建（输出到 dist/ 目录）
npm run build
```

构建产物：

- `dist/main.js` — 插件主逻辑
- `dist/manifest.json` — 插件清单

## 部署到 BetterNCM

BetterNCM 的插件目录（以 Windows 默认安装为例）：

| 路径 | 作用 |
| --- | --- |
| `C:\betterncm\plugins\` | 插件安装包目录（`.plugin` 文件，本质是 ZIP） |
| `C:\betterncm\plugins_runtime\` | 运行时解压目录（BetterNCM 启动时从 `.plugin` 解压到这里） |

> ⚠️ BetterNCM 每次启动都会从 `.plugin` 重新解压到 `plugins_runtime`，所以**只更新运行时目录不够**，必须同时重新打包 `.plugin` 文件。

### 一键部署脚本（推荐）

项目根目录提供了 `deploy.ps1` 脚本，自动完成打包 + 更新运行时：

```powershell
# 构建并部署
.\deploy.ps1 -Build

# 仅部署现有 dist/ 产物（跳过构建）
.\deploy.ps1
```

脚本会自动从 `dist/manifest.json` 读取版本号，无需手动改文件名。如果 BetterNCM 不在默认路径，可指定根目录：

```powershell
.\deploy.ps1 -Build -BetterNCMRoot "D:\betterncm"
```

> 如果提示"禁止运行脚本"，先执行一次：
> ```powershell
> Set-ExecutionPolicy -Scope Process Bypass
> ```

### 手动部署（PowerShell）

构建完成后，在项目根目录运行以下命令（把版本号换成 `manifest.json` 里的 `version`）：

```powershell
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$dest = "C:\betterncm\plugins\RefinedNowPlaying-2.19.5.plugin"
$srcMain = ".\dist\main.js"
$srcManifest = ".\dist\manifest.json"

# 重新打包 .plugin（ZIP，main.js + manifest.json 在根目录）
if (Test-Path dest) { Remove-Itemdest) { Remove-Item dest -Force }
zip=[System.IO.Compression.ZipFile]::Open(zip = [System.IO.Compression.ZipFile]::Open(dest, 'Create')
entryMain=entryMain = zip.CreateEntry('main.js')
stream=stream = entryMain.Open()
bytes=[System.IO.File]::ReadAllBytes(bytes = [System.IO.File]::ReadAllBytes(srcMain)
stream.Write(stream.Write(bytes, 0, $bytes.Length)
$stream.Dispose()
entryManifest=entryManifest = zip.CreateEntry('manifest.json')
stream=stream = entryManifest.Open()
bytes=[System.IO.File]::ReadAllBytes(bytes = [System.IO.File]::ReadAllBytes(srcManifest)
stream.Write(stream.Write(bytes, 0, $bytes.Length)
$stream.Dispose()
$zip.Dispose()

# 同步更新运行时目录
Copy-Item $srcMain "C:\betterncm\plugins_runtime\RefinedNowPlaying\main.js" -Force
Copy-Item $srcManifest "C:\betterncm\plugins_runtime\RefinedNowPlaying\manifest.json" -Force

Write-Host "部署完成，请重启网易云音乐"
```

### 重启并验证

1. 完全退出网易云音乐（托盘图标右键 → 退出）
2. 重新打开网易云音乐
3. 按 `F12` 打开开发者工具，在 Console 中应能看到插件日志
