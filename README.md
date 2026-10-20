# 🥥 Coconut

把长音视频变成可信、好读、可回源的文字材料。

保存状态会显示“保存中 / 已保存”及具体失败原因。连续编辑合并保存；失败后可重试，或下载包含完整译文、笔记与 AI 历史的“未保存文档备份”。本页草稿和移除恢复副本另行保留。原生关闭与安装更新会先等待实际保存回执；默认直接保存到电脑上的 SQLite 统一书架，普通编辑仅写入有修改的文档。服务不可用时明确报错，不会改写浏览器存储。已有浏览器记录仅作为只读恢复副本保留。详见 [保存与恢复](docs/library-save-pipeline.md)。

## 从来源开始

- 在「发现与添加」选择播客节目，或粘贴视频、单集、RSS 链接。单集可选「先听原声」，无需先选文字稿；发布者文字稿失败仍可明确改选原声。来源能力与实际连接有关，获取失败会显示原因。
- 直接打开原始音频或视频，在内置播放器中回听并记录项目笔记。没有文字稿时明确显示原声项目，不生成虚构字幕或摘要。
- 平台文字稿未关联可播放媒体时，逐句与连贯阅读可显式打开 YouTube / B站的对应时间（新标签页）；其他来源仅提供原站入口。外站播放与停止由原站控制，不会下载视频或模拟内置播放器。本地媒体校准不会改变原站时间。
- 有文字稿后可搜索、逐句或连贯阅读、摘录、记笔记和返回时间位置；AI 翻译、问答与摘要需要单独核对范围和确认。
- 字幕文件、粘贴与 JSON 备份是次级恢复入口，不是正常使用的前置要求。原声项目补字幕需预览确认，保留原文件归属、项目笔记与书签。
- 默认界面由 React 完整管理。旧界面、兼容入口和迁移期预览已移除；共享文档校验、存储和恢复能力继续使用。

开发时使用 Node.js 22.13+：

```bash
npm ci
npm run dev
```

打开命令输出的本机地址；`npm run doctor` 可检查服务能力。默认不安装或下载 ASR 模型。识别服务的配置、就绪状态和任务协议见 [来源与原始媒体](docs/link-first-ingestion.md)。

默认 React 与实际原生验收边界见 [应用入口](docs/react-default-cutover.md) 和 [应用行为合同](docs/react-migration-parity.md)。公共静态页面无法自行提供本机 AI、平台获取或 ASR 后端。

## 阅读与保存

阅读、播放器、搜索、选区、笔记、摘要、AI 任务及恢复设置都由 React 管理。原文、时间定位、来源和用户修改分别保留；字幕来源可追溯不代表已经人工校对。

浏览器直接连接服务端 SQLite 统一书架，空库也无需迁移或额外设置。同一服务的不同浏览器读取同一书架。旧浏览器记录不会自动合并，存储设置提供只读恢复导出；旧迁移写接口已停用，历史状态与回执仍可只读查询。保存失败时可保留草稿、重试或导出完整 JSON 救援；不要清除站点数据来绕过错误。完整备份不含音视频文件或本机文件授权。

原始媒体先在当前会话播放。桌面可明确选择在这台电脑记住原文件；重启后仍不自动播放。文件丢失或改变时保留笔记并要求重新选择，不删除或改写原文件。

- [保存与恢复](docs/library-save-pipeline.md)
- [统一书架](docs/canonical-library.md)
- [原声项目](docs/audio-library-projects.md)
- [备份恢复边界](docs/backup-recovery.md)

## 来源获取与识别

公开播客、视频字幕和原始媒体按服务实际能力提供。公开静态页面、源码本地服务和桌面包的能力并不相同。平台限制、缺少字幕或依赖不可用会明确显示，不把简介当文字稿，不自动切换身份或读取浏览器 Cookie。

公开链接和字幕获取有来源、大小、时长与请求预算限制。受信任代理仅支持所有者显式配置的字幕范围；默认关闭，不是任意地址转发。

原始媒体无需先有文字稿即可播放。ASR 是可选执行器能力，必须明确配置、确认输入并取得本地就绪状态；正常应用流程不会静默安装依赖或下载权重。没有可用模型时仍可播放和记录笔记。

- [链接、播客与原始媒体任务](docs/link-first-ingestion.md)
- [开发字幕获取](docs/development-captions.md)
- [字幕失败诊断](docs/caption-diagnostic-outcomes.md)
- [三平台导入实现与真实验证证据](docs/public-ingestion-evidence.md)
- [来源与 ASR 边界](docs/podcast-sources-and-asr.md)

## AI 与后台任务

本机工具或已配置服务的就绪状态不等于账户额度与模型调用成功。发送前核对工具、模型、原文范围和额度；每次实际调用需明确确认。原文或连接身份改变后，旧结果不能直接覆盖新内容。

后台摘要保存进度和任务身份；中断后明确续跑，不自动重发未知请求。接收结果前核对原文快照，失败内容保留可用的恢复路径。本机错误详情需本人展开查看，不进入文档历史或备份。

- [本地 AI 与 macOS](docs/local-agents-and-macos.md)
- [持久后台摘要任务](docs/persistent-summary-tasks.md)
- [长文摘要计划](docs/long-document-summaries.md)

## 开发与验收

修改 React 源码或 reader 静态 JS/CSS 后，运行 `npm run build:reader-ui`：它会生成 bundle，并更新 `reader/index.html` 中全部受支持的本地 JS/CSS 引用的 SHA-256 缓存 token，无需另跑 Python 更新步骤。`check:reader-ui` 只检查、不写文件，同时验证类型、bundle 与缓存 token；引用的资源缺失也会失败。原有 `python scripts/reader_assets.py --check` 仍可独立验证 token。

```bash
npm run build:reader-ui
npm run check:reader-ui
npm run test:react
npm run test:desktop
```

CI 还检查共享领域模型、Node/Python 协议、真实 Chromium 默认界面和实际 macOS 打包应用的菜单、文件选择、保存、关闭及重启流程。普通回归使用自写材料和明确标注的模拟模型；通过不代表真实模型质量或所有公开平台可用。

公开来源后端检查、模拟界面检查与真实来源到 React 的端到端证据分别报告，不能把独立通过的前两者拼成真实闭环。本次 B站与小宇宙的真实识别、React 接入与刷新恢复证据，以及 YouTube 登录阻塞，见 [验收记录](docs/public-ingestion-evidence.md)。CI 成功不代表用户电脑已安装识别环境或本地代理已验证；具体准备和未配置时的行为见 [运行要求](docs/public-ingestion-evidence.md#running-the-source-app-is-a-separate-setup-step)。删除旧界面不会删除用户数据，也不会取消新默认界面的安全、存储或原文件校验。

源码主干与既有 [GitHub Releases](https://github.com/YakiHugo/coconut/releases) 是不同交付物。版本号未改变时，不覆盖已经发布的开发包。macOS 开发包未获 Developer ID 签名或 Apple 公证，不应绕过系统安全警告。
