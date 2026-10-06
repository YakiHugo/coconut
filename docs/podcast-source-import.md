# 公开播客来源导入

本功能由 Node 轻量服务 / macOS 应用提供；不要求 Python、识别模型、账户或付费 API。纯静态阅读预览没有网络代理，仍使用合法本地文件。

## 实际入口与选择

- RSS 2.0 / Atom：读取公开源，列出最多 200 集；选择单集后才导入发布者的 VTT、SRT 或 Podcasting 2.0 时间戳 JSON
- 普通发布者网页：仅发现页面公开声明的 `rel=alternate` RSS / Atom，先选源再选一集。节目列表从不自动当成最新一集
- Apple Podcasts：使用官方公开目录的精确节目 ID 找到 `feedUrl`，再读原发布者 RSS。含单集 `i=` 的分享链接仍要求在列表中选择对应一集；未证明单集精确匹配，不自动取最新一集
- 小宇宙：支持官方公开节目页 / 单集页当前服务器提供的可见数据。单集必须同时明确 `status=NORMAL`、`payType=FREE`、`isPrivateMedia=false`、`media.source.mode=PUBLIC`，媒体地址与 enclosure 一致。每次导入或下载重新读取页面并校验这些条件。只列出节目页当前显示的单集，不承诺完整历史节目；已验证路径只提供公开音频，不宣称取得完整文字稿
- 音视频直链：只接受明确音频 / 视频 MIME 的公开文件，不接受网页、HLS/DASH、DRM 或登录内容。发现时读取响应头后关闭连接，明确点击下载才获取文件
- Spotify：不提取其音轨。请使用发布者独立公开 RSS 或合法取得的文件
- 喜马拉雅、蜻蜓、SoundCloud 等专用分享页尚未接入；不会因为上游下载器有 extractor 就声称已支持

字幕来自 RSS 的 `podcast:transcript` 精确引用。HTML / TXT 文字稿仍可列出但不自动导入，因为没有可靠时间戳；节目简介、章节时间轴、平台摘要不代替完整原文。没有可导入文字稿时明确返回需要文字稿，不静默运行 ASR。无法下载字幕与没有字幕是不同结果。

`publisher_provided` 表示发布者源提供文件，不等于创作者手写、人工听校或准确。发布者可把自动生成稿放进 RSS；本功能不能由该字段证明生成方式。保留 `review_status=unreviewed`、文件原地址、节目源、单集标识、语言和原时间戳。原站普通网页链接不伪造可定位时间的 `?t=`。

## 网络和资源边界

- 无 Cookie、Authorization、浏览器登录态、持久凭据或代理环境继承；不绕过登录、地区、收费或 DRM 限制。显式拒绝账号密码和能识别的访问 token / CDN 签名参数链接；参数命名过滤不能证明所有地址都无秘密，用户仍只能输入公开链接。私有 RSS 暂不支持
- 仅 HTTP(S) 标准端口。每次请求及最多四跳重定向重新校验 URL / DNS；只接受公共地址，任意 DNS 结果含非公开地址就拒绝。连接绑定已检查的具体 IP，避免检查后再次解析；HTTPS 不降级到 HTTP
- 只允许有限音频 / 视频 MIME，不按文件名推断可播放媒体。拒绝压缩 HTTP 响应，避免内容长度与解压大小不一致；内容长度和实际流式字节数都受限制
- 元数据和文字稿各最多 8 MiB，单文件媒体最多 200 MiB，最多两个并发操作。元数据请求最多 20 秒，媒体最多 120 秒；取消 / 断开连接可以中止请求。浏览器播放采用下载完成后的本地 Blob，不做任意 Range 代理
- XML 禁止 DTD / 实体声明，自定义实体不展开，嵌套最多 40 层、节点最多 120000、单节点属性及有效命名空间最多各 64；命名空间继承采用共享结构；不执行网页脚本
- 时间戳稿最多 30000 段、最长 6 小时；声明超过 6 小时的媒体拒绝。缺少时长的文件只能以大小受限的回放入口使用，浏览器需要实际解码后才能确认时长，不能据此允许后续 ASR
- 刷新 RSS / 页面后重新验证所选单集和原 enclosure / transcript 地址。客户端不能用另一个网址替换媒体或文字稿
- 不自动下载媒体、订阅 RSS、持续轮询、调用模型或转录。公开源可能记录用户设备的网络地址，这是主动获取该源本身所需的网络请求

## 集成契约

三个无运行时依赖的模块必须一起打包：`desktop/podcast-sources.mjs`、`desktop/public-http.mjs`、`desktop/podcast-xml.mjs`。

`createPodcastSources()` 返回以下方法，第二个参数都接受 `{signal}`：

