# 浏览器验收

普通 Python / Happy DOM 测试仍保留。新增 GitHub Actions `Browser acceptance`
在同一台 runner 上启动 Coconut 服务和真实 Chromium，避免把 DOM 模拟播放器当成浏览器解码证据。

## 每次 PR 的自制样例

`browser-smoke` 用 ffmpeg 生成 166.5 秒 H.264/AAC 视频和 221 段自写字幕。
准备脚本写入一个已完成的测试任务，再验证阅读器的文件导入、真实媒体回放、时间定位、
文字高亮、循环、笔记与修正、浏览器下载、刷新和重新导入。
这是播放器与阅读器的集成验收，不是 ASR 验收。

## 原公开视频

在 GitHub Actions 的 `Browser acceptance` 页面选择 **Run workflow**，
在 `original_video_url` 填入需要验收的公开单视频链接。

- 只取已有英文原字幕；没有合适字幕就失败，绝不回退到 ASR 或下载识别模型
- 不使用 Cookie、登录凭据、订阅推理、付费 API 或翻译模型
- 下载视频仍受 Coconut 的 200 MiB 限制；平台访问或字幕获取失败会明确终止
- 下载结果、字幕、笔记、导出、私有日志只留在 runner 临时目录，结束时清理
- 不上传视频、全文、浏览器存储、截图、trace 或下载文件到公开 Actions artifacts
- 日志仅输出检查名称、状态和计数；原样例失败时也不打印包含原文的异常

只有该手动作业成功，才可以说指定原视频通过本轮浏览器验收。
合成样例通过不能替代它；无论哪种作业通过，都不证明转录逐字准确、译文质量、真实订阅额度或 Mac 性能。

## 本地复现

在允许运行 Chromium 的开发环境安装 npm 开发依赖、官方 Playwright Chromium 和 ffmpeg 后：

```bash
work=$(mktemp -d)
python scripts/prepare_browser_acceptance.py --mode synthetic --directory "$work"
COCONUT_ACCEPTANCE_MODE=synthetic \
COCONUT_ACCEPTANCE_DATA_DIR="$work" \
COCONUT_ACCEPTANCE_RESULT="$work/acceptance-result.json" npm run test:browser
rm -rf -- "$work"
```

原视频模式还需 yt-dlp，并以 `COCONUT_ORIGINAL_URL` 指定公开链接；
将准备命令的模式改成 `original`，将其全部输出重定向到临时私有日志。
不要提交真实媒体/稿件，不要给这个作业添加通配符上传 artifact 的步骤。


## 真正的公开播客阅读链路

`Public podcast acceptance` 现在另运行 `tests/podcast-live-browser.mjs`：
在真实 Chromium 中操作 Coconut 的生产 HTTP 桥接与界面，不注入来源或 AI 假处理器。
从发布者 RSS 选择并导入原语言定时稿，创建笔记和阅读位置，下载并检查 JSON / Markdown，
刷新，再在空白浏览器重导下载文件。Apple 目录与小宇宙公开页面也通过实际入口读取；
小宇宙无稿时必须明确停止文字阅读，公开原声则在 Coconut 的播放器中真正解码、播放和定位。

公开原文、媒体、下载文件和浏览器存储只在临时运行环境使用并清理，不上传 artifacts。
这里只证明实际连接和操作链路，不证明发布者稿件逐字准确，也不证明不存在文字稿时已完成转录。

## macOS 安装包内的用户操作

`Lightweight desktop` 的 `tests/desktop-packaged-acceptance.mjs` 解压本次生成的原生架构 ZIP，
直接启动包中的应用；使用自写稿件和 PCM 音频实际操作文件选择器、播放定位、笔记、文字修正、
摘录、阅读位置和四种导出。随后退出应用、重新启动检查恢复，再使用空白配置重导备份。
渲染器仍保持 sandbox / context isolation，测试不检测账户、不调用模型。

这是安装包运行与数据恢复验收，不能替代签名、公证、Gatekeeper 安装、用户 Mac 性能或另一架构的运行验收。
未签名开发包仍有安装门槛；不会要求用户绕过操作系统安全提示。
