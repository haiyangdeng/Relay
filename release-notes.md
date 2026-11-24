# Relay V1.0.0 · 构建 24

2026 年 11 月 24 日发布，适用于 macOS 13 或更新版本。Apple Silicon 和 Intel 安装包均为构建 24，包含系统代理、TUN 和自动卸载组件。

| Mac 芯片      | 安装包                                                                                                                  | SHA-256                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Apple Silicon | [下载 arm64 安装包](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.24/Relay-1.0.0-macOS-arm64.pkg) | `c087f2523708e10aa1a75103f2120716b0580e4c66fd9a7e4f1f8adbb6d3b267` |
| Intel         | [下载 x86_64 安装包](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.24/Relay-1.0.0-macOS-x64.pkg)  | `d2ea75cd1075f2cc42e55cb1248c6bd5f3e6b2ee8cd8ed845e654458bf472b74` |

[对应源码快照](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.24/Relay-1.0.0.24-source.tar.gz) · [下载 SHA256SUMS](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.24/SHA256SUMS) · [介绍与真实截图](https://haiyangdeng.github.io/Relay/) · [历史发行版](https://github.com/haiyangdeng/Relay/releases)

## 登录时自动启动

点击左上角齿轮，在设置首页打开「开机自启动」。下次登录当前 macOS 账户时，系统会打开 Relay。关闭开关即可取消。进入设置时会自动读取状态。如果 macOS 禁止了该登录项的后台活动，Relay 会提示前往「系统设置 → 通用 → 登录项」允许后台活动。

## 验证范围

- **Apple Silicon**。在 macOS 15.7.7 虚拟机从构建 23 升级，两次真实重启均排除了 macOS 恢复上次窗口的影响。开启自启后，登录时只启动一个 Relay 主进程。关闭后再次登录，连续 45 次采样均未出现 Relay 进程。另已验证系统禁止后台活动时的界面提示。
- **系统代理与 TUN**。Apple Silicon 版导入测试订阅后首次点击左侧系统代理即联网。保持系统代理开启，打开再关闭 TUN，普通及专用代理的五个入口均可用，系统 HTTPS 请求成功。退出后已核对系统代理、路由及 DNS 的恢复。
- **Intel**。已核对安装包、x86_64 组件架构与应用签名。原生 Intel Mac 的登录自启、系统代理及 TUN 联网仍待实测。

## 安装与卸载

升级前请先退出 Relay。安装器会检查现有安装的归属和恢复条件，通过后保留用户配置。首次安装时配置为空，请在「订阅管理」导入自己的 YAML 或订阅。安装目标为 `/Applications/Relay.app`，管理员组件需要 macOS 授权。应用采用 ad-hoc 签名，安装包未签名，未经 Apple 公证。

卸载前请导出需要保留的配置。把 Relay.app 从「应用程序」拖入废纸篓后，独立卸载组件会恢复它管理的设置并清理专属数据。归属不明或恢复失败的项目会保留恢复记录。

## 来源与许可

Relay 基于 Clash Party v2.0.4 与 Mihomo。对应源码、修改补丁与第三方归属随仓库提供。[GPL-3.0](https://github.com/haiyangdeng/Relay/blob/v1.0.0-build.24/LICENSE)
