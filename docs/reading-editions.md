# 阅读版本与来源依据

阅读产物和校对方式分开。`segments` 继续保存当前带时间的来源稿；连续文字稿按来源合段显示。编辑访谈稿有独立正文，不修改 `segments`，也不把整理后的表达当作逐字原话。

目前两种阅读产物共用来源层，但各自保留正文与位置。连续文字稿保留原话、时间、说话人和原文章节；编辑访谈稿支持人工创建及 AI 直接整理、主题标题、来源核对、分段回听、独立摘录、选文 AI、续读、书架检索、Markdown / TXT / 来源对照导出和完整 JSON 恢复。

自动生成是保守的有序编辑：整理口语重复、标点与自然段，保留问题、案例、论证与限定。它不进行跨主题重排、不编造采访问题、不从摘要扩写长文，也不推断未知人物。人工稿不调用模型；AI 稿始终标明待核对。

## 数据与模块

`reader/editions.js` 是浏览器和 Node 共用的领域模块，`editions.d.ts` 提供 React 类型。它负责来源快照、发言组织、编辑版本、来源定位、版本状态及编辑稿摘录。`reader/core.js` 在正常文档校验时显式校验这个结构；不再依赖未知字段透传。浏览器脚本、HTTP 静态资源和桌面打包清单都包含该模块。

文档仍为 `schema_version: 1`，新增可选字段：

```text
reading_editions: {
  version: 1,
  snapshots: [{id, source: {language, source_url, cues}}],
  editions: [{
    id, kind: "interview", title, source_snapshot_id,
    created_at, revision, method: "manual" | "model", coverage: "full",
    generation?: {task_id, provider, model?},
    media_identity?,
    blocks: [{id, heading, paragraphs, source_refs}]
  }],
  excerpts: [{
    id, edition_id, block_id, source_snapshot_id, created_at,
    from, to, text, block_text, source_refs
  }],
  jobs?: [{id, source_snapshot_id, created_at, provider, model?, binding,
           media_identity?, cancel_requested?, resume?: {key, attempt_id, input_digest}}],
  answers?: [{id, edition_id, block_id, source_snapshot_id, created_at,
              question, provider, model?, language, from, to, text, block_text,
              source_refs, answer, citations}],
  position?: {edition_id, block_id}
}
```

`Turn` 由 `turns()` 构建，是发言轮次而非字幕切片。连续的同标签来源可以组成一个轮次，其内部保留多个阅读段落；未知人物不跨段推断为同一个人。停顿和来源顺序仍遵循现有 passage 边界。

首次创建只复制正文及必要来源字段，不复制笔记、译文、摘要或声纹向量。相同来源的多个阅读版本共享一份快照。来源 cue ID、顺序、时间、正文及人物变化会使旧稿成为历史版本；标题、笔记和阅读位置变化不影响来源一致性。

目前仅支持完整、有序的来源范围，引用必须恰好覆盖来源 cue，不能重复、遗漏或重排。这个校验只证明范围和引用有效，不能证明人工或模型整理的文字忠实、完整或事实正确。界面与导出区分人工稿和 AI 稿。未来若支持精选、合并问题或重排，应引入相应的新契约。

每份文档最多12份编辑版本、24个生成任务关联、30,000个来源片段、1,000条编辑稿摘录、200条编辑稿 AI 记录；领域文本预算及书架原有8 MiB单文档预算同时生效，超出时拒绝保存且保留已有内容，不自动清理历史。

## 选区、人物和回听

来源稿使用 `data-source-id` 和既有精确原文摘录。`captureSourceSelection` 会核对每个可见来源节点的文字，拒绝把改写后的 DOM 当成原文。

编辑稿使用独立的 `data-edition-block-id` 和 `captureEditionSelection`。第一版支持一个正文块内跨自然段的精确选择；跨块选区不创建摘录。编辑稿摘录冻结实际选中文字、正文版本及来源引用，独立于 `exact_excerpts`，后续编辑不会重写已保存的摘录。

`resolver()` 为一次渲染建立来源索引，各正文块再按引用定位。来源不连续或间隔超过两秒时返回多个音频范围，不把首尾之间所有声音当成一个来源。回听以完整 cue 为边界，不承诺编辑后文字的逐字时间对齐。

来源变化后，仍可展开历史原文；当前稿跳转及回听停用。若创建时已有原声，版本另绑定当时的媒体身份，更换原声后不播放旧映射。播放器实例留在工作区，两种稿件切换不重新加载原声。

