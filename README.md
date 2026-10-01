# 🥥 Coconut

把长音视频变成可信、好读、可回源的文字材料。

## 当前版本

- 阅读器：JSON / SRT / VTT 导入、全文及笔记搜索、时间回源、本地媒体回放定位、原稿保留的文字修正、片段笔记、JSON 备份
- 本地处理服务：公开 YouTube / Bilibili 链接、媒体文件上传、持久任务列表、取消、失败/中断后重试
- 字幕优先：先找匹配原语言的现成字幕；没有适合的字幕才运行本地 ASR，也可手动强制重新转录
- 已完成的字幕/转录结果和下载音频可在重试时复用；ASR 中途被终止仍需重做识别阶段
- 默认不调用付费模型。首次 ASR 使用会下载开源模型；运行时间取决于模型和设备

[在线阅读预览](https://yakihugo.github.io/coconut/) 是纯静态页面，不能替你的电脑运行转录。
完整入口使用下面的本地服务。当前没有公开云转录后端，也没有跨设备自动同步。

## 启动本地 MVP（macOS / Linux）

需要 Python 3.12；视频链接下载音频还需要 ffmpeg。

```bash
git clone https://github.com/YakiHugo/coconut.git
cd coconut
./install.sh
./coconut
```

打开 `http://127.0.0.1:8080`。安装脚本只创建仓库内的虚拟环境，不修改 shell 配置。
若 ffmpeg 未安装，先从其官方安装渠道安装；本地字幕导入不依赖 ffmpeg。

服务仅绑定本机回环地址，不要通过反向代理公开暴露。当前不是多用户服务。
处理记录和输入默认放在 `~/.coconut`，可用 `./coconut --data-dir <目录>` 修改。
网络视频限已结束且可确认时长不超过6小时的内容，拒绝直播和频道/合集。上传限 200 MiB，这是首版的资源保护边界，不是模型或平台的官方限制。

## 阅读与数据保存

- 浏览器中的修正与笔记保存在该浏览器的 localStorage 中；清除网站数据会丢失未导出的修改
- 导出的 JSON 包含修正前文字、时间戳及笔记，可再次导入
- 处理任务和原始结果保存在本地服务的数据目录；它们与浏览器笔记是两份数据
- 无法读懂已有浏览器数据时，阅读器暂停写入，保留原数据；本次内容应先导出再关闭
- 本地上传音视频完成后可按时间戳回听原文件；原文件保留在对应任务目录，迁移文字稿不会自动迁移媒体
- 文字稿展示来源类型与识别模型，专有名词仍需回听核对
- 检测到另一个页面更新书架时暂停写入，先导出当前修改再刷新，避免旧页面覆盖新笔记
- 说话人编号不是真实身份；不让模型根据内容猜人名

## 命令行

```bash
.venv/bin/python transcribe.py 'https://www.youtube.com/watch?v=…'
.venv/bin/python transcribe.py './访谈.mp3' --language zh
.venv/bin/python transcribe.py './字幕.srt' --source-url 'https://www.bilibili.com/video/…'
.venv/bin/python transcribe.py './访谈.mp3' --model small --work-dir ./private-work
```

输出带时间定位的 `.raw.md` 和阅读器可导入的 `.raw.json`。默认输出不会覆盖既有文件；
显式 `-o` 指定输出时会更新该目标。`--work-dir` 保留阶段产物，必须专用于同一份输入和选项。

默认后端为 faster-whisper，small 是初始资源折中，不代表已证明它最适合所有中文材料。
可选 `tiny/base/small/medium/large-v3/large-v3-turbo`。CPU 默认 int8。
有兼容 NVIDIA 环境时可显式指定 `--device cuda --compute-type float16`。
未测过你的 Mac 性能，不提供臆测的 M5 转录耗时。

## 可选增强

- WhisperX：另装 whisperx 后用 `--backend whisperx`，支持独立时间对齐；对齐失败保留 ASR 时间，不丢基础稿
- 说话人区分：WhisperX 路径可用 pyannote；需要自己审阅模型许可并在本机配置相应 Hugging Face 权限
- Claude 润色：另装 anthropic 并在本机配置自己的 API Key 后，显式运行 `polish.py`。这会使用付费 API
- `pt` 默认只导入/转录；第三个参数显式传 `--polish` 才请求付费润色

润色检查完整结束、时间链接和说话人标签是否保留。这不是语义准确性的自动保证。
网页目前没有 AI 问答、自动摘要或知识图谱；这些不属于当前已完成能力。

## 验证与当前局限

```bash
python -m unittest discover -s tests -v
npm ci
npm test
```

- 单元/回归与本地 HTTP 集成：字幕解析、队列重启/取消/重试、实际上传至结果、跨源与路径拒绝、备份笔记
- 云浏览器已操作阅读预览的示例、笔记、搜索、刷新恢复、来源链接校验与文字修正；本地任务界面还需真实浏览器验收
- 已实际运行干净的短英文 JFK 样例（tiny）和短中文公开样例（small）；不能据此声称长访谈、多人或噪声质量已达标
- 文件选择器在测试环境遇到权限步骤中断，浏览器文件导入/备份重导完整链路尚未验证
- 当前未在用户 Mac 上运行，未测试付费润色和可选说话人模型
- 网站获取失败可能来自平台限制；不自动读取浏览器 Cookie，不绕过登录/访问限制

MVP 验收范围见 [docs/mvp.md](docs/mvp.md)。

## License

MIT
