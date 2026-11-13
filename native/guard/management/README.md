# 第43批：持久过滤管理源码基础

2026-11-06。仅新增 `native/guard/management/RelayGuardManagementGate.swift` 与
`RelayGuardManagementController.swift`，已纳入正式源码，尚未进入现有构建清单或任何 App，
未新增 CLI、IPC、UI 入口；没有运行测试、产品、Core 或系统管理接口。

## 实际复用

Apple 官方 [Filtering Network Traffic](https://developer.apple.com/documentation/networkextension/filtering-network-traffic)
样例的完整管理源码保存在 `upstream/ViewController.swift`。
固定下载归档为 `upstream/FilteringNetworkTraffic.zip`，SHA-256
`73bdbda7edfc6ecc74e39cfbf4a44833c40096884f688683252fc6160c1514e9`，
来源、下载日期及采用范围见 `upstream/provenance.json`，许可证同目录保留。

本切片适配其 `OSSystemExtensionRequest` 激活委托与 `NEFilterManager` load/save 调用链，
保留长时系统批准需要的 delegate 寿命。没有采用样例的激活完成后自动启用、默认替换、
读取失败视为 stopped、保存失败视为 running、日志采集及缺少提示上下文时放行行为。

## 源码行为与门禁

- 发布 Permit 仅从固定主 App/扩展路径、同版本、签名标识、预期 Team、权限及禁止联网的
  Apple anchor/全部切片签名校验生成，不接受 renderer 的路径、Team、ready 布尔或授权字符串。
  复用现有 `RelayGuardReadiness.observe`，不改其报告和既有调用链。
- 当前发布 Team 为 null、安装与运行准备位为 false，与现有 package manifest 一致。
  因此任何 manager、系统请求或确认窗口创建前即类型化拒绝。
  enable 另因可信代理/策略绑定协议尚不存在而直接拒绝；发布布尔位不能替代该协议。
- Controller 在同一进程内串行化操作。真实操作需原生具体确认，取消为默认按钮；
  授权对象仅私有内存生成，绑定单次 operation、发布版本、配置摘要和 UUID。
  确认后重新核包与配置，禁止把旧确认应用到变更后的配置。
- install 同样先读取配置、核属并绑定摘要，确认后重新读取核对；无法归属的现有或启用配置拒绝激活。
  安装处理完成、需用户批准、待重启和失败；激活后重新读配置，不能确认时清空旧观测。
  此路径不写 isEnabled，但已有启用配置可能随激活启动 Provider，确认文案明确说明网络影响。
  enable/disable 的保存代码明确绑定固定自有 Provider、精确配置标记与 socket 配置，
  未确认所属的配置不覆盖。macOS 15+ 的 `disableEncryptedDNSSettings` 若为 true，
  即使没有 Provider 配置也拒绝观察/保存，不继承或写入停用其他加密 DNS 的设置。
  isEnabled 只记录配置事实，`protectionVerified` 恒为 false。
- 保存成功仍需重新 load。保存或回执失败仅重新读取，区分原样、目标已保存与不确定，
  不自动反向覆盖、不自动重试。扩展替换始终返回 cancel。

## 静态检查与限制

仅对两个新增主文件执行 Swift 5 严格并发、warnings-as-errors 的 ARM64/Intel typecheck，
其余 49 个现有 Native/legacy 文件仅作为真实类型依赖。不生成可执行程序，不运行测试。
一次全 General 严格检查首先被既有 `RelayDesktopLive.swift` 的非 Sendable 捕获阻塞，
失败原始日志保留；本切片没有修改该历史问题，也不把局部编译称为 General 全量通过。

当前仍无持久、已授权宿主。现有 Node `invokeNative` 是限时短命子进程，不能用于等待
系统批准的管理会话；本切片不向其添加命令。取消 Task 不会伪造 OS 请求取消或释放正在
等待批准的事务；未来宿主必须保留 Controller/任务，直到真实终态，不得据此重试或退出。

disable 不依赖 Provider 运行准备位，但仍需自身包内扩展存在、同版本及权限/签名匹配。
因此本切片不具备扩展包损坏/丢失时的恢复停用能力。真实已安装组件身份查询、独立修复宿主、
进程退出/崩溃后的持久事务恢复、跨进程配置并发，以及可核实的策略/代理运行授权尚未实现。
这些缺口不通过新增就绪布尔或占位 Team 放行。

本次不是第43批完成或 enable 可用声明，未完成行为/故障/实机验证。现有 Provider 的离线
拒绝启动、默认无代理许可和所有已封存 App 均保持原样。Claude 配置与当前网络未改变。

Apple 样例许可证保留在 `LICENSE.Apple.txt`，固定来源记录见 `UPSTREAM.json`。
