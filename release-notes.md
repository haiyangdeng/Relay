# Relay V1.0.0 · Apple Silicon 构建 23

2026 年 11 月 23 日发布，适用于 macOS 13 或更新版本。应用显示版本为 1.0.0。Apple Silicon 更新到构建 23，Intel 继续提供 11 月 13 日发布的构建 2。

| 芯片          | 实际构建 | 安装包                                                                                                                            | 对应源码                                                             |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Apple Silicon | 23       | [Relay-1.0.0-macOS-arm64.pkg](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.23/Relay-1.0.0-macOS-arm64.pkg) | [构建 23](https://github.com/haiyangdeng/Relay/tree/v1.0.0-build.23) |
| Intel         | 2        | [Relay-1.0.0-macOS-x64.pkg](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.23/Relay-1.0.0-macOS-x64.pkg)     | [构建 2](https://github.com/haiyangdeng/Relay/tree/v1.0.0)           |

[下载 SHA256SUMS](https://github.com/haiyangdeng/Relay/releases/download/v1.0.0-build.23/SHA256SUMS) · [介绍与真实截图](https://haiyangdeng.github.io/Relay/) · [历史发行版](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0)

## Apple Silicon 更新

- 首次导入自己的配置后，可直接点左侧「系统代理」的小开关。修复普通组和内置 GLOBAL 组记住同一节点时第一次启动失败的问题。点击卡片文字会打开设置页。
- 在代理组页选中配置或节点即应用。各组测速按钮只测试本组成员。
- 主安装包集成系统代理、TUN 和自动卸载组件。系统代理和 TUN 可独立启停，也可同时开启。关闭 TUN 会恢复此前的普通代理状态，已有连接在内核交接时可能短暂重连。
- 当监听端口已被其他进程占用时，界面会指出冲突端口，用户可处理冲突后重试。

## 安装与卸载

安装包提供空白配置。安装后在「订阅管理」导入自己的 YAML 或订阅。安装目标为 `/Applications/Relay.app`，管理员组件需要 macOS 授权。安装包采用 ad-hoc 签名，未使用 Developer ID，也未经 Apple 公证。

升级前请先退出 Relay。构建 23 会核对现有安装的归属和恢复条件，通过后保留用户配置。Intel 构建 2 沿用原安装器，会拒绝覆盖已有组件，且不含通用 TUN 组件。

卸载前请导出需要的配置。把 Relay.app 从「应用程序」拖入废纸篓后，独立卸载组件负责恢复它管理的设置并清理专属数据。遇到归属不明或恢复失败的项目，会保留恢复记录。

## 验证范围

Apple Silicon macOS 虚拟机使用合成节点进行两轮独立验收。每轮先将旧版移入废纸篓，并确认应用、用户配置、服务和安装收据已清理，再安装同一份构建 23。

- 导入配置后，首次点击系统代理开关即可通过系统 HTTPS 请求。
- 系统代理已开时，打开 TUN 后流量经虚拟网卡到达所选节点。关闭 TUN 后，普通和专用代理均恢复，系统代理持续开启。
- 系统代理原本关闭时，首次点击 TUN 即可独立联网。关闭 TUN 后系统代理仍关闭。
- 端口冲突场景保留占用端口的原进程。释放端口后可再次启用。测试结束时核对了系统代理、默认路由、DNS 及测试端口的恢复情况。

本轮验收覆盖 Apple Silicon。Intel 包与其原发行文件逐字节相同。应用忽略代理或命中绕过规则时，专用代理不能提供系统级按进程防直连保证。

## 来源与许可

Relay 基于 Clash Party v2.0.4 与 Mihomo。对应源码、修改补丁与第三方归属随仓库提供，许可证见 [GPL-3.0](https://github.com/haiyangdeng/Relay/blob/v1.0.0-build.23/LICENSE)。
