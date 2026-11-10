# 公开播客来源导入

本功能由 Node 轻量服务 / macOS 应用提供；不要求 Python、识别模型、账户或付费 API。纯静态阅读预览没有网络代理，仍使用合法本地文件。

## 实际入口与选择

- RSS 2.0 / Atom：读取公开源，列出最多 200 集；选择单集后才导入发布者的 VTT、SRT 或 Podcasting 2.0 时间戳 JSON
- 普通发布者网页：仅发现页面公开声明的 `rel=alternate` RSS / Atom，先选源再选一集。节目列表从不自动当成最新一集
- Apple Podcasts：使用官方公开目录的精确节目 ID 找到 `feedUrl`，再读原发布者 RSS。含单集 `i=` 时，再读取同节目最多 200 集的官方公开目录，要求 `trackId` 和 `collectionId` 都精确相同，并以发布者 GUID 或完全一致的 enclosure 地址在 RSS 中唯一匹配。成功时只显示对应单集，但不自动保存、下载或调用模型；目录失败、身份冲突、超出窗口或无法匹配时保留明确手选，不按标题、发布日期或最新一集猜测
- 小宇宙：支持官方公开节目页 / 单集页当前服务器提供的可见数据。单集必须同时明确 `status=NORMAL`、`payType=FREE`、`isPrivateMedia=false`、`media.source.mode=PUBLIC`，媒体地址与 enclosure 一致。只列出节目页当前显示的单集，不承诺完整历史节目；选择单集后保存其永久单集页，下载时从该页重新核验权限与媒体，节目页展示列表更新不会让已保存单集失效。已验证路径只提供公开音频，不宣称取得完整文字稿
- 音视频直链：只接受明确音频 / 视频 MIME 的公开文件，不接受网页、HLS/DASH、DRM 或登录内容。发现时读取响应头后关闭连接，明确点击下载才获取文件
- Spotify：不提取其音轨。请使用发布者独立公开 RSS 或合法取得的文件
- 喜马拉雅、蜻蜓、SoundCloud 等专用分享页尚未接入；不会因为上游下载器有 extractor 就声称已支持

字幕来自 RSS 的 `podcast:transcript` 精确引用。HTML / TXT 文字稿仍可列出但不自动导入，因为没有可靠时间戳；节目简介、章节时间轴、平台摘要不代替完整原文。没有可导入文字稿时明确返回需要文字稿，不静默运行 ASR。无法下载字幕与没有字幕是不同结果。

`publisher_provided` 表示发布者源提供文件，不等于创作者手写、人工听校或准确。发布者可把自动生成稿放进 RSS；本功能不能由该字段证明生成方式。保留 `review_status=unreviewed`、文件原地址、节目源、单集标识、语言和原时间戳。原站普通网页链接不伪造可定位时间的 `?t=`。

## 网络和资源边界

桌面应用、轻量入口和开发入口与独立服务使用相同的小宇宙平台网络路径：
仅对 HTTPS 的 `www.xiaoyuzhoufm.com`、`xiaoyuzhoufm.com` 和
`media.xyzcdn.net` 交由本机网络解析，不提前把 Clash / mihomo 的 Fake-IP
当成发布者内网地址拦截。原站 TLS 校验及限定平台内的 HTTPS 重定向检查仍然执行。
普通 RSS、Apple 和其他来源继续执行公网 DNS 检查与 IP 绑定；没有全局放行保留地址。
桌面和轻量入口默认直接使用本机网络，不自动发现系统 HTTP 代理。
显式的 `COCONUT_SOURCE_NETWORK` / `COCONUT_SOURCE_PROXY`（兼容
`COCONUT_CAPTION_PROXY`）同时用于小宇宙与 B 站短链；桌面从启动环境读取，
不自动读取项目 `.env`。独立服务继续按其部署配置读取来源网络。

B 站短链仅接受精确的 `https://b23.tv/<分享码>`，同样兼容 Fake-IP 并使用选定的
来源网络。请求最多 10 秒，只读取一次重定向响应；目标必须通过官方单视频 BV
链接校验，不继续抓取目标、跟随短链链条或接收网页指定的代理。

