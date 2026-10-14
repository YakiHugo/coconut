# 开发模式获取现成字幕

`npm run dev` 仍默认不运行 Python。现在可以显式复用已有、可信的 Python 环境，通过与打包版相同的受限 X 字幕协议获取文字稿。这个选项只适用于源码开发入口，不改变 `npm run start:light` 或 macOS 安装包。

## 启用和检查

已有 Python 环境需包含固定版本 `yt-dlp==2026.8.19`（运行时报告 `2026.08.19`）及有效 TLS 根证书包 `certifi`。只使用你自己安装、信任的解释器；不要把下载的未知程序当作解释器路径。Coconut 不安装、更改或自动寻找这些依赖。

确认 8080 未被另一项服务占用后，在仓库根目录运行（将路径替换为已有环境的绝对路径）：

```sh
COCONUT_CAPTION_PYTHON=/absolute/path/to/venv/bin/python npm run dev
```

另一个终端运行 `npm run doctor`。启动日志、doctor 和 `GET /api/captions/status` 会报告是否就绪。未配置、路径无效、缺少依赖、版本不匹配或 TLS 检查失败时，阅读和其他接口仍可用，字幕能力不会声明为可用。常见状态：

- `CAPTION_CONFIGURATION`：解释器必须用绝对路径
- `CAPTION_START`：解释器无法启动
- `CAPTION_EXIT`：Python 无法完成探测，例如尚未安装依赖
- `CAPTION_VERSION`：协议、固定版本或 TLS 检查不匹配
- `CAPTION_UNAVAILABLE`：没有配置可用助手

改动环境或依赖后手动重启开发服务，再检查；不要删除任务数据或浏览器书架。无需获取字幕时，不设置环境变量即可。HTTP/页面不能设置解释器路径或执行命令。

## 当前可用范围

- 仅公开 X / Twitter 单视频现成原语言字幕。粘贴支持的链接后，现有阅读器字幕入口可获取、校验并打开文字稿。
- YouTube / Bilibili 在此 Node 开发桥接中仍未接入。`providers` 分别报告实际能力，不能把 X 的就绪当作所有视频来源就绪。
- 字幕缺失、语言不明确、登录要求、访问拒绝、限流和获取失败不会触发 ASR、媒体下载、模型安装或模型请求。可导入/粘贴合法取得的字幕；语言不明确时可选原语言后重试。
- 依赖版本探测不会访问视频来源。只有明确提交字幕链接才发起公开获取。不会读浏览器登录、Cookie 或用户账户。

## 实现和验证边界

开发模式用绝对解释器路径、`-I -B` 和固定仓库启动代码，复用 `caption_helper_launcher.py` / `public_x_caption_guard.py`。进程使用独立临时 HOME、配置和缓存目录，不继承代理、令牌、Python 注入或外部可执行文件搜索路径；不经 shell。探测最多 10 秒，获取最多 130 秒，输出有界；取消/退出杀掉进程组并等待退出、清理临时目录。返回内容继续经现有来源、语言、时长、字幕格式和时间轴校验。

这是显式信任的源码开发环境，不是打包版的固定二进制完整性证明，也不是操作系统沙箱。Python 环境自身必须可信。打包版的哈希校验和私有可执行快照保持原样。

`node --test tests/desktop-development-captions.test.mjs` 使用真实子进程、编写的协议夹具和真实本机 HTTP 接口验证从链接到文档、环境隔离、失败、取消、并发、超时与清理；不代表本次真实平台网络获取已通过。实际 X 公共路线的独立证据与边界见 [受限 X 验收](public-x-caption-proof.md)。

## YouTube / Bilibili 的下一步

现有高级 Python 路径 `subtitle_import.fetch_subtitle_document` 已使用官方 yt-dlp 取元数据、选择原语言字幕并下载 VTT / SRT / JSON3。`transcribe.py --captions-only` 在无合适字幕时停止；识别库是延迟导入，单纯字幕路径不需要 faster-whisper、WhisperX 或 ffmpeg。默认完整 requirements 包含这些高级依赖，不应为了取字幕无条件安装整套识别环境。

这条路径尚未接入 Node 的有界子进程契约。下一阶段可单独抽取字幕专用协议，复用已有轨道选择与来源记录，并补充来源校验、文件/输出上限、取消、可信 TLS 与平台真实网络验收。YouTube 官方字幕下载 API 要求授权并要求调用者有编辑视频的权限，不能作为任意公开视频字幕接口。Bilibili 上游提取器明确存在需要登录才能获得字幕的情况；不能因此认定视频没有字幕，也不能把弹幕当字幕。平台支持要分别验证，不应因为有 extractor 就宣称全部可用。

参考：
- [Python isolated mode](https://docs.python.org/3/using/cmdline.html#cmdoption-I)
- [官方 yt-dlp subtitle options](https://github.com/yt-dlp/yt-dlp#subtitle-options)
- [YouTube captions.download](https://developers.google.com/youtube/v3/docs/captions/download)
- [官方 yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)
