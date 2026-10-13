# 本机持久摘要任务：第一阶段 API 基础

本阶段提供可调用、可查询的本机后台摘要 API 和独立客户端 helper，**尚未接入阅读器的提交、进度或结果接收 UI**。不能把本阶段描述为“用户已经能在手机上提交摘要”，也没有完成手机、浏览器端到端或真实订阅模型验收。

仍复用 Node 轻量 bridge、`reader/summary.js` 的全文分批和引用校验，以及现有 `providers.ask` 官方 CLI 适配。Python `ImportJobs`、前台问答、翻译、原有停止语义均不迁移。独立阅读、笔记和搜索不需要任务执行器；任务存储异常也不会阻止本机阅读页面和原有前台接口启动。

## 明确的执行边界

- 原 `/api/ask` 属于前台请求，HTTP 连接关闭会终止其 request signal。阅读器现有分批停止流程不变。
- 新 `/api/v1/tasks` 是明确提交后台摘要：完整请求验证并持久化之后才确认接收。随后页面关闭、网络断开或取消客户端 fetch，不表示取消任务。
- 只有显式 `POST .../cancel` 请求取消任务。退出执行器、应用被终止或电脑离线不是用户取消，也不会触发自动重做。
- 当前只监听 `127.0.0.1`。现有 Host、Origin、Fetch-Site、JSON、CSP 边界保留；没有对 localhost 开放远程访问、relay、配对、凭据或云端执行器。
- 实际模型调用仍使用本机已登录的 Codex / Claude Code 订阅，不能推断模型在本机 GPU 上运行。账户可用性及剩余额度不会因 task API 就绪而得到验证。
- 仅任务队列内部串行执行；它与原前台请求共用原 provider 排他约束。遇到正在使用的 provider 会失败并保留状态，不偷偷重试或额外消费额度。

源码 CLI `node desktop/server.mjs` 在当前用户 `~/.coconut/tasks` 保存任务；原生应用使用 `app.getPath('userData')/tasks`。两者是独立目录。程序调用 `startBridge` 需要显式 `taskDirectory` 才启用任务，测试使用临时目录。只探测健康、能力或读取任务不启动模型；此阶段客户端 helper 不被现有 UI 自动加载。

## v1 接口

这是第一个有版本标识的窄接口，后续扩展不应让客户端依赖额外未知字段。协议版本与磁盘格式版本分开；当前两者都是 1。

- `GET /api/v1/executor`：`protocolVersion`、执行器类型和在线状态、`supportedTaskKinds`、`enabled`、队列限制和取消/重启语义。提供商分别声明 `supported: true`、`availability: "not_checked"`，不把支持与已登录可执行混为一谈。当前 `remoteSubmission: false`。
- `POST /api/v1/tasks`：新任务返回 202 和 `{protocolVersion, created: true, task}`；重复提交相同意图返回 200、原 taskId 和当前状态。
- `GET /api/v1/tasks`：有界任务元数据列表，不附全文或结果正文。
- `GET /api/v1/tasks?submissionKey=...`：按原幂等键查找；任务不存在时 `task: null`。用于 taskId 回执丢失后的确认。
- `GET /api/v1/tasks/{taskId}`：任务状态、进度和成功结果，完成结果含完整原文快照和引用。
- `POST /api/v1/tasks/{taskId}/cancel`：请求体 `{ "protocolVersion": 1 }`。排队任务直接取消；运行中任务先保存 `cancel_requested`，再触发 provider abort。取消请求重复发送不会产生新执行。

提交结构：

```json
{
  "protocolVersion": 1,
  "kind": "summary",
  "idempotencyKey": "one-explicit-user-intent",
  "document": { "key": "document-key", "revision": "document-lifetime-and-input-revision" },
  "provider": "codex",
  "consent": true,
  "segments": [{ "id": "cue-1", "text": "完整原文……" }]
}
```

`consent` 必须来自对这个后台执行意图的明确确认，不能沿用现有前台按钮的同意。接 UI 时仍需展示全文范围、分批数、所选提供商、最多请求次数、订阅额度与离页后继续执行的说明；`Summary.notice` 可提供已有范围/成本基础，但其前台停止描述需要由后台专用文案准确替换。

客户端应先可靠保存幂等键、文稿 lifetime/revision 与提交输入，再发送。超时、网络错误或 5xx 可能发生在接收已经落盘之后，先按原 key 查询，不要生成新 key 重做。找不到时，只能重发原 key 和原 payload；后到的原请求仍会被同一个 key 去重。相同 key 配不同 revision、provider 或原文返回 409。API 不自动重试任何模型请求。

