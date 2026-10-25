# 连续阅读与本地文字稿整理

默认阅读界面按完整句子合并自然段，并在说话人切换时显示低饱和圆点与文字标签；同一人的后续段落仅显示时间戳。点击段首时间从该处持续播放并跟随原话；「回听整段」与选区回听则在范围结束时停止。未载入媒体时，可明确打开支持时间定位的原站链接。没有声纹证据时不猜测姓名；自动分组中无法确定的片段显示「未标注」。旧的阅读方式偏好仍会恢复，可通过顶部「文字稿 / 逐句校对 / 摘要」标签切换，方向键及 Home / End 也可操作，切换保留阅读位置。

段落只引用原有 cue；ID、起止时间与顺序不变。文字稿和逐句校对均连续滚动，不再按 50 个片段分页；离屏段落由浏览器延后布局，原文仍完整保留在文档中。选中文字仍通过原始 cue 和字符偏移生成精确摘录，复制、AI 选区和回听不会把段落序号当成媒体时间。选区回听以其涵盖的完整 cue 为边界，不宣称词级剪辑。TXT 使用与连续阅读相同的段落规则；SRT/VTT 仍逐 cue 导出。

## 播放、摘要与全文查找

原声载入后，底部常驻控制提供播放 / 暂停、前后 15 秒、进度拖动、倍速、当前原文定位与跟随播放；范围循环和回听返回位置收在「更多」中。所有操作共用同一个媒体元素，切换文字稿与摘要不会重新加载媒体。单纯核对摘要引用不会开始播放，明确点击「回听」才播放对应范围。正文底部与定位滚动留出播放器空间，选区工具栏位于播放器上方。

摘要和完整文字稿分别展示。点击摘要引用会切到完整文字稿，定位并聚焦对应原话；「返回摘要」回到摘要开头。引用可直接回听，核对时仍能选择原话、保存精确摘录或进入逐句笔记。「继续阅读全文」恢复进入摘要前的阅读模式、筛选与段落位置。

全文搜索默认收起，通过「查找」、正文内的 Ctrl/⌘+F 或已启用的 / 快捷键展开。输入关键词可筛选原话、当前译文与笔记，并显示匹配片段数量；Esc 或「关闭」收起搜索、清空关键词并归还焦点。摘要中呼出全文查找会切到文字稿。桌面菜单的「查找」使用同一个入口，输入法组合期间不接管 Esc。

摘要正文支持基础标题、列表和粗体。只有明确出现在正文中、且属于当前已核实引用的 `[cue-id]` 才是可点击来源；不会用关键词或时间戳猜测结论与原文的关系。摘要引用显示说话人和原文预览。过期、缺失或未核实的来源不提供当前稿跳转或回听，历史依据仍可展开连续阅读与完整导出，不以当前稿替代。阅读和核对不会触发模型请求。

阅读界面使用与发现页、书架一致的暖白底色、橄榄绿强调、细边框与文字层级，浅色和深色主题共用语义颜色。

## 本地整理模型

`transcript_readability.py` 复用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的离线 API：

- 标点：[中英 CT-Transformer int8](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/punctuation/pretrained_models.rst)，基于 FunASR 的中英标点模型。
- 声纹分组：[pyannote segmentation 3.0 与 3D-Speaker ERes2Net 的官方示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)。CPU 使用 int8 segmentation、两个线程、50% 重叠窗口；块内聚类阈值 0.8，不预设人数；块间另用 ERes2Net 声纹匹配全局人物，不直接沿用局部编号。

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

声学人物处理已移到[长音频共用流程](long-audio-pipeline.md)：每块局部分组，使用干净声纹与整份录音的全局人物注册表匹配，不拼接各块的局部编号，也不再按全文 3% 时长丢弃嘉宾。cue 被单一声音覆盖至少 60%，且次高声音覆盖不超过最高的一半时才标注。相似度含糊时保留未知；全局 ID 按首次可信出现生成，保留已有人工标签。新增的声音编号作为可校对的原始结构化标签；后续人工重命名沿用现有 `original_speaker` 历史。身份、口音、配乐、重叠说话和边界误差仍需回听核对。自动标点和自动说话人 provenance 经过项目校验、持久保存和导出，不能当作人工校对结果。

## 验证

```bash
.venv/bin/python -m unittest tests.test_transcript_readability tests.test_local_asr tests.test_transcript
node --test --test-concurrency=1 tests/reader-passages.test.cjs tests/react-reader-workspace.test.mjs tests/react-reader-summary-keyboard.test.mjs tests/react-source-playback.test.mjs
node tests/react-transcript-reading-browser.mjs
npm run check:reader-ui
```

浏览器回归使用明确标注的自写访谈，覆盖默认段落、连续完整段落、未知说话人、笔记、跨 cue 精确选区、复制、SQLite 保存与刷新恢复、手机行宽。真实访谈效果另记入公开来源验收记录；自写材料通过不代表模型质量已经人工验收。
