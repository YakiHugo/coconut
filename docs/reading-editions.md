# 阅读版本与来源依据

阅读产物和校对方式分开。`segments` 继续保存当前带时间的来源稿；连续文字稿按来源合段显示。编辑访谈稿有独立正文，不修改 `segments`，也不把整理后的表达当作逐字原话。

本次交付是架构第一阶段：创建人工编辑草稿、按发言组织段落、编辑正文与主题标题、来源核对、分段回听、独立摘录、续读、Markdown 导出和完整 JSON 恢复。创建草稿不调用模型，不自动删减或润色，也不根据文本猜测人物。自动编辑生成、生成任务检查点、编辑稿 AI 问答与书架全文搜索留给后续独立任务；现有 AI 和书架搜索仍明确使用来源稿。

## 数据与模块

`reader/editions.js` 是浏览器和 Node 共用的领域模块，`editions.d.ts` 提供 React 类型。它负责来源快照、发言组织、编辑版本、来源定位、版本状态及编辑稿摘录。`reader/core.js` 在正常文档校验时显式校验这个结构；不再依赖未知字段透传。浏览器脚本、HTTP 静态资源和桌面打包清单都包含该模块。

文档仍为 `schema_version: 1`，新增可选字段：

```text
reading_editions: {
  version: 1,
  snapshots: [{id, source: {language, source_url, cues}}],
  editions: [{
    id, kind: "interview", title, source_snapshot_id,
    created_at, revision, method: "manual", coverage: "full",
    media_identity?,
    blocks: [{id, heading, paragraphs, source_refs}]
  }],
  excerpts: [{
    id, edition_id, block_id, source_snapshot_id, created_at,
    from, to, text, block_text, source_refs
  }],
  position?: {edition_id, block_id}
}
```

`Turn` 由 `turns()` 构建，是发言轮次而非字幕切片。连续的同标签来源可以组成一个轮次，其内部保留多个阅读段落；未知人物不跨段推断为同一个人。停顿和来源顺序仍遵循现有 passage 边界。

首次创建只复制正文及必要来源字段，不复制笔记、译文、摘要或声纹向量。相同来源的多个阅读版本共享一份快照。来源 cue ID、顺序、时间、正文及人物变化会使旧稿成为历史版本；标题、笔记和阅读位置变化不影响来源一致性。

第一版仅支持完整、有序的来源范围，引用必须恰好覆盖来源 cue，不能重复、遗漏或重排。这个校验只证明范围和引用有效，不能证明人工整理的文字忠实、完整或事实正确。编辑和导出均标明人工整理。未来若支持精选、合并问题或重排，应引入相应的新契约。

每份文档最多12份编辑版本、30,000个来源片段、1,000条编辑稿摘录；领域文本预算及书架原有8 MiB单文档预算同时生效，超出时拒绝保存且保留已有内容，不自动清理历史。

## 选区、人物和回听

来源稿使用 `data-source-id` 和既有精确原文摘录。`captureSourceSelection` 会核对每个可见来源节点的文字，拒绝把改写后的 DOM 当成原文。

编辑稿使用独立的 `data-edition-block-id` 和 `captureEditionSelection`。第一版支持一个正文块内跨自然段的精确选择；跨块选区不创建摘录。编辑稿摘录冻结实际选中文字、正文版本及来源引用，独立于 `exact_excerpts`，后续编辑不会重写已保存的摘录。

`resolver()` 为一次渲染建立来源索引，各正文块再按引用定位。来源不连续或间隔超过两秒时返回多个音频范围，不把首尾之间所有声音当成一个来源。回听以完整 cue 为边界，不承诺编辑后文字的逐字时间对齐。

来源变化后，仍可展开历史原文；当前稿跳转及回听停用。若创建时已有原声，版本另绑定当时的媒体身份，更换原声后不播放旧映射。播放器实例留在工作区，两种稿件切换不重新加载原声。

人物标签始终来自来源快照。来源面板显示部分覆盖率、声音匹配含糊、重叠或边界、样本不足等状态。自动分组不等于真实人物姓名，也不等于人工质量验收。

## 保存与验证

草稿参与既有关闭保护与导航阻止。编辑版本按自身 revision 拒绝迟到编辑，提交仍经过原有书架 CAS 和持久回执。写入未确认时不宣称保存成功；重试确认后只收起与该提交一致的草稿，更晚输入保留。正文保存不覆盖同时保留在当前项目中的笔记、译文和不透明元数据。

```bash
node --test tests/reader-reading-editions.test.mjs tests/react-readability-status.test.mjs
node tests/react-reading-editions-browser.mjs
npm run check:reader-ui
python scripts/reader_assets.py --check
```

浏览器验收使用自写访谈、静音WAV和真实SQLite，覆盖独立编辑、保存失败与重试、两类摘录、原声实例、刷新恢复、历史来源和390/1360像素布局。不调用真实模型，也不代表真实节目的声纹或改写质量已验收。
