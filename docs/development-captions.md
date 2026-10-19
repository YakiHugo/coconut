# 开发模式获取现成字幕

`npm run dev` 默认不运行 Python。显式配置可信 Python 后，Node 开发入口可获取公开 X、YouTube、Bilibili 原语言现成字幕。这里的“就绪”表示依赖和协议可用，不保证平台允许此次公开访问。`npm run start:light` 和已发布安装包不因源码配置而改变。

## 启用和检查

已有 Python 环境必须为 **Python 3.10+**，并需要固定版本 `yt-dlp==2026.8.19`（运行时 `2026.08.19`）和 `certifi`。Coconut 不安装、更改或自动寻找解释器。不要使用未知下载程序充当 Python，也不必安装完整 ASR requirements、ffmpeg、Whisper 或模型。

如果开发机尚无独立字幕环境，可由开发者自行创建（这些是手动命令，不会由应用运行，也不会在用户 Mac 上自动执行）：

```sh
python3 --version  # 必须为 3.10+；否则用已有可信 Python 3.10+ 的绝对路径替换下面的 python3
python3 -m venv .venv-captions
.venv-captions/bin/python -m pip install --require-hashes --only-binary=:all: --no-deps -r desktop/development-caption-requirements.txt
COCONUT_CAPTION_PYTHON="$PWD/.venv-captions/bin/python" npm run dev
```

或直接复用已有可信解释器的绝对路径：

```sh
COCONUT_CAPTION_PYTHON=/absolute/path/to/venv/bin/python npm run dev
```

先确认服务端口未被占用。另一个终端运行 `npm run doctor`，或查看 `GET /api/captions/status`。每个平台分别报告是否启用。未配置、依赖缺失或校验失败不会妨碍阅读；修改环境后需自行重启服务。HTTP/页面不能更改解释器或执行命令。

- `CAPTION_PYTHON_VERSION`：指定解释器低于 Python 3.10；先选择已有可信 3.10+ 解释器并重新创建独立环境，不要在旧环境反复安装依赖。
- `CAPTION_CONFIGURATION`：解释器不是绝对路径
- `CAPTION_START`：解释器无法启动
- `CAPTION_MISSING_YT_DLP` / `CAPTION_MISSING_CERTIFI` / `CAPTION_MISSING_DEPENDENCIES`：明确缺少对应模块；仅检查显式配置的隔离解释器。请在同一解释器环境手动安装锁定依赖，不要使用系统 `pip`。
- `CAPTION_EXIT`：依赖已找到，但导入或探测未完成，例如包损坏或不兼容
- `CAPTION_VERSION`：固定版本、TLS、协议或开发平台列表不匹配
- `CAPTION_UNAVAILABLE`：未配置可用助手

开发依赖文件 `desktop/development-caption-requirements.txt` 仅包含 helper 锁文件中的 yt-dlp 和 certifi，保留 wheel 哈希，不安装打包工具或 ASR。启动终端与 doctor 会按具体状态给出下一步；版本不匹配时启动终端显示可验证的实际 yt-dlp 版本和期望版本。doctor 只读取运行中服务的快照，不会启动解释器重新探测；修复后必须手动重启服务，旧服务状态不会自行改变。模块存在不等于能够成功导入；仍须通过原有完整版本、TLS 和协议检查才会就绪。

## 显式本机代理（开发模式 YouTube / Bilibili）

部分本机代理使用 fake-IP DNS；直连模式拒绝保留地址是预期行为，不能把 `198.18.0.0/15` 当公网放行，也不能据此判断来源没有字幕。服务所有者可以明确选择现有本机 HTTP 代理：

```sh
COCONUT_CAPTION_PYTHON=/absolute/path/to/venv/bin/python \
COCONUT_CAPTION_PROXY=http://127.0.0.1:7897 npm run dev
```

这是手动启用示例，不会自动修改 macOS、VPN、系统代理或 DNS。只有确认信任该本机代理后才启用；修改后需重启服务。未设置时仍为原有直连模式。仅接受 `http://127.0.0.1:端口` 或 `http://[::1]:端口`，端口 1–65535，可带结尾 `/`；不接受用户名/密码、主机别名、远程代理、SOCKS、查询或其他路径。空字符串和错误配置失败关闭，不自动回退直连。`CAPTION_PROXY_CONFIGURATION` 表示启动配置无效。

该设置只作用于开发模式 YouTube/Bilibili 现成字幕获取，不改变 X、模型、播客或其他请求；安装包没有新增可配置代理入口。HTTP/Web/Harness 请求不能设置或覆盖代理地址。配置由启动进程固定，在隔离助手内部协议传递；不继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 或系统自动代理配置。`/api/captions/status` 仅报告 `networkMode`（`direct_public` 或 `trusted_local_proxy`）和 `proxyProviders`，不暴露代理地址。依赖就绪检查仍不发起平台/代理连接。

