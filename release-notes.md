# Relay V1.0.0 · Intel 构建 28 / Apple Silicon 构建 25

2026 年 11 月 28 日发布，适用于 macOS 13 或更新版本。本次更新 Intel 安装包；Apple Silicon 保留正式构建 25 的原始安装包和对应源码，字节与原发行版一致。两个安装包均包含系统代理、TUN 和自动卸载组件。

| Mac 芯片      | 构建 | 安装包                                                                                                                  | SHA-256                                                            |
| ------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Apple Silicon | 25   | [下载 arm64 安装包](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.28/Relay-1.0.0-macOS-arm64.pkg) | `efb5e46ccca86db791ca317bfa2faa835a5b891eef3ecd373ac8c774dc07e9f5` |
| Intel         | 28   | [下载 x86_64 安装包](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.28/Relay-1.0.0-macOS-x64.pkg)  | `1f03754b3a579a4b7438c4a75a88ea63c145295cdf454c7c94076275bab8321f` |

[Intel 28 对应源码](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.28/Relay-1.0.0.28-source.tar.gz) · [Silicon 25 对应源码](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.28/Relay-1.0.0.25-source.tar.gz) · [SHA256SUMS](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.28/SHA256SUMS) · [产品介绍](https://haiyangdeng.github.io/Relay/) · [历史发行版](https://github.com/haiyangdeng/Relay/releases)

## Intel 修复

- 启动设置未改变时，校验当前记录和版本后直接使用，避免重复写入触发备份恢复保护而阻断启动。真实设置变更仍保留原有保护检查。
- 普通代理等隔离核心的配置解析上限从 10 秒调整为 30 秒，避免首次解析较慢时提前终止；超时仍终止并清理本次核心，提供具体提示。该调整不改变真实 TUN 的启动控制流程。
- 修正安装、回滚和卸载中的 TUN 锁身份检查，比较已持有的真实文件描述符与锁文件。

## 验证范围与已知问题

- **Intel 自动检查**：275 项相关回归通过；实际渲染界面的启动调用链使用隔离 IPC 场景验证，2 个场景、18 项断言通过。安装包的源码关联、密封业务文件、架构、签名与组件配对校验通过。
- **包内核心运行**：在 Intel Mac 上，从最终安装包全新展开的首轮 124 项及同资源复测 124 项全部通过，覆盖规则／全局／直连路由、节点切换、测速、多端口和停止清理。这些隔离测试不等于真实 TUN 或已安装 GUI 的完整验收。
- **Intel 实机反馈**：用户已使用本包，反馈 TUN 开启较慢，其他功能暂未报告异常。**TUN 开启慢仍待定位，本次未修复；构建 28 的自动化本机升级、已安装 GUI 全流程和真实 TUN 专项验收尚未完成。**
- **Apple Silicon**：本次未重新构建或替换原构建 25。原版从构建 24 升级、配置保留、系统代理端口和双入口联网的结果见[构建 25 发行说明](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0-build.25)；登录自启和 TUN 实测记录来自[构建 24](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0-build.24)。当前 Intel 28 源码重新构建的 arm64 App 尚未实机验收。

## 安装与卸载

升级前请先退出 Relay。安装器会检查现有安装的归属和恢复条件，通过后保留用户配置。首次安装时配置为空，请在「订阅管理」导入自己的 YAML 或订阅。安装目标为 `/Applications/Relay.app`，管理员组件需要 macOS 授权。应用采用 ad-hoc 签名，安装包未签名，未经 Apple 公证。

卸载前请导出需要保留的配置。把 Relay.app 从「应用程序」拖入废纸篓后，独立卸载组件会恢复它管理的设置并清理专属数据。归属不明或恢复失败的项目会保留恢复记录。

## 来源与许可

Relay 基于 Clash Party v2.0.4 与 Mihomo。两种安装包各自对应的源码归档单独提供，包含构建说明、修改补丁及第三方归属。[GPL-3.0](https://github.com/haiyangdeng/Relay/blob/v1.0.0-build.28/LICENSE)
