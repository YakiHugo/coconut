# macOS + Web：轻量阅读器与本地代理连接

核对日期：2026-10-07。本文区分已实现的功能、依赖契约验证，以及尚待真实设备验收的发布事项。

## 现在可以使用什么

- **公开 Web 阅读器**：直接导入 JSON / SRT / VTT，在浏览器内阅读、搜索、保存笔记和导出。数据留在该站点的本机浏览器存储中。它不会寻找或扫描 `localhost`，也不能启动用户电脑上的 CLI。
- **轻量本地 Web 服务**：`node desktop/server.mjs`，只有 Node.js 22+；没有 Python、pip、ffmpeg、ASR 模型或离线翻译模型依赖。它提供同一个阅读器，以及需逐次确认的本地 Codex / Claude Code 连接。
- **macOS 桌面程序源代码与打包工作流**：`desktop/` 使用 Electron 自带的 Node 运行同一轻量服务。最终 app 包不要求使用者安装 Node/Python。内置 X 字幕助手包含经核对的最小运行时；用户不需要另装 Python，这不等于应用包完全不含 Python。仓库工作流构建 arm64 / x64 的 **unsigned 开发包**；只有相应提交的 macOS 工作流通过后，才能说该提交已完成 Mac 构建。尚未签名、公证或验收为公开分发版本。
- **完整处理服务仍是可选高级模式**：现有 Python 路径负责视频下载、ASR、离线翻译。轻量版明确不开放这些接口，避免把尚未打包的重型依赖伪装为开箱即用。

“本地代理连接”使用已安装的官方 CLI。当前不自动安装 CLI，不读取/复制认证文件，不把 token 交给网页或 Coconut 云端，不代办登录，也不自动购买额度。先由用户在官方 CLI 完成其已有订阅登录，再在阅读器点击检查连接；发送前确认原文范围与订阅用量。检测到登录只代表认证模式符合要求，不代表还有可用额度。

### 本轮实现的协议

| 连接 | 已实现 | 尚未实现 |
| --- | --- | --- |
| Codex | 官方 `codex exec` 的结构化 JSONL，一次只读请求；已验证 0.159.2 本地命令选项 | 持久 App Server 会话、流式 UI、ACP 会话 |
| Claude Code | 官方 `claude --print` 结构化 JSON，订阅认证检查、工具关闭 | ACP / Agent SDK 会话 |
| 其他本地代理 | 无 | 逐个核实 ACP 与订阅认证政策后新增 |

UI / API 的 `protocol` 值是 `codex-exec-json` 或 `claude-print-json`。这些值不能显示成“ACP 已连接”。没有对任何真实用户账户发起验收用推理；模拟协议测试不能证明真实翻译质量或额度可用。

## 开发与检查

```sh
# 零 Python 的本地 Web 入口，无需 npm install
node desktop/server.mjs --port 8080

# 不调用模型或读取认证文件的单元与真实 loopback HTTP 测试
node --test tests/desktop-*.test.mjs

# 桌面开发/打包，仅贡献者需要这些工具
npm ci --prefix desktop
npm start --prefix desktop
# macOS ZIP 打包需要两个架构的已校验字幕助手构建回执，见下面链接
# CI 先分别原生构建 arm64/x64，再执行 npm run package:mac --prefix desktop
```

`.github/workflows/desktop.yml` 在 macOS 上运行真正的 Electron 启动检查，并构建两个架构的 ZIP。其附件名为 `Coconut-macOS-unsigned`；工作流只上传应用包，不上传文字稿、浏览器书架、用户 CLI 信息或媒体。源码运行成功、跨平台打包成功、原生 Mac 启动成功、签名公证成功是四个独立状态，不能互相替代。

桌面版固定使用 `http://127.0.0.1:47831`，防止每次随机端口导致浏览器书架变成另一个存储空间。端口冲突时明确停止，绝不悄悄换端口或连接现有未知服务。普通 Web、轻量本地 Web、完整 Python 服务和桌面 app 各自有独立书架；迁移请先导出备份后导入。app 退出时停止 bridge 与进行中的子进程，不建立后台服务。

## 内置公开 X 字幕

macOS 包在启动时仅校验并探测固定字幕助手版本，不请求来源、不识别或调用模型。只有完整性和版本检查通过才声明 caption_import；公开 Web 和直接运行 Node 的轻量服务保持关闭。用户粘贴支持的链接后才读取公开访客元数据与现成字幕，任何登录、限流、访问拒绝或外部下载器需求都会停止。

最小运行时的来源、固定依赖、组件许可和原生构建步骤见 [字幕助手构建说明](caption-helper-licenses.md)。应用退出会取消请求，并等待助手结束与临时目录清理；异常无法结束时有有界退出保护。

## API 能力合同

`GET /api/health` 是被动查询，不运行 CLI：

```json
{
  "local_worker": false,
  "runtime": "desktop-bridge",
  "paid_processing": false,
  "max_upload_bytes": 0,
  "capabilities": {
    "reader": true,
    "local_agents": true,
    "subscription_ask": true,
    "subscription_translation": true,
    "media_import": false,
    "local_translation": false
  }
}
```

`local_worker` 保留旧版本“完整媒体处理 worker”的语义。界面使用 `capabilities.local_agents` 识别轻量连接，使用 `media_import` 决定是否显示下载/ASR，使用 `local_translation` 决定是否提供离线模型。