人物标签始终来自来源快照。来源面板显示部分覆盖率、声音匹配含糊、重叠或边界、样本不足等状态。自动分组不等于真实人物姓名，也不等于人工质量验收。

## 自动生成与恢复

`reader/interview.js` 定义独立于 `summary.js` 的确定性计划和验收器。请求按完整 cue 边界分批，最多64批、每批12,000正文字符/250片段，额外约束序列化大小。超长单 cue 拒绝发送，要求先拆分文稿。每批直接接收冻结原话、时间、原人物标签和声音分组 ID，生产提供商使用原生结构化输出 schema，模型只返回带 `source_refs` 的编辑段落。验收拒绝遗漏、重复、重排、跨声音合并及把未知人物合并；完成后拼接已验收正文，不再发送摘要或全篇压缩笔记。

`desktop/tasks.mjs` 按 task kind 选择计划器，复用原有单写入任务账本、串行队列、提交幂等、取消身份检查、原子检查点和显式续跑。摘要的旧计划与旧账本仍按原契约校验。编辑任务额外预留两份输出（检查点及终态）最坏序列化空间，容量不足在模型调用前拒绝。成功恢复时同时验证终态正文与检查点一致；应用重启不会自动重复消费。

`frontend/app/interview-controller.ts` 把任务关联作为项目中的预写凭证：先持久保存冻结来源、独立提交键和执行器绑定，再提交已有任务 API。刷新后只查询原键；未知结果不自动新建任务。重试先查询原提交，续跑先持久保存独立续跑键，回执丢失时查询原续跑意图。取消意图先保存；已有取消意图禁止重试和接收。所有写入经过当前项目 revision 与保存回执，绑定变化会阻止后续发送。

完整结果经再次校验后显式接收为新版本，按任务 ID 去重。任务进行中新增的笔记不会被来源快照覆盖。原稿改变时可以明确接收历史版本，界面显示历史状态并停用当前回听与跳转。任务只提交元数据和原话，不上传音视频；订阅提供商/模型和额度确认独立于人工编辑。

## 编辑稿 AI、搜索与导出

`edition-ai.tsx` 使用独立 `edited_selection` 请求，包含实际编辑正文及精确 offsets；`transcript` 只携带本段冻结原话。服务明确声明 `ask_edited_selection: 1` 才启用。提供商校验选区，提示词区分整理表达和逐字原话，回答引用只能指向提交原片段。请求、选择、正文或连接变化会终止旧前台请求。保存失败的回答保留在本页，可重试或下载救援记录；它不进入来源稿 `ai_answers`。

编辑稿 AI 记录冻结当时正文、选文、问题、语言、提供商、请求模型和引用。后续编辑不改写历史记录，展示正文一致性与来源状态。书架的“编辑访谈稿”范围独立于原文全文搜索，协作式分批扫描正文、标题、摘录与 AI 记录，结果带文档/版本/段落身份；打开前复核当前文档身份，定位对应块，不伪造 cue ID。

Markdown 和纯文本面向阅读；来源对照导出在正文后附原片段 ID、时间、人物及原话。原有 SRT/VTT 仍仅输出来源稿。JSON 备份保留生成关联、版本、原文快照、摘录和回答；老版本客户端不认识新 method 时会拒绝导入，不会悄悄降级为来源稿。

## 保存与验证

草稿参与既有关闭保护与导航阻止。编辑版本按自身 revision 拒绝迟到编辑，提交仍经过原有书架 CAS 和持久回执。写入未确认时不宣称保存成功；重试确认后只收起与该提交一致的草稿，更晚输入保留。正文保存不覆盖同时保留在当前项目中的笔记、译文和不透明元数据。

```bash
node --test tests/reader-reading-editions.test.mjs tests/reader-interview.test.mjs tests/desktop-interview-tasks.test.mjs tests/react-interview-controller.test.mjs tests/react-readability-status.test.mjs
node tests/react-reading-editions-browser.mjs
node tests/react-interview-workflow-browser.mjs
npm run check:reader-ui
python scripts/reader_assets.py --check
```

浏览器验收使用自写访谈、静音WAV和真实SQLite，覆盖独立编辑、保存失败与重试、两类摘录、原声实例、刷新恢复、历史来源和390/1360像素布局。另以自写提供商响应和真实任务账本验证生成、刷新恢复、接收、编辑稿选文 AI、书架定位与来源对照导出。不调用真实模型，也不代表真实节目的声纹或改写质量已验收。
