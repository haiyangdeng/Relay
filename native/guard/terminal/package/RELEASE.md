# Terminal `claude` 入口的发布与恢复

入口固定为 `Contents/Resources/relay/guard-terminal/RelayTerminalCLI`。它由同一个通用 Mach-O 提供 ARM64 和 Intel 切片。App 内的 Main 宿主使用现有 `RelayGuard.node` 与 `libRelayGuardHost.dylib`，两者继续由 Guard 宿主构建。独立 launcher 只链接两端共享租约源码、客户端、启动准备及执行入口。

`scripts/relay/build-guard-terminal.py` 默认核对已关闭的发布定义、实际 App ID、版本及编译开关。`--check-source` 检查两架构，`--build` 另外生成薄片和通用开发产物。检查及产物写入一个新建的 `.relay-build/private` 子目录。记录包含输入哈希及实际 Mach-O 架构。宿主检查仍由 `scripts/relay/build-guard-host.py` 负责。

当前 `runtimeReady=false`，`publisherTeamID` 和 `launcherPin` 为空。这个关闭分支的 `afterSign` 只接受不存在 `guard-terminal`，或该目录仅含与已审源码逐字节一致的关闭版 manifest。私有开发 launcher 和自测替身留在构建输出目录。

## 发布输入核对

发布方提供经审定的启用版源码 manifest、同一 Team 的 Developer ID Application 签名和获准分发的 Node／CLI。`afterSign` 根据受审源码 manifest 选择正式核验分支，并核对 `RelayGuardManagementRelease` 中的 Team、构建版本及 Terminal 和 scoped-Core 编译声明。现有开发构建器仍只接受关闭输入。

先对通用 launcher、两架构 Guard addon／dylib 和通用 `RelayNative` 签名，再计算 launcher 大小与 SHA-256 及两份 `guard-host` manifest 的最终哈希。`extra/relay` 中应保留这些已审签名文件、对应宿主 manifest 及 CLI 来源和许可。嵌套签名后字节需要与打包后完全一致。核验要求 App、launcher、Guard addon／dylib 及 `RelayNative` 的实际 Developer ID 签名对应同一 Team，验证各文件的指定 Mach-O 切片，以及 App 已签的 ID、版本、最低系统与资源封印。Node 保留既有上游字节策略，由固定 pin、架构、来源和许可核对。

也可在项目根用 `node --import tsx scripts/relay/verify-bundled-core-pins.ts <Relay.app 的物理绝对路径> <arm64 或 x64>` 对同一成品重新只读核对。签名检查使用 Security.framework 的离线校验。公证、发行和实际运行另有验收。此正式分支只覆盖隔离 Terminal 入口，ES／NE 系统扩展的输入和签名须另行核对。

## 日后启用与恢复

启用操作需要单独明确授权。先记录目标 Apple Terminal profile、shell 实际启动链、当前 `type -a claude` 结果、PATH 顺序及已有别名或函数。在获准的 Apple Terminal 交互 zsh profile 中将 `claude` 明确绑定到验签后的 launcher 绝对路径，可用经验证的 alias 或函数。固定路径不可用时返回 127。绑定不应搜索 PATH 中的下一个同名命令。若 `claude` 已有别名或函数，先记录其内容和优先级，确定可控的恢复方案。

在新开的获准 Terminal 会话内，用 `type -a claude` 及只读路径／签名检查确认首选解析确为该入口。要在 shell 初始化及 Node 版本管理器处理后确认顺序。旧标签页、别名、函数、命令缓存、绝对路径和后续 PATH 变化都可能改变命中。只读检查完成后，先用获准的离线替身验证前台 TTY、取消、继承 FD 和租约失效。真实 CLI 属于后续单独批准的受保护验收。

恢复时先让已启动的受保护会话正常结束，按先前记录撤销目标 profile 的入口变更，按记录恢复原来的 alias、函数和解析顺序。只撤销此次创建且内容仍匹配的绑定。重新打开该 profile 并只读验证 `claude` 的解析回到原先记录。旧 Tab、其他 shell 和当前在用核心各有独立的生命周期。

交互范围从已验证的前台 TTY 启动。管线、重定向、现有 Keychain 登录、外部工作目录写入和代理不兼容工具需要各自的兼容验收。入口认证和源码构建都只是发布准备，实际保护状态以获准运行的租约和验收证据为准。