每个新意图有稳定 `taskId` 和单个 `attemptId`。当前没有 retry/resume 接口，也不会在重启时增加 attempt。若用户在核查中断/失败后决定重新执行，需要新明确意图和新 key，可能再次消耗额度。

## 状态与持久化

状态：`queued → running → succeeded / failed`。显式取消为 `queued → cancelled` 或 `running → cancel_requested → cancelled`。

取消回执区分接受请求与执行收尾：运行中返回 `cancellation.executionSettled: false`；provider 的 promise 收尾后记为 true。取消之后无论 provider 迟到返回成功或失败，都不再接收其结果。`cancelled` 表示此任务不再接收结果，不保证外部提供商没有已完成请求或已消耗额度。

- 每次提交、开始执行、批次进度、终态和取消请求都通过串行队列写入临时文件，fsync 后原子替换 manifest，再同步目录；成功写入后才确认接收或继续下一批。
- task 状态与客户端连接独立。进程内取消信号只归执行器拥有。
- 启动读取遇到 `queued` 或 `running`，统一转成 `interrupted`；上次可能已经发送的请求结果/额度未知，绝不自动重新发起。`cancel_requested` 恢复为取消终态，保留执行结果未知说明。已经完成的结果保持可查询。
- 写入失败使任务子系统停止接收/执行并 abort 当前信号；不声称结果已保存。损坏、不支持版本或超过上限的 manifest 不覆盖、不推理，任务能力降级为不可用，阅读仍可使用。
- 目录内仅允许一个在线 writer。进程锁保存 PID 和随机 token；确认原 PID 已退出后才恢复。死锁恢复步骤本身的异常/残留恢复锁会保守阻止恢复，需人工检查，不冒险启动第二个 writer。PID 被复用可能导致保守拒绝。
- 文件以 0600 创建，目录新建为 0700；明文存储在用户自己的磁盘，不是加密保险库。最多 128 条任务、8 条未结束任务、32 MiB manifest；每条活动任务按不可变输入之外另保留 1 MiB 终态/结果预算，接收前检查全部活动任务的预算，防止接收成功后因状态增长、取消或最终摘要而无法落盘；不静默删除旧任务或幂等记录，满额时拒绝新提交。尚无清理 UI/接口。
- 每条任务只持久一份原文快照、文稿 key/revision、provider、摘要意图 digest、状态/时间/进度及最终结果。不保存阅读笔记、音视频、文件路径、账号凭据。中间批次摘要仅在内存中供同一轮汇总；重启后不复用中间结果，不继续消费。

批次数与内容上限直接复用 `Summary.plan`：最多 20,000 段、1,000,000 字符、64 个原文批次加 1 次汇总。新任务 HTTP body 上限 8 MiB，原前台 API 仍保留 1 MiB 上限。计划及最终引用必须通过现有摘要校验。

## 客户端与文稿隔离

`reader/task-client.js` 提供 `submission`、`createClient` 和纯函数 `resultFor`。它没有轮询、重试、写入书架、取消前台或自动发起请求的副作用。测试中的新 client 模拟刷新后重连。

`resultFor(task, document, revision)` 只在成功结果的文稿 key、lifetime/revision、完整 cue ID/原文顺序和文本都一致时返回一个结果副本，否则返回 null。它从不改写文稿。将来 UI 接受结果还必须走现有存储回执流程，在写入提交时再次检查 owner/revision；本片不宣称已经实现了 UI 结果合并。相同 key 被移除后重新导入是新 lifetime，不能复用旧 revision。

## 验证与未验证

定向测试：

```sh
node --test tests/desktop-tasks.test.mjs tests/desktop-task-api.test.mjs tests/desktop-server.test.mjs
```

覆盖原摘要单批/多批真实流程，所有 provider 为假实现：先持久化回执、并发重复提交、冲突输入、回执丢失、连接关闭、刷新查询、显式取消和迟到结果、排队取消、完整结果恢复、真实测试子进程 SIGKILL 后恢复、单 writer、损坏记录、写入失败、最小快照/权限、revision 和原文防串写、存储异常不阻断阅读、显式打包 reader 资源路径、原前台连接取消和同源限制。

这些是本地 CPU/HTTP 合同验证。未进行实际手机远程提交、浏览器交互验收、原生 macOS 打包运行或真实 CLI/模型额度验证。
