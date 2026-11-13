# 普通监听端口

Relay 和 Clash Party 都使用 Mihomo。Relay 的 GeoData 构建固定到上游提交 `3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8`，另外包含本地 GeoData 与 File provider 更新补丁。普通监听直接使用 Mihomo 的 `port`、`socks-port`、`mixed-port`、`redir-port` 能力，没有另写协议代理。来源和补丁见 `core-extensions/SOURCE.md`。

## 使用

在“内核设置”编辑四类端口，每项开关控制该监听是否启用，关闭值为 0。启用端口范围为 1024–65535，不允许与其他普通端口或 AI 专用端口重复。

| 入口  | 用途                                                   |
| ----- | ------------------------------------------------------ |
| HTTP  | HTTP 代理、HTTPS CONNECT                               |
| SOCKS | SOCKS 代理；支持 SOCKS5 UDP 入口，转发能力还取决于节点 |
| 混合  | 同一端口接受 HTTP 和 SOCKS                             |
| Redir | macOS 透明 TCP 重定向入口，需另行配置 PF 规则及权限    |

所有普通监听只绑定 `127.0.0.1`，遵循当前分流规则。至少保留 HTTP 或混合端口，用于 Relay 的系统代理和管理请求。HTTP 关闭时自动以混合端口作为 HTTP 可用入口。

保存的是下一次核心启动计划。运行中的实际端口单独显示；切换订阅或重新加载规则会保留当前端口，不会偷偷应用未启动的端口草稿。原生持久核心模式仍仅支持普通 HTTP；多端口使用随主程序运行模式。

旧计划保持 HTTP 18191（或原保存值），其他普通端口关闭。不会自动抢占 Clash Party 的端口；端口占用时拒绝启动，不停止占用进程。

## 与 AI 专用监听的区别

普通端口按分流规则选路。AI 专用 HTTP/SOCKS 监听绑定具体节点，单独配置；新增普通 SOCKS 不会改变 Claude Code、浏览器入口或用户的代理环境变量。是否阻断直连仍取决于实际接入的保护能力，不能从端口已开启推断系统级保护已生效。

## Redir 边界

该固定上游的 macOS Redir 使用 `/dev/pf` 查询 IPv4 TCP 原目标，开启监听不会自动安装 PF 规则或接管系统流量。非 Linux 的 UDP Redir 不支持。本次仅验证 Redir 端口绑定及进程归属，没有变更或验证系统透明转发规则。

## 验证方式

`scripts/relay/test-ordinary-multiport-runtime.ts` 只启动独立测试子进程，使用临时回环端口与本机服务，验证 HTTP/SOCKS/混合协议、TCP/UDP 监听归属、混合入口单独运行、热载及退出后的端口释放。它不操作现有 Relay、Clash Party、Claude、系统代理、路由或 DNS。
