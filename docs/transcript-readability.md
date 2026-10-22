# 连续阅读与本地文字稿整理

默认阅读界面按完整句子合并自然段，并在说话人切换时显示编号与颜色。段首时间可回听本地原声，或明确打开原站时间链接。没有声纹证据时不猜测姓名；自动分组中无法确定的片段显示「未标注」。旧的阅读方式偏好仍会恢复，可在「阅读方式」切换「连续阅读 / 逐句校对」。

段落只引用原有 cue；ID、起止时间与顺序不变。分页在完整段落之间进行。选中文字仍通过原始 cue 和字符偏移生成精确摘录，复制、AI 选区和回听不会把段落序号当成媒体时间。选区回听以其涵盖的完整 cue 为边界，不宣称词级剪辑。TXT 使用与连续阅读相同的段落规则；SRT/VTT 仍逐 cue 导出。

## 本地整理模型

`transcript_readability.py` 复用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的离线 API：

- 标点：[中英 CT-Transformer int8](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/punctuation/pretrained_models.rst)，基于 FunASR 的中英标点模型。
- 声纹分组：[pyannote segmentation 3.0 与 3D-Speaker ERes2Net 的官方示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)。CPU 使用 int8 segmentation、两个线程、50% 重叠窗口；自动聚类阈值 0.8，不预设人数。结果超过 12 组时视为需要复核，保留原有标签而不采用这些自动编号。

这些是可选模型，必须显式准备。普通导入、就绪检查与模型推理均不下载文件、不上传音频或文字、不读取浏览器凭据。新环境未配置时仍提供原始 ASR 稿和段落展示；已配置但运行失败时保留原稿，并记录 `readability_warning`。

```bash
.venv/bin/python -m pip install -r requirements-reading.txt
# 从上述官方 release 页面准备模型，检查文件后填写绝对路径。
export COCONUT_PUNCTUATION_MODEL=/absolute/path/model.int8.onnx
export COCONUT_SPEAKER_SEGMENTATION_MODEL=/absolute/path/segmentation.int8.onnx
export COCONUT_SPEAKER_EMBEDDING_MODEL=/absolute/path/3dspeaker-eres2net.onnx
.venv/bin/python serve.py --port 8083 --data-dir .coconut/dev/asr
```

ASR 完成后自动执行已配置的整理阶段。已有文字稿可单独处理，无须再次识别整段音频：

```bash
.venv/bin/python transcript_readability.py original.json \
  --audio original.m4a -o readable.json
```

输出必须是新文件。处理在副本中完成，成功后原子写入。标点按不超过 600 个原文字元 / 90 秒的上下文处理，并在已知说话人切换或超过 2 秒间隔处分开。每个输出字符都必须能严格映射回原稿，允许增加指定标点与调整中文排版空格；发现改字、漏字或重排时缩小上下文重试，并逐字复核；最终仍不通过的单段保留原稿。已有人为标点的块保留。修改的 cue 保存 `original_text`，可在逐句校对展开「识别原文」。这不做措辞改写、事实纠错或口头禅删除。

声纹按完整音频聚类；累计时长不足已标注时长 3% 的自动小组退回未标注，不猜测合并到其他人；剩余超过 12 组时不采用自动标签。cue 被单一声音覆盖至少 60%，且次高声音覆盖不超过最高的一半时才标注。编号按首次明确出现的顺序生成，保留已有人工标签。新增的声音编号作为可校对的原始结构化标签；后续人工重命名沿用现有 `original_speaker` 历史。身份、口音、配乐、重叠说话和边界误差仍需回听核对。自动标点和自动说话人 provenance 经过项目校验、持久保存和导出，不能当作人工校对结果。

## 验证

```bash
.venv/bin/python -m unittest tests.test_transcript_readability tests.test_local_asr tests.test_transcript
node --test --test-concurrency=1 tests/reader-passages.test.cjs tests/react-reader-workspace.test.mjs tests/react-reader-summary-keyboard.test.mjs tests/react-source-playback.test.mjs
node tests/react-transcript-reading-browser.mjs
npm run check:reader-ui
```

浏览器回归使用明确标注的自写访谈，覆盖默认段落、完整段落分页、未知说话人、笔记、跨 cue 精确选区、复制、SQLite 保存与刷新恢复、手机行宽。真实访谈效果另记入公开来源验收记录；自写材料通过不代表模型质量已经人工验收。