**信任边界：** HTTP CONNECT 只连接选定的数值回环端口，向代理提交允许的来源主机名及 443 端口，由代理处理来源 DNS/路由；Coconut 不再验证代理最终连接的 IP 是否公网。所有者因此信任该代理做正确的路由。Coconut 继续使用原始主机名进行 SNI 和 certifi TLS 证书校验，并限制来源域名、路径、视频身份、请求与字节预算。代理能观察目标主机、连接时间和流量大小；正常 TLS 隧道不会向代理明文提供 HTTPS 路径、字幕或视频 ID。不会为了连接成功添加代理证书、关闭 TLS 校验或开放任意私网 URL。

不跟随重定向、不自动更换网络路线，不传递账号 Cookie 或代理凭据。代理返回 407 时停止，不能在网页或环境变量中填密码绕过此限制。结构化诊断区分 `proxy_configuration_invalid`、`proxy_unavailable`、`proxy_auth_required`、`proxy_connect_rejected` 和 `origin_tls_failed`；均不表示来源没有字幕。CONNECT 成功不计为来源响应。平台访问拒绝仍立即停止。

离线测试 `test_caption_proxy_transport.py` 使用现有 OpenSSL 在私有临时目录生成一天有效的专用测试证书与密钥（测试结束或失败后清理），配合本机 CONNECT 服务器，验证真实隧道、SNI、证书失败、无来源 DNS、无直连回退和请求边界；不安装系统证书、不访问平台。它与固定版官方 extractor 合同测试共同运行于 CI。离线通过不代表真实平台可访问；本机启用、平台实时测试和持久化验收仍需在被授权的运行环境完成。

## 链接、轨道和结果

- X / Twitter：公开单视频帖子，继续使用已有受限 guest 路线。
- YouTube：单视频 watch、youtu.be、shorts 链接统一为 watch URL；只处理该视频。链接中的播放列表、时间和分享参数不跟随。
- Bilibili：直接 BV 视频链接，或「发现与添加」中的官方 `https://b23.tv/<字母数字>` 分享短链。不处理 av、合集、交互视频或指定分 P；重复 `p` 参数也拒绝。多 P 返回的媒体身份不匹配时停止，不能把第一 P 冒充整个作品。
- Bilibili 短链仅在字幕来源已启用时，由导入协调器使用现有公网 DNS 校验、固定 IP 与 TLS 传输展开：最多一次匿名 GET、10 秒，只接受第一个重定向直接指向可校验的 HTTPS Bilibili BV 视频。展开器不请求目标页面，不跟随跳转链，不读取 Cookie、不接受带凭据或签名的目标；目标之后由原字幕助手独立校验获取。仅支持上述精确短链格式；失败保留原链接和重试/完整 BV 链接提示，不转入 RSS 解析。短链展开不继承环境或字幕代理；如果短链直连不可达，可使用完整 BV 链接进入既有字幕网络配置。直接 `/api/captions/import` 仍只接收原有完整视频链接。
- 复用 `subtitle_import.select_track`：优先有原语言证据的现成轨道，再选未翻译自动字幕。多语言无法判定时返回 `language_required`，用户可给出语言后重试；不会任意挑一种翻译。Bilibili `ai-*` 即使位于 supplied subtitles 中，也标为 automatic。不会把弹幕作为字幕。
- `ready` 才包含经过来源、语言、时长、时间轴验证的文档。来源保留平台和媒体 ID，平台提供不等于人工校对。与现有导入相同，精确重复 cue 由共享解析逻辑处理，不猜测重复讲话是否冗余；书架去重继续使用原有文档身份规则。
- `access_restricted`：观察到登录、限流、权限、支持者付费或 token 要求。立即停止，不换身份、客户端或入口重试。
- `metadata_incomplete`：缺少必要的视频身份、访问许可状态或完成状态，暂不返回文档；不把未知状态伪装成已完成。缺少作者、分类等非必要信息不会阻止合法字幕。YouTube 接受上游明确 `not_live` / `was_live`，保留已结束直播的有效字幕。
- `network_unavailable`：网络或 TLS 连接失败；无法判断字幕是否存在。环境网络限制也可能造成此结果，不能认定平台没有字幕。
- `unavailable`：未取得可用结果，包括缺字幕、上游变化、格式或身份无法验证、预算耗尽。此状态不声称字幕不存在。
- 无自动重试。失败后可由用户重试、打开原站或导入合法获得的字幕；无任何结果会启动 ASR、模型安装、模型调用或媒体下载。

## 实现边界

