# Claude 严格系统过滤：源码准备

用户于 2026-10-27 确认：桌面和 CLI 仅允许连接受控本机代理，其余公网、内网及本机端口均禁止直连。产品须免费、可直接安装，使用者无需开发者账号、证书或自行编译；当前只做源码和隔离验证。

签名、权限资源、公证与成品封装由发布方负责，不增加用户购买／导入证书或开发者模式步骤，也不引入付费防火墙、签名服务或订阅作为使用条件。普通安装所需管理员和系统过滤授权仍须由用户确认。当前部署组件尚未完成，不能据此宣称已有可安装的系统级保护成品。

本目录是独立于现有 App 的 P6 源码基础。它不在现有 RelayNative／Electron 构建入口中，不修改现有 Claude、Clash 或系统设置。

- `RelayGuardPolicy.swift`：严格身份分类与纯流量决策。默认代理许可为空；已识别的受保护身份、无效的受保护签名及无法解析的身份不能直接联网。
- `RelayGuardIdentity.swift`：从系统 audit token 只读取得签名并验证身份；隔离测试注入身份观察，不访问账号、密钥或流量内容。
- `RelayGuardFilterDataProvider.swift`：NetworkExtension 元数据桥。当前 `startFilter` 明确拒绝启动，不应用规则，没有可安装扩展包或激活入口。
- 对应测试覆盖身份边界、系统代发归属合并、TCP／UDP、IPv4／IPv6、内网、回环及默认拒绝；构建测试同时编译 ARM 与 Intel，只在当前主机架构执行注入测试。

运行：

```sh
python3 scripts/relay/test-guard-source.py --report ../evidence/strict-guard-source-verification.json
```

只有隔离测试可以注入代理许可；这不是监听进程身份或可信代理会话的证明，Provider 不接受这些测试许可。未解析身份的拒绝可能影响其他无法归属的程序，因此也不能未经实机归属验证就启用该策略。

尚未实现的交付条件包括正式扩展封装／签名、系统授权管理、可信代理绑定协议、旧 npm/Node CLI 与工具子进程覆盖、已有连接及过滤器故障时持续阻断。不能因为原生 CLI 身份测试通过就称所有 CLI 都已保护；也不能把这些源码测试当作系统运行时保证。

详细范围见 [严格需求记录](../../../audit/claude-system-guard-requirements.md)。
