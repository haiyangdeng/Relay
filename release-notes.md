# Relay V1.0.0 · 构建 25

2026 年 11 月 24 日发布，适用于 macOS 13 或更新版本。Apple Silicon 和 Intel 安装包均为构建 25，包含系统代理、TUN 和自动卸载组件。

| Mac 芯片      | 安装包                                                                                                                  | SHA-256                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Apple Silicon | [下载 arm64 安装包](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.25/Relay-1.0.0-macOS-arm64.pkg) | `efb5e46ccca86db791ca317bfa2faa835a5b891eef3ecd373ac8c774dc07e9f5` |
| Intel         | [下载 x86_64 安装包](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.25/Relay-1.0.0-macOS-x64.pkg)  | `cac51f471f0db115e8a9c8dbfb602b6c2d03790ce851d5a58fa0d4cb33bc094b` |

[对应源码快照](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.25/Relay-1.0.0.25-source.tar.gz) · [下载 SHA256SUMS](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.25/SHA256SUMS) · [介绍与真实截图](https://haiyangdeng.github.io/Relay/) · [历史发行版](https://github.com/haiyangdeng/Relay/releases)

## 系统代理端口修正

同时配置混合入口和独立 HTTP 入口时，系统代理设置页和「配置检测 → 执行只读检测」现在都显示 macOS 系统代理使用的端口。例如，系统代理使用混合端口 `7890`、独立 HTTP 端口为 `7892` 时，设置页显示 `7890`，检测页显示「系统普通代理 7890：匹配」。独立 HTTP 入口仍可使用。

## 验证范围

- **Apple Silicon** 在 macOS 15.7.7 虚拟机从构建 24 原位升级。原配置、核心选择与启动设置、系统代理默认设置和合成历史记录共 18 个文件，升级前后 SHA-256 一致。两个端口分别发出的测试请求均抵达预期出口。
- **Intel** 已核对安装包归档、组件架构和应用签名，原生 Intel Mac 的运行验证仍待完成。
- **历史验收** 登录自启、首次开启系统代理以及 TUN 往返切换的 Apple Silicon 实测结果来自构建 24。[构建 24 发行说明](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0-build.24)

## 安装与卸载

升级前请先退出 Relay。安装器会检查现有安装的归属和恢复条件，通过后保留用户配置。首次安装时配置为空，请在「订阅管理」导入自己的 YAML 或订阅。安装目标为 `/Applications/Relay.app`，管理员组件需要 macOS 授权。应用采用 ad-hoc 签名，安装包未签名，未经 Apple 公证。

卸载前请导出需要保留的配置。把 Relay.app 从「应用程序」拖入废纸篓后，独立卸载组件会恢复它管理的设置并清理专属数据。归属不明或恢复失败的项目会保留恢复记录。

## 来源与许可

Relay 基于 Clash Party v2.0.4 与 Mihomo。对应源码、修改补丁与第三方归属随仓库提供。[GPL-3.0](https://github.com/haiyangdeng/Relay/blob/v1.0.0-build.25/LICENSE)
