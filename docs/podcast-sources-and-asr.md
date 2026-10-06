# 播客来源与转录方案核查

核查日期：2026-10-06。此文区分当前 Coconut 已实现的入口、上游工具的能力和待实现方案。列出平台不等于承诺该平台所有节目可获取。此次没有调用付费 ASR、开通账户、下载新识别模型或继续已取消的模型下载。

## 产品决策

1. 有可获取、匹配原语言的现成字幕时优先导入；不把自动翻译当作原文。
2. “平台提供”只说明字幕来源，不证明作者手工校对。自动字幕、本地 ASR 和来源不明的上传字幕均保留待核对状态。
3. 元数据或字幕下载失败、登录限制与“没有合适字幕”分开处理。前两者停止并允许重试，不据此静默启动 ASR。
4. 当前网址下载仍限 YouTube、Bilibili、X 的单篇公开内容。其他平台先用用户合法取得的音视频或字幕文件；不读浏览器 Cookie，不绕过付费、DRM、地域或登录限制。
5. RSS 是扩大音频播客覆盖的优先方向，但必须一起实现单集选择、字幕优先、媒体来源校验、大小/时长限制、每跳重定向及 DNS 安全校验，不能把任意网址直接交给现有下载器。

## 来源支持矩阵

| 来源 | Coconut 当前实际入口 | 可行的后续路径与边界 |
| --- | --- | --- |
| 本地音频 / 视频 | 上传 MP3、MP4、WAV、M4A、WebM、OGG、FLAC；本地可选 ASR | 同一内容可配合已有 SRT/VTT/JSON；文件来源合法性仍由用户确认。扩展名是容器提示，不证明声音/画面质量 |
| 音视频直接 URL | 尚未支持任意网址下载 | 先用合法下载的文件。需要专门的公开地址获取器和大小、时长、重定向校验，不能放宽视频站白名单代替 |
| RSS / enclosure | 尚无 RSS 单集导入器 | 读取具体 item 的 enclosure；优先 podcast:transcript。订阅私有 token、会员源另行处理，不记录或分享凭证。规范依据：[RSS enclosure](https://www.rssboard.org/rss-specification#ltenclosuregtSubelementOfLtitemgt)、[Podcasting 2.0 transcript](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md) |
| Apple Podcasts | 当前 Apple 分享链接不能直接导入 | 能获取原发布者公开 RSS 时可走其 enclosure / transcript；订阅专享内容不能按公开源处理。Apple 可自动生成字幕，也可摄取作者提供的 RSS 字幕；其面向创作者的下载流程不是通用听众下载 API。[Apple 官方说明](https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts) |
| Spotify | 当前 Spotify 分享链接不能直接导入 | 优先寻找发布者独立公开 RSS、官网媒体或合法文件。Spotify 的 episode API 是目录信息，官方明确禁止借它促进下载或 stream ripping，不能做通用 Spotify 抓音轨器。[Spotify episode API](https://developer.spotify.com/documentation/web-api/reference/get-an-episode) |
| YouTube | 已有公开单视频、现成字幕优先、本地 ASR 备用 | 原语言、作者/平台提供、自动字幕分开标记。直播、合集、登录或访问失败不等于“无字幕”；平台自动字幕会受口音、噪声、重叠说话等影响。[自动字幕说明](https://support.google.com/youtube/answer/6373554) |
| Bilibili | 已有公开 BV/av 单视频、字幕优先 | yt-dlp 可能把 AI 轨放进 subtitles；不能只按字段名称其为人工字幕。弹幕不是字幕；登录才能取得字幕时不能判定不存在。[上游 Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py) |
| X / Twitter | 已有单视频 status 链接；不支持主页、搜索、直播、合集 | 已有时间定位和字幕导入路径；具体帖子是否有可获取媒体/字幕取决于平台响应，不能承诺所有帖子可用。[上游 Twitter extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/twitter.py) |
| 小宇宙 | 分享页直接导入尚未实现 | 官方区分托管节目与 RSS 节目，因此“在小宇宙可听”不保证有可公开取得的原 RSS。优先原发布者 RSS 或合法本地文件；节目简介/时间轴不能冒充完整文字稿。[官方主播说明](https://blog.xiaoyuzhoufm.com/podcaster-january-21-update/) |
| 喜马拉雅 | 分享页直接导入尚未实现 | yt-dlp 有提取器，但也含付费/VIP及试听处理；不能把其存在当作整集公开可用，尤其不能把试听冒充全文。[上游实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/ximalaya.py) |
| 蜻蜓 FM | 分享页直接导入尚未实现 | 上游单节目匹配 qingting.fm / qtfm.cn 的 channels/.../programs/...，只提供音频 URL，当前实现不输出时长，无法满足 Coconut 下载前已知 ≤6 小时门槛。尚未放行这个入口。[上游实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/qingting.py) |
| SoundCloud / 其他播客播放器 | 未实现专用分享链接导入 | 即使上游列有 extractor，也不代表 Coconut 已接入、所有单集可用或有字幕；优先发布者 RSS/合法文件。[yt-dlp 支持列表及免责声明](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) |

现有网络 ASR 路径要求已结束、可确认时长不超过 6 小时；本地服务上传和可选回放副本限 200 MiB。现成字幕是否可获取需独立检查。支持列表、成功下载、成功转录和逐字质量验收是四件不同的事。

## 字幕来源与语言契约

保留 schema_version=1 和已有 provenance.kind，增加可选字段：

- caption_method：platform_provided / automatic / asr / unknown。platform_provided 不能显示成“人工校对”
- caption_track：原始平台轨道标识，如 en-orig、ai-zh；document.language 保留规范化语言，如 en、zh
- language_basis：user_hint / platform_metadata / original_track / single_track / asr_detected / unknown。single_track 只是唯一可用轨，不证明语音语言已被识别
- review_status：unreviewed，表示 Coconut 未做人工逐字听校
- subtitle_check：found / no_eligible_track / skipped / not_applicable。no_eligible_track 不能显示成“原站没有字幕”
- source_platform：从已验证来源网址得出；source_medium 只在提取器有编解码证据时写 audio / video，缺失即未知

不选 live_chat / danmaku，不按字母顺序猜多个未知语言轨，不使用带 tlang 的自动翻译 URL。Bilibili ai-* 轨标为 automatic；普通 subtitles 仍只标“平台提供”。有警告却无法确定可用轨、元数据请求失败或选中字幕下载失败时，抛出明确获取错误，不回落成“没有字幕”。

## ASR 成本比较

下面按一小时输入音频折算，货币不换算；不含税、存储/网络、翻译/摘要、对齐或额外说话人功能。免费额度有期限/限制，不等于持续免费。使用前仍需重新查所选账户、地区、实际模型及费用上限，并获得音频发送和付费授权。

| 方案 | 官方计价 | 一小时音频 | 选型含义 |
| --- | --- | --- | --- |
| 本地 MLX Whisper / whisper.cpp | 无按次 API 费 | $0 提供商费用，仍占设备、电力、磁盘 | 苹果芯片优先评估，不能用他人机器速度承诺本机耗时 |
| Groq Whisper large-v3-turbo | $0.04 / 小时 | $0.04 | 低成本候选；时间戳/多语言可用，但不等于多人身份识别 |
| Groq Whisper large-v3 | $0.111 / 小时 | $0.111 | 可与 turbo 以同一真实样本比较 |
| OpenAI gpt-4o-mini-transcribe | 估算 $0.003 / 分钟 | 约 $0.18 | 以实际 token 计费为准 |
| OpenAI gpt-transcribe | $0.0045 / 分钟 | $0.27 | 当前模型支持关键词、上下文及多语言提示，可测试技术术语和混合语言 |
| OpenAI gpt-4o-transcribe | 估算 $0.006 / 分钟 | 约 $0.36 | 更贵不构成本用户材料上的质量保证 |
| Deepgram Nova-3 预录音单语言 | $0.0043 / 分钟 | $0.258 | 支持中文单语言；选择需核对功能兼容性 |
| Deepgram Nova-3 预录音 multi | $0.0052 / 分钟 | $0.312 | 官方 multi 列出的切换语言不含中文，不能按中文+英文自动切换来承诺 |
| Aliyun Qwen3 / Qwen-Audio-3.0 filetrans，北京 | ¥0.00022 / 秒 | ¥0.792 | 中文候选；需匹配北京区账户和数据处理位置 |
| 同上，新加坡 | ¥0.00026 / 秒 | ¥0.936 | 区域费用不同，不拿北京价默认覆盖所有账户 |
| Aliyun Qwen-Audio-3.1 filetrans，北京 | 输入 ¥0.8 / 百万 token、输出 ¥2.7 / 百万 token | 无法由单一小时数精确换算 | 必须先估算 token，用实际账单校核，不沿用 3.0 的秒价 |

价格来源：[Groq](https://console.groq.com/docs/speech-to-text)、[OpenAI](https://developers.openai.com/api/docs/pricing)、[当前 GPT-Transcribe 功能](https://developers.openai.com/api/docs/models/gpt-transcribe)、[Deepgram 预录音价格](https://deepgram.com/pricing)、[Deepgram 模型/语言](https://developers.deepgram.com/docs/models-languages-overview)、[阿里云模型价格及地区](https://help.aliyun.com/en/model-studio/model-pricing)。

## Mac 本地路线与效果证据

- 当前 Coconut 用 faster-whisper CPU int8 起步，其官方 GPU 路径基于 NVIDIA CUDA。不能把其 GPU 速度宣传直接套到 Apple Silicon。[faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- MLX Whisper 是面向 Apple Silicon 的候选，可读取本地或 Hugging Face 的转换模型，并支持量化。Python/ffmpeg 和模型准备仍有安装成本。[MLX 官方示例](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
- whisper.cpp 支持 Metal、Accelerate、ARM NEON，可选 Core ML；相较 Python 堆栈，更适合作为桌面程序随附的本地可执行后端。需要另做签名/打包、模型许可、安装大小和终止恢复测试。[whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Whisper 官方模型卡说明可能幻觉、重复，且语言、口音表现不一。提高模型尺寸不消除这些风险。[Whisper 模型卡](https://github.com/openai/whisper/blob/main/model-card.md)
- Qwen3-ASR 的研究报告含中英文、WenetSpeech meeting 等评估，说明它值得加入中文候选；研究团队的公开/内部基准不能直接当作本用户技术播客的独立质量证明。对齐也不等于说话人分离。[Qwen3-ASR 报告](https://arxiv.org/html/2601.21337v1)

没有找到可直接替代本任务实测、同时覆盖中文/英文技术专名、长音频、重叠多人、时间戳以及当前所有候选版本的统一独立基准。因此不宣称“某款最好”，也不先付费跑完整节目。

建议下一步先选获授权的 20–30 分钟代表样本：纯中文、纯英文、中英夹杂技术术语、多人交叠各一段，另有静音/音乐负样本。用同一人工参考稿比较中文 CER、英文 WER、术语/数字漏错、无声音幻觉、时间戳偏差、说话人错误、实际耗时和峰值内存。先评估已安装的免费后端；仅在明确授权后做按上限计费的小样本对照。摘要、翻译、标点“润色”不能用于掩盖转录错误。
