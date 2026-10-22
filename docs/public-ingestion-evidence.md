# Public ingestion: implementation and evidence

This document records separate capabilities, not a guarantee that every link is anonymously accessible. Development/Web is the priority; no installer was produced.

## Caption-first, then explicit local transcription

- YouTube/Bilibili: the pinned official yt-dlp extractor checks completed-video identity, access, duration and original-language tracks. Platform and automatic captions keep distinct provenance. Only a completed `no_matching_captions` result can offer the explicit media action.
- Clicking that action rechecks the same source. A newly available caption stops the media action and asks to import captions instead. Login/token/HTTP denial, incomplete metadata, network failures, ambiguous language and caption download/parse failures never become absence.
- The conservative media capability accepts one direct audio-only M4A or one narrowly verified combined MP4 from that same metadata, on a provider-specific CDN. M4A selection requires retained original-language evidence for YouTube and never chooses a lower-bitrate dub or descriptive track. Public combined video records its original/default/unknown audio role and nullable language without claiming original voice. Bilibili's unlabelled single-CID source remains language-unknown. Transport keeps pinned-public-DNS/TLS, no redirects/cookies/token providers/manifests/backup retry, a 200 MiB byte bound and a 130-second helper deadline. CDN signature URLs are transient and never enter a saved document.
- Downloaded media becomes an accurately typed browser File, with a safe bounded filename separate from the original title. The new source project stores the canonical source URL, provider/media ID, duration, caption-check evidence and complete media SHA-256. Unsupported containers are not disguised as MP3.
- Xiaoyuzhou: existing public-page gates require an explicitly FREE, non-private episode with PUBLIC media. The selected episode is revalidated when bytes are requested. Description/show notes are not treated as transcripts.
- The existing optional loopback Python executor owns one durable upload/job queue for all downloaded/local Files. Recognition requires another explicit user action and an already prepared small model. Runtime does not install dependencies, download models, contact paid ASR or use the user's credentials. The frontend retains source binding across reload, then explicitly attaches the result to the original project with notes/bookmarks preserved.

Current video fallback is deliberately narrower than upstream yt-dlp: direct M4A or narrowly verified single-object MP4 only, not every playable stream or platform format. A combined MP4 is labeled public source media, not necessarily original-language audio. YouTube combined support is restricted to the pinned WEB route's public itag18; Bilibili progressive MP4 requires one exact raw durl object, never a first fragment of a multi-part source. A failed/unsupported public route stays a clear error; users may independently provide a legally obtained local file. The explicit caption-proxy mode remains caption-only: media fallback is not advertised or executed there. Pure static hosting cannot proxy platform sources. Packaged executors do not automatically gain this development-only capability.

## Running the source app is a separate setup step

The CI results below prove this code and those public samples in the disposable runner. They do **not** install or configure an executor on a user's computer, prove that computer's network route, or make `npm run dev` transcribe automatically. No user-computer dependency/model installation or proxy/DNS change was performed by this work.

Prerequisites, prepared explicitly by the process owner:

1. Node.js 22.13+ and the repository's `npm ci` dependencies for the source development bridge.
2. For YouTube/Bilibili discovery, an explicitly selected absolute Python 3.10+ interpreter with the hash-pinned packages in `desktop/development-caption-requirements.txt`. See [development caption setup](development-captions.md). This environment is separate from ASR and needs no speech model.
3. For optional recognition, an independently prepared Python environment whose `faster_whisper`, `ctranslate2`, `av`, `tokenizers`, `huggingface_hub`, `onnxruntime` and `numpy` modules import successfully. The real proof used faster-whisper 1.2.1 and PyAV 16.1.0. A complete existing `Systran/faster-whisper-small` Hugging Face cache snapshot must contain nonempty `model.bin`, valid JSON `config.json` and `tokenizer.json`, and `vocabulary.json` or `vocabulary.txt`. The runtime resolves the ordinary Hugging Face cache (`HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE`, or `HF_HOME/hub`); it will not fetch missing files.
4. Enough resources and private durable disk space for the selected media, job database and model. The runner measurements below are evidence for that runner, not a minimum specification or a measurement of another computer. Installing dependencies or preparing a model is a separate owner-authorized operation, not part of opening a link.

