# 精选成果集：所选记录的独立历史快照

成果集用于把多篇中的少量摘录或个人笔记按自己的顺序整理、命名保存，并预览、导出 Markdown。它不是字幕、AI 原文或自动摘要。集合不会把未选记录、整篇个人笔记或其他篇目一并导出。

## 存储与兼容边界

成果集是 library entry 的显式新类型：`project_kind: "reading_collection"`、`collection_version: 1`。它与稿件共用已有 `documents` 仓库和 keyed identity/generation 保存机制，保留空 `segments`、空 `notes`，不能伪装成一段原话。无需修改 localStorage、IndexedDB、事务或书架备份 envelope；新版仍接受旧 `coconut-library` version 1 备份。

**这不是双向兼容。旧版不能打开含成果集的整个书架，也不能导入含成果集的备份。** 旧版或旧缓存的 reader 对零片段集合会拒绝验证，可能使整个库进入只读/不可读恢复状态。它不能被当作仅隐藏新入口的安全降级。使用支持成果集的版本重新打开；切勿清除网站数据来绕过提示。操作前保留原始 JSON 备份。旧版启动失败不得写入空库或覆盖原数据；legacy adapter 与 IDB provider 的回归验证此边界。首次创建前及备份/导出提示应告知这项限制。

普通旧稿件不增加 UUID 或其他身份字段，既有稿件去重 fingerprint 不变。创建或编辑集合仅保存集合，不改写源稿件。

## Schema 与不可变条目

集合包含稳定的 `key`、非空 `title`（最多 500 字符）以及按显示顺序排列的 `items`（最多 1,000 条）。超出限制必须报错，不截断。可以保存空集合用于后续整理。重命名、排序和移出条目保留其余条目的 ID 与内容。

每个 item 有稳定 `id`、ISO `created_at`、`origin: {documentKey,type,id}` 和独立 `snapshot`。`type` 为 `cue`、`exact-excerpt`、`project-note` 或 `bookmark`。同一集合不能重复加入同一来源记录，重复依据为三项 origin 的精确组合，不做文本相似性合并。

快照保存选取时篇名、原话、个人笔记（包括原有 CRLF）、时间范围、说话人、规范化来源元信息和当时历史状态。精确摘录额外保留完整已验证的不可变摘录快照；普通片段保留已有正文修正前记录。个人笔记明确标为个人文字，不冒充原话。集合不是源，所以不能再收集集合产生无限嵌套。

修改原稿、个人笔记、说话人、删除原记录或移除整篇，均不修改已保存的集合。JSON round trip 保留内容和条目顺序。Markdown 转义不可信正文，链接仅使用无凭据的 HTTP(S) 地址；没有媒体文件或本地路径。

## 来源展示，不猜测回源

首版保留来源 key、记录 ID、标题、时间及原站链接，但不提供当前原文跳转。key 相同不能证明恢复后的文档对象仍是原版本，文本相似更不是身份依据；冲突恢复可能生成 `-restored-N` 副本。因此只显示“选取时快照，不自动关联当前原文”；原 key 不存在时明确提示缺失。原站时间链接也明确只是字幕/书签时间，不是逐字对齐。

恢复不会为集合条目改写来源 key、重绑相似文本或根据当前原稿更新历史。集合仅单独备份也包含全部已选快照，不隐式携带整篇。冲突集合另存副本；重复恢复同一完整内容会去重。稳定身份不会因 UI 排序、重命名或源删除而重新生成。

## 消费者边界

- `validate` 集中分支验证集合，未知版本、字段、重复 ID、重复来源项及不一致精确快照均拒绝，不静默丢字段。
- `library-store` / storage-provider / IDB adapter 按 key、对象 identity、generation 捕获整个 payload；不依赖 `segments`。IDB 仅从 `project_kind` 生成 entry metadata。
- 普通书架搜索、排序、笔记来源枚举及协作搜索引擎排除集合。集合单独列在成果集入口，普通稿件计数不包含集合。
- summary readiness 拒绝集合；TXT、字幕导出拒绝集合；其 Markdown 由专属纯函数生成。
- app 的 active/selectActive、单文件导入、普通打开、删除后的 fallback、恢复、AI/翻译、媒体/播放、阅读进度等入口均须显式排除或转到成果集面板。集合不能进入媒体或模型请求。
- 整库和所选备份包含被明确选中的集合。恢复 active 只选择真实稿件或原声项目，单集合库 active 为 null。

## Core API

- `isReadingCollection(doc)`：唯一类型判断。
- `normalizeReadingCollection(doc)` / `validate(doc)`：验证、深拷贝并冻结 item；返回的集合和 items 数组供显式编辑重建。
- `createReadingCollection({key,title,items})`：构建完整合法集合。
- `collectionItemFromCapture(capture,documents,{id,createdAt})`：要求 notebook capture 仍归属于当前原对象；选取时深拷贝，不修改来源。
- `readingCollectionItemKey(item)`：精确来源去重键。
- `readingCollectionItemState(item,documents)`：仅 `historical` 或 `missing`，`doc`/`cueId` 恒为 null；不提供弱导航。
- `readingCollectionMarkdown(collection,documents)`：按 items 顺序，只导出所选历史快照及来源/个人笔记标识。

纯测试覆盖 schema、复制隔离、CRLF、历史状态、选择/顺序、单独与混合备份、重复/冲突恢复、源删除、非原文入口守卫，以及失败保存和旧版启动保护。HappyDOM 不是实际浏览器的焦点或下载证据；UI 必须另接 CI-only 的真实创建、跨篇选择、排序、预览、下载、刷新与恢复验收，不使用真实模型。

首版普通“导入文字稿”入口拒绝裸成果集对象，并提示“恢复书架备份”。成果集专属 JSON 导出使用现有 envelope `{format:"coconut-library",version:1,documents:[collection],active:null}`，所以只恢复一个集合也无需把它激活为稿件。