旧开发入口 `pnpm dev:bridge` 可由所有者显式设置独立播客代理
`COCONUT_PODCAST_PROXY=http://127.0.0.1:7897`
（换成已有可信本机 HTTP 代理端口），用于 Clash / mihomo Fake-IP 环境。
该通道仅覆盖 HTTPS 的 `www.xiaoyuzhoufm.com`、`xiaoyuzhoufm.com` 与
`media.xyzcdn.net`；RSS、Apple 和其他来源保持原有 DNS/IP 绑定直连。
设置由启动进程固定，浏览器请求不能指定代理；未设置时不继承系统或环境代理。
只接受无凭据的 `127.0.0.1` / `[::1]` HTTP 代理，不接受远程代理、SOCKS 或主机别名。
代理负责这些限定域名的 DNS 与路由，应用不宣称检查了代理实际连接的目标 IP。
原站 TLS 证书与主机名仍强制验证，代理失败不回退直连；重定向不能离开限定的
HTTPS 来源。原有 MIME、字节、取消、时间上限及每次下载的免费/公开检查继续执行。
这不放行 `198.18.0.0/15`，不修改系统 DNS / Clash 配置，也不启用转录。
旧开发入口未设置独立播客代理时，小宇宙也复用 `COCONUT_SOURCE_NETWORK` /
`COCONUT_SOURCE_PROXY`（兼容 `COCONUT_CAPTION_PROXY`）选择的来源网络。
独立播客代理设置仍优先，并且不能由浏览器请求修改。
播客网络仅支持 HTTP 代理；旧开发入口的视频仍可使用 SOCKS，播客请求会明确报告
不支持该代理，而不会阻止阅读器启动或静默改用直连。

- 无 Cookie、Authorization、浏览器登录态或持久凭据；代理仅使用启动时选定的配置。不绕过登录、地区、收费或 DRM 限制。显式拒绝账号密码和能识别的访问 token / CDN 签名参数链接；参数命名过滤不能证明所有地址都无秘密，用户仍只能输入公开链接。私有 RSS 暂不支持
- 仅 HTTP(S) 标准端口。通用来源每次请求及最多四跳重定向重新校验 URL / DNS；只接受公共地址，任意 DNS 结果含非公开地址就拒绝。连接绑定已检查的具体 IP，避免检查后再次解析；HTTPS 不降级到 HTTP。上述小宇宙平台网络路径由本机网络或选定的可信代理解析限定域名
- 只允许有限音频 / 视频 MIME，不按文件名推断可播放媒体。拒绝压缩 HTTP 响应，避免内容长度与解压大小不一致；内容长度和实际流式字节数都受限制
- 元数据和文字稿各最多 8 MiB，单文件媒体最多 200 MiB，最多两个并发操作。元数据请求最多 20 秒；媒体总请求最多 30 分钟，连续 30 秒未收到响应或媒体数据则停止，持续传输会重置空闲计时，不会延长总时限。取消 / 断开连接可以中止请求。浏览器播放采用下载完成后的本地 Blob，不做任意 Range 代理；失败重试重新下载，不宣称支持断点续传
- XML 禁止 DTD / 实体声明，自定义实体不展开，嵌套最多 40 层、节点最多 120000、单节点属性及有效命名空间最多各 64；命名空间继承采用共享结构；不执行网页脚本
- 时间戳稿最多 30000 段、最长 6 小时；声明超过 6 小时的媒体拒绝。缺少时长的文件只能以大小受限的回放入口使用，浏览器需要实际解码后才能确认时长，不能据此允许后续 ASR
- 刷新 RSS / 页面后重新验证所选单集和原 enclosure / transcript 地址。客户端不能用另一个网址替换媒体或文字稿
- 不自动下载媒体、订阅 RSS、持续轮询、调用模型或转录。公开源可能记录用户设备的网络地址，这是主动获取该源本身所需的网络请求

## 集成契约

三个无运行时依赖的模块必须一起打包：`desktop/podcast-sources.mjs`、`desktop/public-http.mjs`、`desktop/podcast-xml.mjs`。

`createPodcastSources()` 返回以下方法，第二个参数都接受 `{signal}`：

- `discover({url})` 返回 `kind=feed | choices | media`、标题、`feed_url`、`episodes`、可选 `feeds` / `media` 和 `warnings`；Apple 单集另有 `episode_selection.status=matched | choice_required`，成功时包含原 Apple 单集 ID、RSS 单集 ID 与匹配依据
- 单集包含 `id`（SHA-256，来源 GUID 或小宇宙 eid，不含秘密）、`title`、`source_url`、`language`、`duration`（秒或 null）、`media:[{url,type,kind,length}]`、`transcripts:[{url,type,language,supported}]`
- `importEpisode({feedUrl,episodeId,transcriptUrl?})` 重新取得来源后返回 `{status:ready,document,episode,feed_url}` 或 `{status:needs_transcription,episode,feed_url,message}`。省略 transcriptUrl 时只选与节目声明语言一致的轨；多语言不随意猜测
- `document` 使用 schema_version=1。新 `podcast_source` 保存 `feed_url`、`episode_id`、`transcript_url`、可选 `media_url` / `media_kind`；`provenance.kind=publisher_transcript`、`caption_method=publisher_provided`、`review_status=unreviewed`
- `downloadMedia({feedUrl,episodeId,mediaUrl,episodeUrl?})` 返回 `{body:Buffer,type,kind,filename}`。直链用 `{url}`；可选 `maxBytes` 只能降低200 MiB上限。旧小宇宙项目可传已保存的 `source_url` 为 `episodeUrl`，必须是官方 HTTPS 单集页且 `SHA-256(eid)` 与已有 `episodeId` 相同；RSS 不支持此覆盖。不能把未验证用户路径当文件名。需传递取消信号；服务器响应必须保留同源检查，不记录完整链接或源内容

