# Coconut 应用更新

当前机制是**自动检查／下载、确认后安装**，不是无需干预的系统级自动更新。

当前 ZIP 是未签名、未公证的开发版。Electron 原生 `autoUpdater` 在 macOS 使用 Squirrel.Mac，要求应用签名。这里没有假装满足该要求，也没有安装签名密钥或关闭 macOS 安全检查。

## 使用

在侧栏「应用更新」或 Coconut 菜单「检查更新」操作。打包应用启动 12 秒后异步检查，持续运行每 6 小时检查一次；节流记录跨重启保留，手动检查可立即重试。发现符合频道的新版本后后台下载，显示进度；可以取消，网络或校验失败可以重试。

默认只检查正式发布。现有开发版发布在 GitHub 标记为 prerelease，因此需要明确勾选「检查未签名开发版（预发布）」才会收到后续开发版。该设置保存在本机。只接受 `v数字.数字.数字`，不接受 `-beta`、构建后缀、草稿、相同版本或降级；按版本号选择最新版本，不依赖发布时间排序。

下载源固定为 `YakiHugo/coconut` 的 GitHub Releases，无凭据、无用户内容上传。安装包文件名必须匹配当前 Electron 架构；同时验证 GitHub asset SHA256 digest、SHA256SUMS 文件 digest、安装包的 SHA256SUMS 条目和实际字节大小。HTTPS 跳转只接受 GitHub 与其资产 CDN。

## 安装与用户数据

仅支持当前用户拥有、可写的 `~/Applications/Coconut.app` 或 `/Applications/Coconut.app`。磁盘映像和其他目录的应用会提示先移动，不会提权或覆盖陌生安装。下载好以后点击「安装并重启」，原应用继续运行直到你确认。打开的编辑窗口、未保存书架、术语草稿、播放、字幕获取和处理任务都会阻止安装；准备完成后再次检查，并刷新持久化存储。

安装前扫描 ZIP 目录和本地条目，拒绝路径穿越、重复文件、特殊文件、逃出应用的符号链接及通过符号链接覆盖目录，并限制条目数量和解压大小。解压后再次校验符号链接、Bundle ID、版本和实际 Mach-O 架构。新应用显式保留 `com.apple.quarantine`，通过系统 `open`/Launch Services 启动。若 Gatekeeper 拒绝或要求确认，请由用户在 macOS 的提示中处理；不会删除 quarantine、修改 `spctl` 或通过直接运行新二进制绕过拒绝。

安装助手等待当前应用 PID 退出，最多 60 秒，**不会强制关闭**。旧应用移动到同一 Applications 目录下的 `Coconut.previous-旧版本-时间戳.app`，新应用随后移动到原位置。第二次移动失败或可捕获中断会恢复旧应用。旧版本保留，供用户恢复，不自动删除。

书架、稿件、笔记和设置始终在同一个 Electron `userData` 目录及固定 `http://127.0.0.1:47831` origin 下；安装不复制、移动或删除这些数据。媒体文件引用本来就不跨启动保留，需要重新选择。

## 失败与恢复

已校验下载以 `updates/pending.json` 和 `updates/update.zip` 保存，重新启动会重新核验；损坏或不合频道的包不能继续安装。取消的 `.part` 文件被清理。

安装结果写入 `updates/install-result`。系统启动失败时保留两份应用；不要绕过系统拒绝。安装窗口出现错误会留在当前版本并允许重试。

如果机器在两次目录重命名之间断电，原位置可能暂时缺失。安装前已写入 `updates/transaction.json` 与 `updates/recover.command`。在 Finder 中打开本机 Coconut 数据目录下的 `updates/recover.command`，它只在原位置缺失时恢复记录的旧应用，再交给系统 `open` 启动；不会覆盖存在的应用。也可从 Applications 中直接找到保留的旧应用。这是恢复手段，不是安全检查绕过。

## 验证

`node --test tests/desktop-updater.test.mjs` 覆盖版本与频道、降级、错误来源／架构、网络失败、持久节流、双 checksum、坏文件、取消及重试、下载重启恢复、ZIP 安全结构、替换保留旧包与数据、系统拒绝后的状态。原有 packaged acceptance 在精确 ZIP 中验证阅读、笔记／修正、设置、完整书架的重启持久化；更新界面验收另覆盖重启保护。

原生无干预更新仍需适当的 Apple Developer ID 签名、可信分发／公证配置和用户设备接受该应用的安全状态。这个实现不创建付费账户、OAuth grant 或新系统权限。
