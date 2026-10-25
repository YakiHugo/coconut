# 长音频共用处理流程

`audio_pipeline.py` 统一管理本地和显式选择的云端转写后端。`transcribe.py` 的默认 CLI / 导入任务已使用该流程；模型选择和音频去向仍由现有选项明确决定，不会自动尝试付费服务。

```text
媒体 → 流式解码为本地 PCM 文件 → 带上下文的音频块
                                ├─ ASR 后端 → 块内文字 / 字词时间
                                └─ 声学后端 → 块内声音分组 / 干净声纹样本
                    全局人物注册表 ← 声纹匹配
                                ↓
                  时间还原 / 边界归属 / 重复词去除
                                ↓
                  原语文字稿＋全局人物 ID＋可回听时间
                                ↓
                        保守标点整理 / 阅读器
```

阅读语言和后续翻译与原语文字稿分开，本次不改变翻译策略，也没有替换识别模型。

## 音频与时间

- 默认每块拥有 600 秒，左右各加 5 秒上下文，实际最长 610 秒。参数是 `--chunk-seconds` / `--chunk-context`。接入有更小限制的服务时，需把拥有时长加两侧上下文一起计入其限制。
- 压缩音频通过 PyAV 流式解码到磁盘；识别和声学引擎每次只加载一块。PCM 本身约 115.2 MB/小时磁盘空间，临时 WAV 在块完成或异常退出时清理。进程被强制杀死时可能留下一个块，重试会覆盖它；完整解码文件保留在私有任务缓存。
- 引擎只返回相对该块 WAV 的秒数。管线检查有限数、顺序、块范围、字词范围后，才提交检查点；统一还原为原音频坐标。
- 有完整字词时间时，按字词中点决定唯一归属；相邻解码的时间抖动可能造成重复，只有文字相同且时间重叠至少短词时长一半的跨块词才去重，真实相邻重复保留。
- 只有段级时间时按段中点归属，跨边界段带 `boundary_status: segment_timing_only`。这不保证不同解码分段下零漏词，需要回听；原始各块结果一直保留。

## 全局人物身份

`audio_speakers.py` 不把各块的 `speaker_0` 当成身份。默认仍使用已经显式准备的 sherpa-onnx segmentation 3.0 + ERes2Net；本次没有自动下载 Community-1 或其他模型。

1. 块内先分组。提取声纹时排除不同声音重叠区，使用至少 1.5 秒的干净样本，每组最多四段、每段最多八秒；局部样本严重不一致时不建立声纹。
2. 使用整个录音生命周期的注册表，按首次可信出现生成 `speaker-0001` 等 ID。人物离开、隔很久再次出现或换语言不会清空注册表；匹配只依据声学特征。
3. 默认余弦相似度阈值 0.72，领先第二候选至少 0.08；同块多个声音争用同一个旧身份时也检查差距，不能同时强行合并。阈值是当前 ERes2Net 的保守起点，不是经完整人工标注标定的通用准确率承诺。换模型必须重新校准。
4. 接近多个旧人物、声音太短或超过人物上限时保留未知和原因，不更新声纹。只有明显不同的声音才建立新人；注册表最多 32 人，单人保留最初锚点和有限近期样本。
5. 段落只有至少 60% 被一个身份覆盖，且次高覆盖不超过最高一半时才标注。相同身份的重复时间区间先求并集，不重复计数。重叠发言和跨人物边界可保持未知。

新路径不再按全篇 3% 时长过滤嘉宾。旧 `assign_speakers` / `stabilize_speaker_labels` 函数保留供旧调用兼容，但主流程不再用它们建立长音频身份。新模型无法补偿块内分错人、同人分裂、背景声或声纹不稳定，待核对状态仍然必要。

`segments[].speaker_id` 是录音内自动声学出处，`speaker` 是可人工编辑的显示标签；人工改名保留 ID 与自动证据，不覆盖 `original_speaker` 历史。人工修改单句归属或合并显示标签，不等于重新训练或重聚类声纹。没有声学匹配时不伪造 ID，后端原编号仅按 `chunk_index:local_label` 保存为 `provider_speaker`。

## 恢复与独立阶段

- 源文件内容 SHA-256、ASR 后端身份、转写参数、切块参数与本地限制绑定缓存。变化时拒绝误用旧结果，不靠文件名复用。
- `asr-NNNNN.json` 在每块识别和格式检查通过后原子提交。后续块、人物阶段或阅读整理失败不会丢掉它。
- `voices-MODELKEY-NNNNN.json` 单独保存声纹证据，key 包含声学模型版本/权重摘要。改变人物阈值可以重放这些证据，改变人物模型也能复用 ASR，不需要重识别文字。
- 全局注册表从已完成的声纹检查点按块顺序重放，恢复后 ID 可复现；`identity-MATCHERKEY-NNNNN.json` 保存每次匹配原因和相似度。
- 同一任务目录使用排他锁，防止两进程同时重复调用服务。
- 在云端已受理但本地尚未写完检查点时，崩溃重试仍可能重复计费。提供稳定的 `request_id` 给适配器使用供应商幂等机制，不能承诺所有云服务都恰好执行一次。

