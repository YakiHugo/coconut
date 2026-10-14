# 开发模式获取现成字幕

`npm run dev` 默认不运行 Python。显式配置可信 Python 后，Node 开发入口可获取公开 X、YouTube、Bilibili 原语言现成字幕。这里的“就绪”表示依赖和协议可用，不保证平台允许此次公开访问。`npm run start:light` 和已发布安装包不因源码配置而改变。

## 启用和检查

已有 Python 环境需要固定版本 `yt-dlp==2026.8.19`（运行时 `2026.08.19`）和 `certifi`。Coconut 不安装、更改或自动寻找解释器。不要使用未知下载程序充当 Python，也不必安装完整 ASR requirements、ffmpeg、Whisper 或模型。

如果开发机尚无独立字幕环境，可由开发者自行创建（这些是手动命令，不会由应用运行，也不会在用户 Mac 上自动执行）：

```sh
python3 -m venv .venv-captions
.venv-captions/bin/python -m pip install --no-deps yt-dlp==2026.8.19 certifi==2026.7.22
COCONUT_CAPTION_PYTHON="$PWD/.venv-captions/bin/python" npm run dev
```

或直接复用已有可信解释器的绝对路径：

```sh
COCONUT_CAPTION_PYTHON=/absolute/path/to/venv/bin/python npm run dev
```

先确认服务端口未被占用。另一个终端运行 `npm run doctor`，或查看 `GET /api/captions/status`。每个平台分别报告是否启用。未配置、依赖缺失或校验失败不会妨碍阅读；修改环境后需自行重启服务。HTTP/页面不能更改解释器或执行命令。

- `CAPTION_CONFIGURATION`：解释器不是绝对路径
- `CAPTION_START`：解释器无法启动
- `CAPTION_EXIT`：依赖探测未完成，例如缺少包
- `CAPTION_VERSION`：固定版本、TLS、协议或开发平台列表不匹配
- `CAPTION_UNAVAILABLE`：未配置可用助手

## 链接、轨道和结果

- X / Twitter：公开单视频帖子，继续使用已有受限 guest 路线。
- YouTube：单视频 watch、youtu.be、shorts 链接统一为 watch URL；只处理该视频。链接中的播放列表、时间和分享参数不跟随。
- Bilibili：直接 BV 视频链接；不跟随 b23.tv，不处理 av、合集、交互视频或指定分 P。短链可先在原站展开。多 P 返回的媒体身份不匹配时停止，不能把第一 P 冒充整个作品。
- 复用 `subtitle_import.select_track`：优先有原语言证据的现成轨道，再选未翻译自动字幕。多语言无法判定时返回 `language_required`，用户可给出语言后重试；不会任意挑一种翻译。Bilibili `ai-*` 即使位于 supplied subtitles 中，也标为 automatic。不会把弹幕作为字幕。
- `ready` 才包含经过来源、语言、时长、时间轴验证的文档。来源保留平台和媒体 ID，平台提供不等于人工校对。与现有导入相同，精确重复 cue 由共享解析逻辑处理，不猜测重复讲话是否冗余；书架去重继续使用原有文档身份规则。
- `access_restricted`：观察到登录、限流、权限、支持者付费或 token 要求。立即停止，不换身份、客户端或入口重试。
- `metadata_incomplete`：缺少必要的视频身份、访问许可状态或完成状态，暂不返回文档；不把未知状态伪装成已完成。缺少作者、分类等非必要信息不会阻止合法字幕。YouTube 接受上游明确 `not_live` / `was_live`，保留已结束直播的有效字幕。
- `network_unavailable`：网络或 TLS 连接失败；无法判断字幕是否存在。环境网络限制也可能造成此结果，不能认定平台没有字幕。
- `unavailable`：未取得可用结果，包括缺字幕、上游变化、格式或身份无法验证、预算耗尽。此状态不声称字幕不存在。
- 无自动重试。失败后可由用户重试、打开原站或导入合法获得的字幕；无任何结果会启动 ASR、模型安装、模型调用或媒体下载。

## 实现边界

新开发操作 `extract-development` 复用固定版本官方 `YoutubeIE` / `BiliBiliIE` 的元数据、轨道和格式解析，以及既有 `subtitle_import.fetch_subtitle_document`。没有重写一个平台提取器。官方实现仍可能读取播放器/视频格式元数据；读取这些元数据不下载音视频。Bilibili 官方实现会在元数据阶段获取字幕 JSON，生成内联 SRT；所有请求也受同一预算限制。

