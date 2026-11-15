# 构建与发布准备

本仓库是 **V1.0.0** 的对应源码，内部构建号为 **11**。以下流程用于从源码生成本地资源与安装包。打包、安装验收和 GitHub 发布分别记录，不把构建成功视为网络功能实测通过。

## 工具

- macOS 13 或更新版本，普通用户；Xcode Command Line Tools（`xcode-select --install`）。
- Node.js 24 LTS；pnpm **11.8.0**（`package.json` 固定版本）。
- Python 3.11 或更新版本。
- Go **1.26.10**，与 `core-extensions/mihomo-geodata-v1/manifest.json` 的 SDK 版本一致。
- 构建下载使用 HTTPS；依赖仍按原 `pnpm-lock.yaml` 固定。没有复制 `node_modules`、内核二进制或历史 App。

## 检查和开发

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build:relay
python3 scripts/relay/build-public.py --dry-run
```

`prepare` 只安装本地 Git hooks；不会运行原 Clash Party 下载 latest/Alpha/Smart 的准备脚本。`postinstall` 为 Electron 安装其固定依赖，不启动 App、不修改代理。`build:relay` 只构建 main/preload/renderer，不打安装包。日常开发使用 `pnpm dev`，会启动开发 App；需先准备运行资源。

## 资源构建

```sh
python3 scripts/relay/build-public.py resources --execute
```

此命令会下载固定 Mihomo 源码、Go modules 和官方内核，在 `.relay-build/public` 与 `extra/relay` 生成本地构建资源；拒绝覆盖已有这两个输出目录。它不安装组件，不启动 Relay/Claude/Codex，不修改系统网络。

流程：

1. 校验固定源码 archive 摘要和逐文件清单。
2. 叠加 local-geodata 与 provider-file serialization 两套源文件，编译 arm64/amd64 Core 并本地 ad-hoc 签名。
3. 生成匹配新二进制的 `src/main/relay/core/geodata-manifest.json` 与 Swift 内置摘要/测试固定值；运行时哈希校验保持启用。构建后需要 review 这些源码变更，并把该快照作为安装包的对应源码。
4. 按独立官方 manifest 下载并校验官方 Core。
5. 从源码重建 TUN helper/client/uninstaller，更新已启用 capability 的 client/Core 摘要；未启用的 history capability 保持禁用。随后构建 RelayNative、RelayBrowser.app 和只读观察组件；仅包含 `runtimeReady: false` 的 Guard 声明。
6. 收集资源摘要与来源说明，保存在构建目录。不复用任何旧版私有 App、helper 包或本机路径。

两套补丁和许可见 [`core-extensions/SOURCE.md`](../core-extensions/SOURCE.md)。编译使用 `-trimpath`；新构建摘要可能不同于历史自用版。Go/SDK/签名工具差异不应被描述为已经实现逐字节可复现。

## App 与一体安装包

```sh
python3 scripts/relay/build-public.py package --arch arm64 --execute
python3 scripts/relay/build-public.py package --arch x64 --execute
python3 scripts/relay/build-public.py installer --arch arm64 --execute
python3 scripts/relay/build-public.py installer --arch x64 --execute
```

App 中间产物位于 `release/apps.noindex/mac-arm64/Relay.app` 或 `release/apps.noindex/mac/Relay.app`；公开 PKG 仍交付到 `release/` 根目录。同一次 resources 构建可打两种架构。electron-builder 根据请求架构取得 lockfile 固定的 Electron，不引用本机历史 Intel Electron 路径。`afterSign` 会核对双架构 Core、浏览器 wrapper、禁用 Guard 边界及签名完整性；不自动发布。

`.noindex` 用于避免 Spotlight 索引中间 App；Finder 浏览仍可能触发 Launch Services 登记。因此，共用的 `afterSign` 在全部验证通过后，还会核对本次固定 staging 路径、包身份和签名，仅对其中的 RelayBrowser、四个 Electron Helper 和 Relay 主 App 执行定向 `lsregister -u`。未注册路径返回退出码 1 时，只有只读复查确认精确路径已不存在才视为幂等成功；其余失败会中止构建。不重置注册库、不注销其他副本，也不改已安装 App。请勿从中间产物启动应用；之后再用 Finder 浏览这些目录仍可能重新登记。已有旧目录不会被新构建或产品卸载器自动删除。

Installer 从源码生成经过校验的 helper PKG，再将已签名 App 与 helper 安装脚本组合成同一个安装组件。产品版本为 `1.0.0`。安装器固定写入 `/Applications/Relay.app`，发现已有 Relay 应用、组件、运行实例或安装记录时会停止，清理后才可全新安装。重复构建同架构时需先移开原构建输出，第二架构可复用本次通过摘要和源码校验的 helper 构建。

每个 App 会生成对应源码、资源清单及 App 文件/链接/模式的配对回执。installer 阶段再次核对该回执，拒绝把旧的同版本 App 与新的源码或 helper 组合。

### 自动卸载

本版一体安装包在 App 之外安装独立的卸载组件。用户将 `/Applications/Relay.app` 拖入废纸篓后，组件核对 App 文件身份并保存卸载意图；先由安装绑定的普通用户恢复 Relay 管理的配置和关闭专属进程，再移除系统组件、登录项、安装收据及专属数据，最后移除卸载组件自身。

用户数据清理会同步清空 Relay 和 RelayBrowser 的专属偏好域，再删除对应文件，避免只删除磁盘文件却留下偏好缓存。清理清单包括专用浏览器在 `~/Library/Caches/Relay-Preview` 下生成的缓存。应用注册清理限定于本次安装的固定路径、经过身份核对的废纸篓路径及其内置辅助应用；完成前再次检查这些注册已消失。失败时保留卸载进度供重试。另行导出的恢复备份、源码、构建产物和安装包不属于安装数据。

该过程无需另外运行卸载脚本。普通移动或仅原路径缺失不会被直接当作卸载意图。旧版兼容卸载工具仍由构建器生成，新安装存在时会交给自动卸载链，不并行执行旧清理流程。

卸载会删除 Relay 的专属数据，需保留的配置应先导出。外部修改、未确认的进程归属、权限拒绝或恢复失败会保留必要记录。完整 Finder／系统权限／网络恢复链尚未完成本轮实机验收，不能把离线验证描述为系统验收通过。实现与来源见 [`native/uninstall/README.md`](../native/uninstall/README.md)。

### 可选 TUN 本机安装包

```sh
python3 scripts/relay/build-public.py tun-installer --dry-run
# 仅在完成上述资源构建后，单独生成：
python3 scripts/relay/build-public.py tun-installer --execute
```

复用已有 managed TUN 打包器，检查编译输入、Core/Client 摘要、签名、包内清单和 BOM；不会安装。该现有安装包会绑定**构建用户 UID**，仅供该用户本机使用，不得当作面向任意用户的通用 GitHub 下载。它与 App + 系统代理安装包分开；无需 TUN 的使用不受影响。已安装的旧 TUN 配对不能自动视作新构建可用，须使用匹配的组件并按既有恢复流程处理。源码中保留完整 TUN 功能和构建入口。

保留应用内部 ID `local.relay.network.preview` 是为了与现有配置及安全绑定兼容，不影响显示版本 1.0.0。当前默认是 **ad-hoc 签名，无 Developer ID、公证**；源码公开不等于 Apple 公证。系统代理管理员组件安装仍需 macOS 授权。

## 发布验证

V1.0.0 已生成 Apple Silicon 与 Intel 安装包，完成针对性退出／卸载离线回归、独立审阅及包内资源和签名一致性检查。实际网络行为、系统权限和完整卸载链的实机验收仍需单独记录。

从干净检出重建时，应保留本次对应源码快照、工具版本、资源摘要、展开的 Installer 检查结果和安装包 SHA256SUMS。不同 SDK、Go 或签名工具的输出不应被描述为已经逐字节可复现。发布步骤见 [`RELEASING.md`](RELEASING.md)。