声纹向量只写入本机私有任务缓存，不进入普通阅读文档或模型提示词。需要删除一份录音全部声纹时，应连同其任务缓存删除。没有新增遥测。

## 本地使用

```bash
export COCONUT_SPEAKER_SEGMENTATION_MODEL=/absolute/path/segmentation.int8.onnx
export COCONUT_SPEAKER_EMBEDDING_MODEL=/absolute/path/speaker.onnx
.venv/bin/python transcribe.py recording.m4a --local-files-only \
  --work-dir .coconut/jobs/example -o transcript.raw.md
```

ASR 模型只初始化一次并跨块复用。WhisperX 对齐模型按识别语种复用；对齐失败或部分单词缺时间时保留段级时间并记录原因。通用原语模型仍需实际检验混说；架构不会自动提升模型准确率。

分块 CLI 不再依靠 WhisperX 内部的块内人物编号。仅配置 `HF_TOKEN` 不会启用全局人物处理，会打印提示并记录 unavailable；需配置上述独立声学后端。旧 Python 单次 `transcribe(...)` 调用仍保留其 WhisperX/HF 行为。

未配置声学模型时，转写仍可完成，人物状态明确为 unavailable。只配置一份声学模型或显式配置的模型损坏时明确失败，保留已有块检查点。`--local-files-only` 仍拒绝外部 provider；不会因云端出错自动换本地，或本地出错自动上传。

## 云端适配契约

可以实现 `ASRBackend`（`cache_key`、`local_only`、`recognize(path, request_id=...)`），或使用 `JsonCommandBackend` 对接独立 SDK 进程。已完成实际子进程契约测试，但未配置/调用任何真实云端服务。

```bash
.venv/bin/python transcribe.py recording.m4a --backend json-command \
  --provider-id vendor-model-pinned-version \
  --provider-command '["/absolute/path/python","/absolute/path/provider_bridge.py"]' \
  --work-dir .coconut/jobs/cloud-example -o transcript.raw.md
```

适配器从 stdin 读取：

```json
{"schema_version":1,"audio_path":"/private/task/chunk-00000.wav","sample_rate":16000,
 "timestamp_origin":"chunk","language_hint":null,"request_id":"stable-sha256"}
```

stdout 只输出结果 JSON；SDK 日志写 stderr。格式如下，`words` 可省略，存在时须完整覆盖该段文字并使用块内字词时间：

```json
{"language":"en","segments":[{"start":1.2,"end":2.5,"text":"Hello world",
 "speaker":"speaker_0","words":[{"start":1.2,"end":1.8,"word":"Hello"},
 {"start":1.9,"end":2.5,"word":" world"}]}]}
```

API 密钥由 SDK 进程从环境读取，不写命令参数、文档或检查点。`cache_key` / provider-id 必须锁定模型版本和影响文字的配置；变更适配器内容或设置后要改版本 ID。供应商异步上传/轮询、限制、幂等和错误分类留在适配器内部，不能改变公共时间与人物协议。主任务默认不选择 provider，现有 HTTP 上传入口仍然只提交本地选项，不接受任意远程执行命令。

## 数据兼容与验证

仍使用 schema_version 1，增加可选的 `speaker_id`、`speaker_status`、`provider_speaker`、`chunk_index`、`boundary_status`、`words`；阅读器验证、持久化、JSON 备份恢复保留这些字段。原有字幕、cue ID、手工校正和摘录接口保持兼容。

```bash
.venv/bin/python -m unittest tests.test_audio_pipeline tests.test_transcript_readability tests.test_local_asr
node --test tests/reader-audio-pipeline.test.mjs tests/reader-speaker-correction.test.mjs
npm run check:reader-ui
python3 scripts/reader_assets.py --check
```

测试覆盖三小时切块计划、上下文字词归属、边界时间抖动、局部编号交换、人物消失再出现、弱/含糊声纹、并发身份冲突、低占比嘉宾、重叠覆盖、跨阶段故障恢复、真实子进程适配器和本地限制，以及 ID/时间经过阅读器保存恢复。真实长录音集成结果另放在 `.coconut/architecture-validation-2026-10-25/`；没有人工 RTTM，不报告 DER 或人物识别准确率。