Once those prerequisites already exist, start the executor and development bridge from the repository in separate terminals. The following are launch examples with placeholders, **not** commands executed on a user's computer by this PR:

```sh
# Terminal 1: already prepared ASR interpreter and an owner-chosen private data directory.
/absolute/path/to/asr-venv/bin/python serve.py --port 8081 --data-dir /absolute/private/coconut-data

# Terminal 2: already prepared caption interpreter; executor must be on this same host.
COCONUT_CAPTION_PYTHON=/absolute/path/to/caption-venv/bin/python \
COCONUT_ASR_EXECUTOR_URL=http://127.0.0.1:8081 npm run dev
```

Open the development URL printed by Node. With a playable source project, explicitly choose “检查本地识别服务”, review the returned state, confirm sending this file, then choose “生成文字稿”. This status check does not run inference. After completion, “将文字稿接入原项目” explicitly commits the result. Downloaded source bytes initially remain only in the current page; canonical project saving does not save those bytes. An acknowledged ASR upload makes the job's media durable in the configured executor.

Unconfigured behavior is intentional:
- No `COCONUT_ASR_EXECUTOR_URL`: `asr_not_configured`, with the message “尚未连接本地转写执行器”; generation stays disabled.
- A missing/unreachable/incompatible executor: `asr_executor_unavailable`, without silently starting a server or changing its address.
- Missing or broken Python imports: `missing_dependencies`; incomplete cached model: `missing_model`. Neither state installs/downloads anything or admits a new upload job.
- Existing playback and notes remain available without ASR. The server rechecks readiness before a new upload even if a previous UI check passed.
- The executor address accepts only an HTTP root on numeric `127.0.0.1`, not an arbitrary remote service. Pure static hosting has no development backend; existing packaged applications do not acquire these source-only capabilities.

Network setup is independent. `COCONUT_CAPTION_PROXY` enables the existing explicit trusted-local-proxy **caption-only** route; it disables public video media fallback before helper execution. Direct-mode CI success does not demonstrate a user's proxy or fake-IP route works, and does not authorize changing it. Access denials remain terminal; neither this setup nor ASR turns the YouTube login-blocked samples below into successful imports.

## Real sample evidence, 2026-10-20

The public GitHub Actions standard runner was checked before optional ASR preparation: 16.7 GB RAM, about 92 GB free disk, four CPUs. The official `Systran/faster-whisper-small` snapshot was explicitly prepared in a disposable directory, then the runtime used offline-only settings. No model was silently installed by Coconut.

### Xiaoyuzhou no-transcript positive

Source: https://www.xiaoyuzhoufm.com/episode/65e7c944d602439838b530aa