- `GET /api/language-tools`：用户主动检查后检测 CLI 安装和认证类型；返回相同能力列表、`local_translation:false`、`ai.codex` / `ai.claude` 的 `ready`、`reason`、`protocol`、`auth:'subscription-only'`
- `POST /api/ask`：现有 `question/language/segments/provider/consent:true` 合同，结果必须引用发送过的原文 ID
- `POST /api/translate-subscription`：V2 的 `source/target/segments/context/glossary/memory/provider/consent:true` 合同。语义组、术语筛选、上下文原文匹配、完整有序 ID、逐段 QA 与原文快照，与 Python 版本一致
- `input_revision` 是各运行时对自己规范化输入计算的 SHA-256，不作为跨运行时的相等性保证。UI 依据原文快照与范围检查过期
- 不支持的处理请求返回 501，不安装依赖、不下载模型、不回退到付费 API

## 安全边界

Bridge 只监听 `127.0.0.1`；Host 必须为本机实际端口，Origin 必须一致，跨站 Fetch 被拒绝。所有 POST 还要求同源 Origin、JSON 与明确 consent。公开 HTTPS Web 页面不会自动连接它，不开放 CORS，不生成 bearer token，不搭建公共隧道。

主进程负责运行官方 CLI；renderer 开启 sandbox、context isolation 和 web security，禁用 Node、webview、权限请求与任意页面跳转。静态文件采用白名单，并设置 CSP。外链只允许普通 HTTP(S) 地址交给系统浏览器，拒绝 `file:` / 自定义协议。模型输入与命令行日志不写入服务器日志。

进程使用参数数组，不经过 shell；使用临时工作目录、有限输出与超时。仅传递必要环境变量，不转发 API Key、OAuth token、`CODEX_HOME`、自定义 provider 配置或代码注入变量。Codex 要求安全选项存在，强制 ChatGPT 登录、只读沙箱、关闭工具/插件/钩子/MCP/搜索与会话持久化；未知工具输出会使整次结果失效。Claude 路径关闭工具、钩子、MCP 与会话持久化。任何额度/认证/协议错误都停止，不重试推理、不换 provider、不切换 API。一次只能运行一个订阅请求。

## 参考项目及下一阶段

以下是实际核实的官方项目，不是同名猜测：

- [T3 Code / pingdotgg/t3code](https://github.com/pingdotgg/t3code)：Electron、本地 server、Web 控制面，复用用户已配置的代理。其 [Codex provider](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexProvider.ts) 启动 `codex app-server` 并完成 JSON-RPC 初始化。这支持“UI 与本地进程分层”的方向，并不意味着纯网页可以直接启动 CLI
- [Cindy / makecindy/cindy](https://github.com/makecindy/cindy)：Electron 客户端、Codex / Claude harness；README 说明按平台带入 CLI 二进制，且可跳过 Cindy 登录使用本地代理。可参考减少用户安装步骤，但不要搬入其更大的云端、移动端、IM 与多代理系统
- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)：提供 `initialize`、`thread/start`、`turn/start`、账户/额度查询等协议。优先使用子进程 stdio，而非将 WebSocket 暴露到网络。当前文档将 WebSocket 标为 experimental / unsupported。迁移前应固定版本、生成对应 schema，并验证只读能力、取消、结构结果和账户状态
- [Agent Client Protocol 传输规范](https://agentclientprotocol.com/protocol/v1/transports)：stdio 是已有标准；Streamable HTTP 仍标为草案。ACP 是客户端与代理的会话协议，不是订阅授权本身
- [当前 Codex ACP 适配器](https://github.com/agentclientprotocol/codex-acp)：启动 Codex App Server 并翻译 ACP 事件，支持多种认证。不能把“支持 ACP”当成“只使用订阅”保证；Coconut 仍必须限制认证模式。旧 [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) 已归档并指向新仓库

最小后续路线是保留此 reader 与 bridge API，先把 Codex 连接内核换为经安全能力验证的 App Server stdio，再增加支持取消/增量结果的窄事件接口；确有第二个代理需要通用会话时再做 ACP adapter。不要先造开放的通用远程终端、公开 localhost 中继或跨设备 token 同步。

## 认证、费用与分发说明

上述 App Server 官方文档在本次核对时写明：现有本地/开源 app 可以继续用 app-server authentication，同时说明该方式未获准用于商业或托管服务。文档建议评估官方 Sign in with ChatGPT。页面未显示发布日；这里记载的是查阅日。当前本地开源 Coconut 与日后的托管服务须分别评估，不能从开源客户端许可推导出云端复用订阅凭据的权限。不会把本机账号凭据搬到 Coconut 云端。

- 现有订阅请求仍受供应商额度和服务条款约束；不会自动买额度。另接付费 API / 云 ASR / 托管算力需先给出费用并获得许可
- [Codex 源码许可为 Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE)，若以后捆绑其官方二进制，需要固定版本/来源、校验下载，并保留适用 LICENSE/NOTICE 与第三方许可；此许可不代替服务授权。当前 app **没有捆绑 CLI 二进制**，使用已安装的官方 CLI
- Claude Code 二进制不应仅因参考项目打包就推断可再分发；捆绑前另核对官方分发条款。当前没有再分发它
- [Apple Developer Program](https://developer.apple.com/programs/whats-included/) 当前标价 US$99/年或当地币种。用户已加入与否尚未确认。本轮没有购买会员、创建签名凭据或声称已完成 [签名/公证](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- unsigned 开发包可能被 Gatekeeper 阻止；不能作为“普通用户双击即用的正式版”宣传，也不指导关闭系统安全机制。正式发布前需真实 Mac 安装验收、Developer ID 签名、公证以及架构覆盖

