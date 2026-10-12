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


## Local subtitle byte encodings

`tests/subtitle-encoding-browser.mjs` is an Actions-only Chromium journey using authored real UTF-8, UTF-16 LE/BE BOM, GB18030, Big5, Windows-1252 and unmarked UTF-16 file bytes. It covers the native chooser for single and multiple files and same-project attachment, explicit encoding preview/reselection, native Escape, skip/stop receipts, malformed UTF-16, late byte-read ownership, IndexedDB quota rescue/retry, actual JSON download into a clean browser, and reload. The recovery dialog is checked and captured at 390px and desktop widths. No workspace browser run is claimed by DOM tests; CI output identifies the exact checked revision.


## Transcript-first local media association

`tests/transcript-media-association-browser.mjs` is a CI-only native-file Chromium journey. An authored SRT is imported before its authored PCM audio, then a cue note, timing calibration and historical exact excerpt are saved. The existing source-link editor saves an authored YouTube URL with a nonstandard port, case-sensitive query and fragment; its raw value must survive first binding, IndexedDB reload, native JSON download/clean restore, replacement and unlink without opening the URL. It checks real IndexedDB reload, the explicit singleton transcript candidate, cancellation, separate audio-only creation, actual current-JSON download and clean-context restore, temporary detach, and confirmed replacement/unlink without losing text or annotations. Two native audio files have the same name, size, modification time and sampled content but differ at an unsampled byte; the chooser must still describe only a candidate, never full-content verification. The candidate dialog, bound-but-not-reselected reload, and unlinked no-media states have 390px and 1280px screenshots; chooser cancellation and confirmed navigation/unlink also verify focus returns to a visible control or title, with keyboard focus, hit-target and viewport geometry in `transcript-media-association-checks.json` under `COCONUT_UI_ARTIFACT_DIR`. Only authored images and geometry are retained; original files, media bytes, downloads and browser storage are temporary. Syntax checks do not claim browser acceptance; only the exact CI revision can establish a passed journey.


## Pasted timed transcripts

`tests/pasted-subtitles-browser.mjs` is an Actions-only Chromium journey using authored SRT and WebVTT text. It writes only its own fixture to the native clipboard, grants only clipboard-write, and pastes with the real platform keyboard shortcut; trusted paste and per-character input events are observed without mocking the clipboard or granting the application clipboard-read. Explicit preview must remain read-only. The journey covers blank and untimed input, malformed timestamps and correction, BOM/CRLF, Unicode, multiline cues, millisecond times and exact preview counts/ranges, WebVTT voices and metadata, escaped HTML, skipped-block diagnostics with bounded expansion, and invalidation when title, format or source changes.

At 390px and 1280px, it captures the preview, diagnostics, reading and failed-save states and verifies every visible dialog tab stop in both directions, including the expanded format example, minimum 44px dimensions, the complete visible focus ring, five unobstructed hit points, no horizontal overflow, native Escape and the returned opener’s focus ring/hit geometry. Failure captures include each still-open authored page. Notes and a text correction are saved, downloaded as actual complete JSON including long cues beyond the three-cue preview, restored through the native file picker into an empty browser context, and verified after a real IndexedDB reload. Repeated imports must reuse the original key without discarding annotations.

A test-only delay wraps the production IndexedDB adapter and releases into its real transaction; it does not fabricate a successful save receipt. Native quota failure verifies retained drafts, explicit in-page reading, complete rescue download, clean restore and retry. Late saves after an input edit, Close, Escape, a newer file import or return to the previous reader must not take over navigation or erase a newer draft. Artifacts contain only authored screenshots and `pasted-subtitles-checks.json` geometry/check results. Clipboard fixtures, exports and browser storage remain temporary. No workspace Chromium/Electron run or API/model call is part of this change; syntax and structural checks are not browser acceptance. Only Actions success at the exact checked revision establishes this journey.


## Wide library search workspace

`tests/wide-library-search-browser.mjs` is an Actions-only authored journey covering a native search dialog at 1360px and 390px, plus 650/651px breakpoint crossings. It restores 81 authored documents through the native chooser, checks the actual source/translation text measure (at least 640px desktop and 320px at 390px), verifies one original query/result tree and one result scrollport, walks Tab and Shift+Tab with 44px targets, the complete focus ring and five unobstructed hit points, and compares native Chromium CDP composition with an isolated plain search input in the same browser. The complete ordered start/update/end and beforeinput/input traces, data, trust flags, identity, focus, caret and browser version are saved even on failure. Start/update/input provenance must be trusted, the end event must match the native baseline exactly, and neither trace may use hand-dispatched composition or input events. This avoids assuming that the engine assigns the same trust flag to every event type while retaining a strict native-input proof. Query, scope, full 40-document pagination, per-language fifth matches, latest cancelled page/focus, scroll and historical notebook detours are exercised through real controls. Paused authored media and reader state remain unchanged by search/cancel; cross-document selection retains the established pause contract without seeking or playing. A held continuation checks production long-hit verification cancellation; real IndexedDB quota failure/retry and the production save barrier must show recovery inside the modal. Only authored screenshots and geometry/check JSON enter artifacts. This workspace runs syntax and DOM checks only; no local browser, Electron, user Mac or model call is claimed. Final Actions success at the exact revision is required.

## Saved reading display languages

`tests/reading-display-browser.mjs` is an Actions-only native Chromium journey at 1360, 390 and 320px. The one reader-owned select is reached without opening AI settings and changed with a real native popup and keyboard. Seven saved languages, fallback/source-only/reload, later passage and cue pages, long/short translation reflow, source-cue viewport offset, search/context return, trusted IME, TXT/SRT/VTT/single-note downloads and unchanged source/bookmark/history are checked. Native audio decoding verifies the same player, time, rate, paused state and active follow across pointer/keyboard language selection; a subsequent real wheel must still suspend follow. Geometry checks cover 44px, the full focus ring, five clear hit points, visible labels, no horizontal overflow, compact layout and focused resize. Dark screenshots use existing theme tokens. Only authored screenshots and the checks JSON are artifacts. No local browser/Electron, user machine, model or remote publication is implied by syntax/CPU tests; exact-revision Actions must pass before this native journey is claimed.