小宇宙的 `feed_url` 是官方公开页面 URL，而非假造 RSS；`source_type=xiaoyuzhou_public_page` 区分来源。恢复旧备份不自动发出来源网络请求；备份只含项目与来源描述，不携带媒体字节。
选集结果使用永久单集页作为 `feed_url`；发现节目时仍返回当前节目页及其展示列表。
已保存旧项目不会自动改写身份，明确获取原声时才用已知永久单集页重新检查。
再次添加同一单集时，发现页按官方永久单集地址与单集标识识别旧节目页项目，
保留继续已有项目的选择，不因 `feed_url` 形式改变而自动另建副本。

### 下载与持久资源交接

播客的「载入原声」先重新核验当前单集及公开 enclosure，再下载受限的实际字节。
后台下载保存来源校验与传输层生成的安全失败原因，区分公开权限、单集/媒体身份、
总超时、空闲超时、HTTP 状态、类型、大小和传输中断；未知异常不展示原始路径、
网址或凭据，也不宣称保留了下载进度。
前端校验容器 MIME、大小、文件身份及非播放列表内容后，调用统一的
`saveSourceMedia(store, documentKey, file, signal)`，而不是把 Blob URL 当作持久资源。
保存未确认时显示「正在保存原声」，保留取消；磁盘、协议或书架身份失败会明确报错，
不会宣称原声已保存或先挂接一个刷新即失效的播放器。

保存成功后由统一资源服务挂接本机资产。重新打开同一书架时恢复的是已保存资源，
不是自动再请求发布者/CDN，也不会自动播放或转录。只有项目仍存在、文档来源与
保存时一致时才能交接；离开页面、取消、切换项目或选择了较新的本地媒体后，
迟到下载不能覆盖当前资源。
JSON 备份不包含这些本机字节，不能把“项目已备份”说成“音频也已备份”。

手动选择的 `local_session` 文件仍是本次页面的临时附件，不等于替换了持久来源。
较晚到达的下载/保存回执不能覆盖这个新选择；但若旧来源已经保存，不能把取消
误称为服务端回滚，也不会因为选择临时文件就删除已保存音频。重启仍按已保存
来源恢复，界面须明确提示这一点；新的持久来源需要正常更新项目来源身份。

### 成熟解析库评估（2026-11-02）