`public_video_caption_guard.py` 只注册请求平台的 extractor，限制 HTTPS 主机和路径、字幕格式、请求次数及字节数。每次连接只解析一次 DNS；任何混入的非公有/保留地址均阻止连接，直接连接已校验数值地址以防 DNS 重绑定，TLS 仍用原始主机名作 SNI 和证书校验。使用独立无 Cookie 的 urllib 传输，不跟随重定向，不继承代理或私有凭据。YouTube 仅 web 客户端，关闭 JS、远程组件、token 提供者、翻译字幕和媒体 manifests；不发送默认上游网页或 player API 的年龄/内容确认参数。字幕上的可选 TLS impersonation 标记在下载前移除，始终用同一正常 TLS 路线。HTTP/API/页面中的访问拒绝立即终止；不会在拒绝后回退。

限制：最多 32 次请求，每个元数据响应 4 MiB、字幕响应和最终文件 1 MiB、合计 24 MiB、单次网络等待 15 秒；父进程获取超时 130 秒。只接受六小时内、最多 20,000 条 cue 的完成视频。允许表可能随官方 extractor 变化而需要更新；版本固定、离线真实 extractor 合同测试和失败关闭用于让变化可见，不能证明未来平台可用率。

Node 使用绝对 Python 路径、`-I -B`、固定启动代码和独立临时 HOME/配置/缓存，不经 shell，不继承 Python 注入、令牌或外部程序搜索路径。取消和退出终止进程组并清理。整个过程是显式信任源码环境，不是 OS 沙箱。打包版仍使用自己的哈希校验与 X-only 调用契约；此改动没有发布新二进制或改变已有二进制的能力。

## 验证与证据

- `node --test tests/desktop-captions.test.mjs tests/desktop-development-captions.test.mjs`：真实 Node HTTP 与子进程，编写的协议夹具，覆盖来源、状态、SRT/VTT、取消、并发、超时和临时目录清理。
- `python -m unittest discover -s tests -p test_public_video_caption_guard.py -v`：无网络 guard 测试；安装固定 yt-dlp 后还运行真正官方 extractor，输入按上游响应结构编写的网页/API/字幕夹具。CI 的 `public-video-extractor-contract` 必须运行这部分。
- 上述成功不是公开 YouTube / Bilibili 实时成功记录，不是实测可靠率。未对用户账号、Cookie、模型或付费服务作测试。已有 X 真实路线证据见 [受限 X 验收](public-x-caption-proof.md)。

上游依据：
- [固定版官方 YouTube extractor](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/youtube/_video.py)
- [固定版官方 Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/bilibili.py)
- [官方字幕选项](https://github.com/yt-dlp/yt-dlp#subtitle-options)
- [Python isolated mode](https://docs.python.org/3/using/cmdline.html#cmdoption-I)

### 2026-10-14 真实公共请求记录

本次开发执行环境只允许特定基础设施域名，YouTube/Bilibili 不在允许列表内。各运行一次实际官方 extractor + guard 请求（没有换网络、代理、Cookie 或登录）：

- YouTube 上游字幕测试样本 `https://www.youtube.com/watch?v=QRS8MkLhQmM`：请求原语言 en；`network_unavailable`；0.112 秒；0 字节；实际字幕语言/方法未知。
- Bilibili 上游“字幕需登录”测试样本 `https://www.bilibili.com/video/BV12N4y1M7rh`：请求原语言 zh；`network_unavailable`；0.002 秒；0 字节；尚未到达字幕访问判定，不能将上游历史注释当成本次实测结果。

这两项为环境阻塞，不是无字幕结论，也不是实时可用率验收。需在允许访问原站的开发/CI 环境完成真实成功验收。已有环境可显式运行 `python scripts/probe_development_captions.py`；脚本仅输出状态、时延、语言和字节数，不打印字幕、签名下载 URL 或平台令牌。每个样本一次、最多 130 秒，退出码 0 表示两项成功，1 表示部分成功，2 表示两项都未取得字幕。Bilibili 样本本就可能要求登录，测试遇到该状态须停止，不能为了通过而绕过。
