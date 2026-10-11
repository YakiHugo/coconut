# 双语精确摘录

在同一个原文段落窗口内分别选择原文和已保存译文的连续字符范围，再明确确认语义对应。确认不是自动逐字对齐、翻译正确性认证或译文人工核对。不会调用模型，也不会修改来源译文；缺译时使用原有译文编辑入口。

## 选择与保存

原文保留既有精确摘录的完整 cue 窗口证据。译文可跨同一窗口内不同数量的 cue；不能来自另一篇或窗口之外。缺失、空白、过期译文会断开可选连续译区，不用空串跳过，也不阻塞其他有效译区。选择一个译区后独立选择字符，不按原文长度比例推算。

偏移使用 UTF-16。创建检查 Unicode 字素边界，禁止截断表情、组合文字或 CRLF。JSON 严格验证片段拼接、偏移、选中文字、语言与来源，未知字段和矛盾证据使整个记录拒绝，不静默删改。

保存前重新检查文档、原 cue 与译文对象所有权及来源内容和直接依据。并发编辑或替换会拒绝旧选区；草稿应保留供重新选择。成功仍须等待现有保存队列的持久化回执。

## v2 历史模型

exact_excerpts 同时接受旧 v1 原文记录和 v2 双语记录。v2 保持原 text/snapshot 意义，增加 translation 和 pairing：

- translation 包含语言、独立选中文字、连续译 cue 证据、分隔符和 from/to。
- 每个译 cue 保存 cue_id、当时完整规范化 translation 对象、当前译文直接引用的 context 或 null，以及当时相关术语 glossary。
- pairing 固定为 user-confirmed-correspondence，并记录 confirmed_at。

所有快照深复制并冻结。个人笔记继续放在 exact_excerpt_notes 侧栏，不改写引文。提供商、已有人工核对、用户自写和质量提示保持原义；配对不创建 manual_review。译文生成时间没有可靠记录时 sourceTime 明确为 null，配对确认时间不当作生成时间。

这是当时已存译文及直接依据，不是完整翻译修订历史，也不保证递归重放整个翻译过程。context:null 不会以后从当前稿补齐。有限 original_translation / manual_review.previous_text 可保留，但 original_translation 的外围上下文并未完整归档。

选区出处摘要只汇总实际触及的译 cue，未选中的人工核对、自写或质量提示不会混入所选文字的状态。完整译区仍可作为上下文证据保存。

去重同时比较原 snapshot 和完整 translation，包括语言、两边范围、内容与证据；不比较 ID、创建或确认时间。不同译区或依据不合并，v1 与 v2 也不合并。

历史状态比较内容与当前翻译依据，不依赖恢复前后的对象身份。来源、译文、术语或上下文变化会标记过期而不改历史。缺失 cue 明示不可定位；当前原文导航继续采用同序连续 cue 规则，不猜相似文本。

## 找回、成果集与导出

书架历史搜索和笔记本筛选支持选中译文，明确标记“摘录时译文”，不冒充当前原话。成果集完整嵌入 v2 及独立笔记，移除源稿后保留证据。Markdown 导出两侧选中文字、语言、提供商与状态，并说明配对不等于核对；不会额外导出未选中译文。单稿 JSON、整库/所选备份及成果集 JSON 完整保留记录，Markdown 不是恢复格式。

## 旧版本

0.7.6 的严格 v1 校验拒绝 v2，包括嵌入成果集的 v2。旧 JSON 导入/书架恢复会拒绝，同一浏览器 legacy 或 IndexedDB 启动也可能因一条 v2 而拒绝整个书架。

实际 0.7.6 模块探针验证失败保留原数据，支持版本可重新打开完整记录。这不代表降级兼容。升级前备份整个书架并确认文件落盘，保留未经旧版处理的 JSON；用支持 v2 的版本打开和恢复。不要清空数据让旧版启动。没有新数据库、服务或书架备份协议。

## 核心接口

- translationSelectionModels(doc,cues,language)：连续可用译区，包含只读 text/cues/separators/language/start/end、providers/reviewStates/qualityWarnings/sourceTime 与内部不可伪造所有权。
- translationSelectionInfo(model,from,to)：仅选区触及 cue 的出处摘要，用于保存前预览。
- pairedExactExcerptSnapshot(doc,cues,separators,from,to,model,translationFrom,translationTo,{id,createdAt,confirmedAt})：创建 v2。
- exactExcerptTranslation(record)：选中译文和出处概览；v1 返回 null。
- exactExcerptTranslationParts(record)：所选译文触及的 cue/from/to；v1 返回空数组。
- 原文、笔记、移除与成果集接口保持既有行为。
