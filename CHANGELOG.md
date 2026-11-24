# 版本记录

## 1.0.0 · 构建 24 — 2026-11-24

- 设置首页提供「开机自启动」开关。可直接查看和更改当前账户的登录启动状态。若 macOS 暂停了后台活动，设置页会提示所需许可。
- Apple Silicon 与 Intel 均更新到构建 24。Apple Silicon 版已在 macOS 虚拟机验证重启后的登录自启、首次开启系统代理和 TUN 切换。Intel 安装包已核对组件架构与应用签名，原生登录和联网仍待实测。[发行说明](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0-build.24)

## 1.0.0 · Apple Silicon 构建 23 — 2026-11-23

- 导入配置后可直接点击左侧系统代理开关。修复普通代理组和 GLOBAL 记住同一节点时首次启动失败的问题。
- 选中配置或节点即应用，代理组按钮仅对本组测速。TUN 与系统代理可同时工作，关闭 TUN 后保留原系统代理状态。
- Apple Silicon 安装包已集成 TUN。Intel 下载继续提供 11 月 13 日的构建 2，文件和校验值均沿用原版。
- Apple Silicon macOS 虚拟机完成两轮全新安装、首次点击系统代理或 TUN、网络连通性及恢复验证。[发行说明](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0-build.23)

## 1.0.0 — 2026-11-13

首个 GitHub 发行版本，内部构建号 2。

- macOS 代理工作区：订阅、本地配置、节点选择、规则与网络状态。
- Claude / Codex 专用代理与客户端配置工作流。
- Claude Code 配置备份、应用与恢复；Relay 绑定的专用浏览器入口。
- 桌面登录默认浏览器恢复流程、菜单栏操作和后台运行。
- 修正退出流程、PAC 生命周期与系统代理恢复链。
- 增加拖入废纸篓触发的独立自动卸载，覆盖自有进程、组件、登录项、数据、缓存及凭据；配置恢复保留用户之后的修改。
- Apple Silicon 与 Intel 安装包，真实软件截图和 GitHub Pages 介绍下载页。
- 保留 GPL 与上游来源说明，分离私有运行材料与公开源码。

本轮完成代码、离线回归、独立审阅和包内资源／签名校验；完整系统卸载尚未实机验收。签名、安装要求和能力边界见 [Release](https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0)。