[Real proof run, head 242302b](https://github.com/YakiHugo/coconut/actions/runs/39473881990/job/118804702200):
- Declared duration: 92 seconds; publisher transcript count: zero.
- Actual public media: 748,842 bytes, audio/mp4, represented truthfully as M4A.
- Existing executor: faster-whisper 1.2.1, small, CPU/int8; snapshot 536b0662742c02347bc0e980a01041f333bce120.
- Actual inference and queue completion: 13.2 seconds in this runner; 16 Chinese segments, timestamps 3.28–79.7 seconds.
- One upload; frontend controller reload; original URL, title, podcast source, note and timestamp bookmark preserved; canonical SQLite save and reload passed.
- Transcript segment SHA-256: f3d07dcb7cea5939e0a1c71c56f29fe22b63b3db171bd774ca1fd3bddd0b3013.
- Full media/transcript and model weights were temporary, not published as artifacts. Transcript remains unreviewed: this is pipeline evidence, not a language-quality benchmark or a promise about long programs.

Separate [real media/playback proof](https://github.com/YakiHugo/coconut/actions/runs/39473881990/job/118804702764) downloaded an 87,157,198-byte public Xiaoyuzhou episode and checked Chromium decoding/seek. That 5,389-second episode was **not** claimed to have been transcribed.

### Bilibili no-caption spoken positive

Source: https://www.bilibili.com/video/BV1Bx411E7Hs

The pinned public extractor returned 11 formats and only the non-transcript danmaku track. A real compatibility bug was discovered: requiring combined A/V during caption inspection produced a synthetic “Requested format is not available” warning for DASH-only sources. The metadata selector now accepts an already-returned combined, audio-only or video-only format without fetching media. Actual media selection and all warning/access gates remain separate and unchanged; the regression reproduces the old warning.

[Actual spoken-source proof, head a38a197](https://github.com/YakiHugo/coconut/actions/runs/39480599283/job/118827824634):
- Complete source duration: 76.586 seconds; truthful public audio/mp4 M4A: 646,402 bytes.
- Fresh original-caption check positively completed with no matching captions before downloading.
- Offline faster-whisper small CPU/int8 generated 26 Chinese segments, 8.53–59.55 seconds; queue/inference elapsed 20.2 seconds.
- One upload, controller reload without its File, explicit attachment into the original project, preserved original source/title/media provenance/notes/bookmark and canonical SQLite reload.
- Segment SHA-256: cc45c82b27777aa4fb51b34284a461d4e87bff1ac296a841bf8a0f3c23cb1152.
- Full media/transcript were transient; this is a genuine pipeline positive, not a fixture or quality benchmark. The separate singing-practice empty result remains recorded below.

### Actual React acceptance and reload

The stronger [Bilibili browser proof](https://github.com/YakiHugo/coconut/actions/runs/39481327277/job/118830549728) and [Xiaoyuzhou browser proof](https://github.com/YakiHugo/coconut/actions/runs/39481327277/job/118830549573), at head db82da6, both passed after real offline recognition:

- A fresh Chromium session receives the actual acknowledged single-upload job journal, without retaining its browser File.
- The real React “attach transcript to original project” action commits the transcript and durable local-job binding, not a proof-specific attachment implementation.
- A page reload renders actual recognized text; original project key, URL, title, media provenance, note and bookmark remain unchanged. The saved local-job binding matches the real executor job.
- Explicitly reopening that job's media decodes successfully; playback does not start automatically and no second upload occurs.
- Only a diagnostic preview of at most 24 Unicode characters is printed. Full third-party media/transcript are not published. The speech output is readable but unreviewed; in particular, proper nouns in the Xiaoyuzhou introduction are imperfect. This is not an accuracy benchmark.

### YouTube access negative

[Observed source QRS8MkLhQmM](https://github.com/YakiHugo/coconut/actions/runs/39472797430/job/118800931493) returned `login_required` after one request/one response. No caption, media or ASR fallback was attempted. This is not evidence of absent captions or successful YouTube ingestion. No alternate clients, proxy, cookies or token service were used to evade this response.

### Bilibili transport diagnosis

The older sample BV12N4y1M7rh is an upstream subtitle-login-required test, not a suitable anonymous-positive claim. An initial canonical-path 301 was corrected by requesting the exact same BV URL with its canonical trailing slash; redirects remain prohibited. A metadata-only diagnostic then proved HTTP 200 with gzip despite an identity-encoding request. Bounded decoding is tested independently of access handling. With those transport corrections, the real sample reached five requests/five responses and explicitly returned `subtitle_login_required`; no audio was attempted. [Observed run](https://github.com/YakiHugo/coconut/actions/runs/39474535860/job/118806966556). This negative is not re-run as a positive target. Real caption/media success must still be recorded separately; neither transport correction proves platform closure.

### Independent candidate check

An independent official NASA speech sample, [p0W_cxbbTQA](https://www.youtube.com/watch?v=p0W_cxbbTQA), also returned `login_required` after one request/one response in [run 39476785545](https://github.com/YakiHugo/coconut/actions/runs/39476785545/job/118814693363). No media/ASR was attempted and it is not automatically retried.

The independent upstream Bilibili legacy MP4 sample [BV1nx411u79K](https://www.bilibili.com/video/BV1nx411u79K) completed six requests/responses and positively reached `no_matching_captions` / `no_matching_track` in [the same run](https://github.com/YakiHugo/coconut/actions/runs/39476785545/job/118814692812). The follow-through then obtained a complete 80.384-second, 9,135,704-byte public MP4 through the same fresh caption/access gates, with media SHA-256 `821aded3f3bc66813c909773e43f0d5aea7d28e3fe19f6eaa3f69e5e86e5ec5c`. The actual local ASR returned no text segments, so no transcript was attached or claimed. [Media success and empty-recognition outcome](https://github.com/YakiHugo/coconut/actions/runs/39479166537/job/118822904588). This singing-practice sample is retained as an honest empty-result negative, not a transcription positive. VAD was not disabled to manufacture a pass.

## Reproduce and distinguish test classes

- `npm run test:desktop`, `npm run test:react`, Python unittest discovery and the production browser suite exercise authored failures, identity/mismatch cases, byte limits, cancellation and durable binding. Authored fixtures are never counted as real platform results.
- `tests/react-video-audio-browser.mjs` renders the real React app/HTTP bridge at 1360 and 390 pixels. It verifies absence-only controls, no automatic download, denied recheck/cancellation/source change with no library write, and a successful authored playable M4A through the real HTTP service, File binding, browser decoder and canonical library. Playback and ASR never start automatically. The two-second sine-wave fixture is authored test data, not a platform result. The MP4 expansion waits for first-sample `loadeddata`/`HAVE_CURRENT_DATA`, not metadata alone. An authored MP4 with intact metadata and deliberately corrupted sample bytes proves that a readable duration/dimensions receipt still creates no project when decoding fails. Projects persist metadata, not media bytes: the UI explicitly says downloaded media remains in this page until an explicit durable ASR upload. Screenshots are authored UI evidence, not live source evidence.
- `scripts/live_ingestion_proof.mjs --live` uses the real short public episode, actual optional Python executor, actual frontend controller and canonical storage. It needs an explicit absolute `COCONUT_ASR_PROOF_PYTHON` and an explicitly installed Playwright Chromium; it neither installs dependencies nor downloads weights. Pass `bilibili` or `xiaoyuzhou` after `--live` for the bounded fixed public source.
- `.github/workflows/ingestion-public-proof.yml` separates explicit ephemeral model preparation from offline inference, records versions and metadata, and removes weights afterward. A public accessibility failure remains a failed/unverified live sample, not a fixture success.

## Primary upstream references considered

- [yt-dlp YouTube extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py) and [PO token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide): subtitle availability and public access are independent of media extraction. This implementation does not obtain PO tokens.
- [yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py): AI subtitle tracks and explicit subtitle-login requirements must not be confused with absent original captions.
- [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api): useful focused transcript API, not an anonymous-access guarantee or a replacement for a guarded media fallback.
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper): existing local CPU/int8 backend, PyAV decoding, lazy segment generation. Inference must actually consume segments before a pass is reported.
- [Podcasting 2.0 transcript specification](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md): prefer publisher-declared timed text; show notes are not full transcript evidence.

No paid model comparison, account setup, private subscription source, user-Mac installation or release upload is part of this proof.

## 2026-10-22 local development: complete long-interview transcription

The user-selected public interview
[BV1wgpy69Ekz](https://www.bilibili.com/video/BV1wgpy69Ekz) was verified in the
local source checkout with the explicitly configured loopback HTTP proxy. This
is a local working-tree observation, separate from the earlier CI samples.

- The normal anonymous caption path completed six requests/responses. The
  player returned `code: 0`, `need_login_subtitle: false`, and an empty subtitle
  list; yt-dlp exposed only the excluded danmaku track. Adding WBI signing and
  checking the alternate dm/view metadata did not produce an anonymous track.
- The same verified audio representation supplied standard HTTPS backup URLs
  alongside its unsupported mcdn `:8082` primary. Preselection and bounded
  same-URL Range transfer obtained the complete 84,400,350-byte M4A, duration
  10,278.328 seconds. Media SHA-256:
  `8f94caf04e28d59682170e33b904c6bb77d9b60ad3f4932bcc4cfc889c50d888`.
- The existing local executor consumed the complete file using the already
  cached small model, faster-whisper 1.2.1, CPU/int8, batch size 8, and timestamp
  decoding. No browser credentials, model download or external AI call was used.
- The durable task returned 3,749 Chinese cues, first start 0.14 seconds and last
  end 10,271.84 seconds. The actual React acceptance action committed the result
  to the original source project; a page reload read the saved transcript.
- SRT export reparsed to the same 3,749 cues with no parser diagnostics. Cue
  ordering and bounds were checked against the source duration. The original
  source URL and durable job binding were retained in the canonical project.

The result is `local_asr` / `unreviewed`, not a platform subtitle or a claim of
word-for-word accuracy. Full media, transcript, screenshot and local receipt
remain in ignored `.coconut/dev/`; no signed CDN URL or full transcript is added
to this repository. This sample does not establish universal platform access or
installed-release support for the development proxy.

### 2026-10-22：长访谈的可读文字稿（本地开发）

同一条 `BV1wgpy69Ekz` 的现有完整 ASR 结果进一步经过本地 CT-Transformer 标点恢复与 pyannote / 3D-Speaker 声纹聚类。没有重新下载或重新识别原视频音频，没有调用云端 AI。首次准备了可选 sherpa-onnx 1.13.8 和独立的标点、segmentation、embedding 模型文件；以后的处理只读取这些本地文件。

- 最终 3,749 个原始 cue 的 ID、起止时间和顺序保持不变；3,120 个 cue 增加标点或修整中文排版空格，修改前的文字保留为 `original_text`。最终逐字校验无拒收段；一次混合简繁上下文截断通过缩小上下文、重新严格校验解决。
- 自动声纹结果经支持时长筛选后显示 3 个声音编号：3,391 个 cue 带编号，358 个仍未标注。编号不代表已经核实有且只有三位真人，也不识别真实姓名。初次过细的聚类结果未采用，低支持小组没有被猜测合并进其他人。
- 连续阅读得到 1,012 个显示段落；边界参考句末标点、停顿、声音切换和长度预算，不宣称做了语义话题分段或人工编辑。页面默认连续阅读，保留逐句校对；原有偏好仍恢复。
- 通过真实 canonical SQLite 的版本校验保存回原篇目，保留笔记和原 ASR job 绑定。刷新后实际 React 页面显示新文字和标签；首段 B站时间链接为 `?t=0`。导出 SRT 重新解析仍为 3,749 段、无解析诊断。原始备份另存，新的 JSON/TXT/SRT 单独导出。
- 实际长标题访谈在 1360px 与 390px 页面检查并截图。修复了长标题使手机 grid 轨道扩宽的问题；390px 下文档宽度为 390px、正文行宽 316px。自写材料的浏览器回归另外覆盖完整段落分页、跨 cue 选区、复制、摘录保存、校对入口、刷新恢复和长标题手机布局。

本机模型 SHA-256：

| 模型 | 字节 | SHA-256 |
| --- | ---: | --- |
| CT-Transformer 中英 int8 | 75,519,198 | `65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1` |
| pyannote segmentation 3.0 int8 | 1,540,506 | `d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d` |
| 3D-Speaker ERes2Net | 39,593,761 | `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b` |

这是当前工作区单一真实来源的本地开发证据。自动标点、分组和识别措辞仍未经过全文人工校对；未修正「长毫」等疑似错词，也没有承诺所有录音的说话人分组质量。未构建或发布新的原生安装包。配置与处理边界见 [文字稿可读性](transcript-readability.md)。