- `discover({url})` 返回 `kind=feed | choices | media`、标题、`feed_url`、`episodes`、可选 `feeds` / `media` 和 `warnings`
- 单集包含 `id`（SHA-256，来源 GUID 或小宇宙 eid，不含秘密）、`title`、`source_url`、`language`、`duration`（秒或 null）、`media:[{url,type,kind,length}]`、`transcripts:[{url,type,language,supported}]`
- `importEpisode({feedUrl,episodeId,transcriptUrl?})` 重新取得来源后返回 `{status:ready,document,episode,feed_url}` 或 `{status:needs_transcription,episode,feed_url,message}`。省略 transcriptUrl 时只选与节目声明语言一致的轨；多语言不随意猜测
- `document` 使用 schema_version=1。新 `podcast_source` 保存 `feed_url`、`episode_id`、`transcript_url`、可选 `media_url` / `media_kind`；`provenance.kind=publisher_transcript`、`caption_method=publisher_provided`、`review_status=unreviewed`
- `downloadMedia({feedUrl,episodeId,mediaUrl})` 返回 `{body:Buffer,type,kind,filename}`。直链用 `{url}`；可选 `maxBytes` 只能降低200 MiB上限；不能把未验证用户路径当文件名。需传递取消信号；服务器响应必须保留同源检查，不记录完整链接或源内容

小宇宙的 `feed_url` 是官方公开页面 URL，而非假造 RSS；`source_type=xiaoyuzhou_public_page` 区分来源。恢复旧备份不自动发出网络请求，媒体需要重新选择下载。

## 验证证据与限制

2026-10-06 的当前实现验证包括：

- 人工编写的原创协议夹具覆盖 RSS、Atom、命名空间与 xml:base、SRT/VTT/JSON、来源/语言保留、无字幕、下载失败、重复/越界时间、单集选择、Apple 单集选择警告、小宇宙免费/私有/VIP/状态变化、伪造媒体链接
- HTTP 传输注入测试覆盖 DNS 绑定、混合内外网解析、每跳重定向、IPv4 数字伪装和 IPv6 保留范围、凭据链接、长度/真实字节/MIME/压缩限制、重定向循环、DNS 取消与超时
- 实际公开 Apple 目录：Changelog 节目 ID 341623264 返回 `https://changelog.com/podcast/feed`
- 实际公开 Changelog RSS（约 6.25 MB）成功解析有界 200 集；其 HTML transcript 链接不会冒充时间戳文字稿
- 实际公开 Podcasting 2.0 RSS（约 1.73 MB）及第273集 SRT（116494字节）原样通过发现→重新核验→导入协议，得到1325段、英语、末段结束5385.039秒，保持 publisher_transcript / unreviewed。其历史 namespace URI 已按实际原发布者数据支持
- 实际小宇宙单集 `6ab0922a0916f6f8b4468234` 页面通过明确免费/公开条件，解析到 5389 秒、87157198 字节的公开 M4A；未下载整集或声称已取得文字稿

公开响应通过当前执行环境已授权的网络代理读取并原样交给新解析器；新应用的 DNS 绑定原生连接在此受限环境无法解析/连接，未声称现场完成原生公共网络全链路或用户 Mac 回放验收。网络安全测试使用注入式传输，不修改生产限制。完整页面、字幕和媒体不提交公开测试夹具，不上传 CI artifact。真实公共媒体播放需要在具备普通网络的本地应用或独立 CI 中另验。

正式使用仍取决于发布者当前响应、公开权限、设备可解码格式与网络；支持解析不等于逐字准确或每个平台全量可用。

### 一手依据

- [RSS enclosure](https://www.rssboard.org/rss-specification#ltenclosuregtSubelementOfLtitemgt)
- [Atom RFC 4287](https://www.rfc-editor.org/info/rfc4287/)
- [Podcasting 2.0 transcript](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md) 与 [时间戳文件格式](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/transcripts/transcripts.md)
- [Apple 官方目录接口](https://performance-partners.apple.com/search-api) 与 [核查节目](https://podcasts.apple.com/us/podcast/the-changelog-software-development-open-source/id341623264)
- [Changelog 原发布者 RSS](https://changelog.com/podcast/feed)
- [Podcasting 2.0 原发布者 RSS](https://mp3s.nashownotes.com/pc20rss.xml)
- [小宇宙公开单集](https://www.xiaoyuzhoufm.com/episode/6ab0922a0916f6f8b4468234)
- [Spotify episode API 使用边界](https://developer.spotify.com/documentation/web-api/reference/get-an-episode)


独立公共网络验收：`node tests/podcast-public-smoke.mjs` 通过生产 DNS 绑定传输实际完成 Podcasting 2.0 发现与字幕导入、Apple RSS 解析、小宇宙公开页面条件检查。任何网络/来源变化都使脚本失败，不跳过为通过。`COCONUT_LIVE_PODCAST_MEDIA=1` 额外明确下载所核查小宇宙公开音频，硬上限100 MiB，不保存或打印内容。该分支还把内存中的已下载音频放到临时回环 HTTP 服务，使用真实 Chromium 验证时长、播放时间前进和跳转定位；结束后关闭浏览器和服务，不写音频或追踪文件。需要先安装现有 Playwright 测试依赖及 Chromium。脚本只输出计数、来源类别和验证状态；下载检查与浏览器解码/回放检查分别报告。
