# Relay V1.0.0

首个 GitHub 发行版本，面向 macOS 13 及更新版本，支持 Apple Silicon 和 Intel。应用显示版本为 **1.0.0**，内部构建号 **2**。

## 下载

- **Apple Silicon（M 系列芯片）**：`Relay-1.0.0-macOS-arm64.pkg`
- **Intel**：`Relay-1.0.0-macOS-x64.pkg`
- `SHA256SUMS`：用于核对安装包完整性。

[产品介绍与真实截图](https://haiyangdeng.github.io/Relay/) · [对应源码](https://github.com/haiyangdeng/Relay/tree/v1.0.0)

## 主要内容

- 配置与订阅、代理组与节点、分流规则、连接和运行日志。
- 系统代理与可恢复的配置记录。
- Claude / Codex 专用代理，Claude Code 配置应用、备份和恢复。
- 独立浏览器入口，桌面登录与默认浏览器恢复流程。
- 菜单栏操作、后台运行与备份恢复。
- 修正退出链与 PAC 生命周期；增加独立卸载组件，在 `Relay.app` 被拖入废纸篓后自动清理 Relay 管理的配置、进程、系统组件、登录项及专属数据。

## 安装与使用

安装包包含 App、系统代理管理员组件及自动卸载组件。安装需要 macOS 管理员授权，目标位置为 `/Applications/Relay.app`。安装器拒绝覆盖已有 Relay 应用、组件或运行实例。

本版采用 **ad-hoc 签名，未使用 Developer ID，也未获 Apple 公证**。请通过本仓库的 Release 获取文件，并核对校验值。

卸载会清理 Relay 的专属数据，请先导出需要保留的配置。进入废纸篓后的清理由独立组件完成；无法确认归属或恢复失败时保留必要记录。

## 已验证与边界

已完成相关类型检查、退出和卸载的针对性离线回归、独立代码审阅、双架构打包、包内资源及签名一致性检查。上述结果不等同于真实网络行为或实机卸载验收；本轮 **Finder／TCC／launchd／系统代理与 TUN 的完整卸载链仍未完成实机验收**。

V1.0.0 不提供系统级按进程防直连保证。应用忽略代理或使用绕过规则时，不应推断流量已进入 Relay。

源码保留 TUN 能力，但现有独立 TUN 安装包绑定构建用户，因此不作为通用公开下载；本次一体安装包不包含通用 TUN 安装组件。

极端情况下，旧版 `SMAppService` 登录项若未迁移且原 App 已被立即清空，外置清理程序无法保证注销旧系统登记。外部修改的组件、尚在使用的未知会话或系统拒绝的操作不会被强行删除。

## 来源与许可

Relay 基于 Clash Party v2.0.4 与 Mihomo。源代码及对应补丁公开于本仓库，保留 GNU GPL v3 和第三方许可证／来源声明；不是 Clash Party、Mihomo、Anthropic 或 OpenAI 官方发行版。