评估了 MIT 的 [rss-parser](https://github.com/rbren/rss-parser)：它提供
`parseString` / `parseURL`、RSS / Atom 及自定义字段，适合通用订阅摘要。
但本次已复现的缺口是下载后的媒体只存在于会话 Blob，而非 RSS 解析失败。
换解析器不能解决持久化；小宇宙公开页面也不是 RSS。

本轮不为换库而换库。以后若实际来源暴露 XML 兼容问题，可在现有受限取数之后
采用上游 `parseString`，并用同一合同测试比较结果；不能直接以其 `parseURL`
替换网络与资源边界。迁移仍须保留 namespace URI（含已验证历史别名）、
`xml:base`、多字幕及语言选择、GUID/enclosure 冲突、DTD/实体拒绝与资源上限。
该判断针对本次闭环，不表示成熟库不适用，也不承诺手写解析器永远不替换。

## 验证证据与限制

2026-10-06 的当前实现验证包括：

- 人工编写的原创协议夹具覆盖 RSS、Atom、命名空间与 xml:base、SRT/VTT/JSON、来源/语言保留、无字幕、下载失败、重复/越界时间、单集选择、Apple 单集 GUID / enclosure 唯一匹配、冲突/失败回退与取消、小宇宙免费/私有/VIP/状态变化、伪造媒体链接
- HTTP 传输注入测试覆盖 DNS 绑定、混合内外网解析、每跳重定向、IPv4 数字伪装和 IPv6 保留范围、凭据链接、长度/真实字节/MIME/压缩限制、重定向循环、DNS 取消与超时
- 实际公开 Apple 目录：Changelog 节目 ID 341623264 返回 `https://changelog.com/podcast/feed`
- 实际公开 Changelog RSS（约 6.25 MB）成功解析有界 200 集；其 HTML transcript 链接不会冒充时间戳文字稿
- 实际公开 Podcasting 2.0 RSS（约 1.73 MB）及第273集 SRT（116494字节）原样通过发现→重新核验→导入协议，得到1325段、英语、末段结束5385.039秒，保持 publisher_transcript / unreviewed。其历史 namespace URI 已按实际原发布者数据支持
- 实际小宇宙单集 `6ab0922a0916f6f8b4468234` 页面通过明确免费/公开条件，解析到 5389 秒、87157198 字节的公开 M4A；未下载整集或声称已取得文字稿

公开响应通过当前执行环境已授权的网络代理读取并原样交给新解析器；新应用的 DNS 绑定原生连接在此受限环境无法解析/连接，未声称现场完成原生公共网络全链路或用户 Mac 回放验收。网络安全测试使用注入式传输，不修改生产限制。完整页面、字幕和媒体不提交公开测试夹具，不上传 CI artifact。真实公共媒体播放需要在具备普通网络的本地应用或独立 CI 中另验。

正式使用仍取决于发布者当前响应、公开权限、设备可解码格式与网络；支持解析不等于逐字准确或每个平台全量可用。

### 持久资源闭环验收（2026-11-02）

仅数据源、不转录的独立命令：

```sh
node scripts/live_podcast_source_closure.mjs --live xiaoyuzhou
node scripts/live_podcast_source_closure.mjs --live rss
```

默认分别核查用户指定的单集 `6ae06b84c96c8942ec130784` 和 Podcasting 2.0 当前公开 RSS。
脚本使用生产来源适配器与 HTTP/SQLite/资源服务，明确下载上限 100 MiB；
保存后关闭服务，再用禁止上游来源读取的服务重启，核对原项目、媒体完整 SHA256、
HEAD 和 Range。临时书架与媒体在退出时删除，不上传源内容、字幕或音频 artifact。
失败只输出阶段及错误类别，不把断言的原文差异写入日志。

开发集成验证中，小宇宙原声为 87,039,906 字节、无可导入发布者字幕；
RSS 样本取得 1,324 段既有字幕及 65,977,986 字节原声。两者均完成持久保存和
重启完整哈希/Range 读回，恢复时上游请求为零。这次使用执行环境授权的注入式
传输，因此标记 `injected_test_transport`，不是生产默认网络已通过的证明。
CLI 与独立 GitHub workflow 不注入传输，使用 `production_default`，须另看实际结果。
这些检查均不声称浏览器播放、媒体解码、用户 Mac 验收或新转录。

`.github/workflows/podcast-source-closure.yml` 支持手动运行，也只在自身或验收脚本
变更的 PR 上自动运行；公网波动不阻塞常规离线构建。它是允许失败的独立任务，
必须查看 **live 步骤实际 outcome** 与报告，不能将整个 workflow 的绿色当作来源成功。
普通离线测试另用原创元数据、字幕和媒体字节运行同一闭环脚本，不混称公网实测。

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

## 首次从发现进入真实文字稿

「发现与添加」的第一个节目是 Podcasting 2.0，直接读取其长期公开 RSS，不固定任何单集、字幕或媒体的临时地址。点击「查看单集」，选择带时文字稿的语言/格式，再点「打开单集」进入阅读并保存到书架。文字稿保留发布者时间戳与来源，并明确标记未经人工校对。打开目录不会预取，读取文字稿不会自动下载整集音频、调用模型或生成译文。

目录不是字幕可用性的保证。TED、Lex 和其他节目都以当前单集实际声明为准；没有可导入带时稿时明确显示「暂无可导入的带时文字稿」，可选择原声项目。发布者只有 HTML/TXT 稿、请求失败与已成功导入带时稿是不同状态。单集音频下载/解码仍需用户明确打开回放，不能把存在 enclosure 或响应头成功当作播放验收。

2026-10-17 18:14 UTC 的 [独立 CI 原始日志](https://github.com/YakiHugo/coconut/actions/runs/39057192899/job/117467469383) 实际通过生产解析器与 DNS 绑定传输取得 Podcasting 2.0 的 200 集列表及一集 1456 段英语带时稿，保留 publisher_transcript / unreviewed，并完成显式刷新。该次未执行可选媒体下载/Chromium回放。云编辑环境当日原生请求在 DNS 阶段 EAI_AGAIN，不能据此推断公开源不可用，也不能声称已在该环境完成真实回放。

Live smoke 另核对同一文字稿单集的公开音频：使用既有生产 discover 的 inspectMedia 路径，GET 响应头后立即关闭连接，沿用 DNS、重定向、类型和长度限制，不依赖 HEAD 支持，不下载音频正文。回执单独注明 downloaded=false、playback_verified=false。后续发布以最终提交的 live CI 结果为准；上游不可用会明确失败，不把历史成功当作当前保证。