新开发操作 `extract-development` 复用固定版本官方 `YoutubeIE` / `BiliBiliIE` 的元数据、轨道和格式解析，以及既有 `subtitle_import.fetch_subtitle_document`。没有重写一个平台提取器。官方实现仍可能读取播放器/视频格式元数据；读取这些元数据不下载音视频。Bilibili 官方实现会在元数据阶段获取字幕 JSON，生成内联 SRT；所有请求也受同一预算限制。

`public_video_caption_guard.py` 只注册请求平台的 extractor，限制 HTTPS 主机和路径、字幕格式、请求次数及字节数。每次连接只解析一次 DNS；任何混入的非公有/保留地址均阻止连接，直接连接已校验数值地址以防 DNS 重绑定，TLS 仍用原始主机名作 SNI 和证书校验。使用独立无 Cookie 的 urllib 传输，不跟随重定向，默认直连不继承代理或私有凭据；显式本机代理模式的不同信任边界见上节。YouTube 仅 web 客户端，关闭 JS、远程组件、token 提供者、翻译字幕和媒体 manifests；不发送默认上游网页或 player API 的年龄/内容确认参数。字幕上的可选 TLS impersonation 标记在下载前移除，始终用同一正常 TLS 路线。HTTP/API/页面中的访问拒绝立即终止；不会在拒绝后回退。

限制：最多 32 次请求，每个元数据响应 4 MiB、字幕响应和最终文件 1 MiB、合计 24 MiB、单次网络等待 15 秒；父进程获取超时 130 秒。只接受六小时内、最多 20,000 条 cue 的完成视频。允许表可能随官方 extractor 变化而需要更新；版本固定、离线真实 extractor 合同测试和失败关闭用于让变化可见，不能证明未来平台可用率。

Node 使用绝对 Python 路径、`-I -B`、固定启动代码和独立临时 HOME/配置/缓存，不经 shell，不继承 Python 注入、令牌或外部程序搜索路径。取消和退出终止进程组并清理。整个过程是显式信任源码环境，不是 OS 沙箱。新构建的打包版使用相同的公开 X / YouTube / Bilibili guard，但通过独立的原生 `extract` 契约与哈希校验运行。版本探测返回 `publicProviders`，应用只启用助手实际声明的来源；没有该字段的旧助手仍仅声明 X，不会因前端升级被当作支持新平台。安装包不接受开发代理配置，也不依赖用户安装 Python。源码修改不改变已经下载的旧安装包，必须重新构建并验收对应原生包。

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

### 双平台 HTTP 导入验收与 2026-10-18 云端记录

正式 live smoke 现可按固定样本分别通过 React 使用的真实开发桥接 HTTP `/api/v1/ingestions` 协调器、隔离助手和 Reader 文档校验运行；不会接收任意 URL，也不调用模型、读取 Cookie 或自动重试：

```sh
COCONUT_CAPTION_PYTHON=/absolute/venv/bin/python node scripts/live_caption_smoke.mjs --live youtube
COCONUT_CAPTION_PYTHON=/absolute/venv/bin/python node scripts/live_caption_smoke.mjs --live bilibili
```

省略平台时仍选择 YouTube。YouTube 的元数据回执保存为 `live-caption-report.json`，Bilibili 保存为 `live-caption-report-bilibili.json`，两者不会互相覆盖。退出码 0 只表示所选样本已取得并校验文字稿；阻塞、未知或实现失败均为 1；无显式 `--live` 或平台不受支持为 2。回执保留平台、固定样本身份、版本、状态、已净化的失败阶段/原因/请求计数；成功时仅增加 cue 数量、时间范围和内容摘要，不保存字幕正文、原始错误或带签名的 URL。

手动 GitHub Actions 工作流分别运行两个平台，任一失败不会取消另一项，每项保留独立回执。它不会因 PR、推送或定时任务自动访问平台。Bilibili 样本可能要求登录，遇到访问限制即停止，不能为了使工作流通过换身份或绕过限制。

2026-10-18，在主干 `9d3d6f9` 的云端工作区使用已存在的锁定 yt-dlp `2026.08.19` 和 certifi `2026.07.22`，实际通过 `/api/captions/import` 发起两个样本的 HTTP 导入。两者依赖就绪，均返回 `network_unavailable`，诊断为 `metadata / transport_unavailable`，各尝试 1 个请求、收到 0 个来源响应、取得 0 条 cue。当前执行环境允许的网络域名不包括两平台；未启用代理、换路由或使用账户。该证据说明连接未取得来源响应，不能说明样本无字幕或平台拒绝，也不能宣称实际链接到 React 阅读/播放/翻译端到端已通过。React 离线测试与真实公开来源成功仍分别报告。
