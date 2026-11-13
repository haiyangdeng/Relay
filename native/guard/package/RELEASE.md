# Relay ES／NE 发布打包

系统扩展由发布方编译和签名。为同一 Team 准备经过审核的发布源码和签名材料。两份扩展清单、编译进原生组件的版本和 Team、扩展 Info.plist 中的 Mach 服务名，以及签名后资源哈希须相互匹配。开发构建器产出的组件用于离线验证。发布源码与产物应保存在独立的发布目录中。

以下输入均使用物理绝对路径。

- `BASE_APP` 是已经用同一 Team 的 Developer ID Application 签名并封存的 `Relay.app`。基础 App 中的 Electron 嵌套代码保持签名，尚未放入 Guard 宿主或系统扩展。
- `SOURCE` 是与基础 App 对应的发布源码。`extra/relay` 包含签名后的通用 `RelayNative`、ARM64 和 Intel 的 Guard addon／dylib，以及对应的最终摘要清单。
- `COMPONENTS` 只包含本次架构经过签名的两份 `.systemextension`，文件名按扩展 bundle ID 固定。分别为 `arm64` 和 `x86_64` 准备目录。
- `STAGING_PARENT` 是发布方拥有、已经存在且其他用户不可写的私有输出目录。

从项目目录运行下列命令。脚本复制基础 App 和固定的签名资源，将扩展置入 `Contents/Library/SystemExtensions`，并生成外层 App 的合并权限文件。原始输入保留。输出的 `app` 与 `hostEntitlements` 字段给出本次路径。旧的 ad-hoc 构建入口保持独立，Terminal 启动器使用它自己的发布验证。

```sh
python3 scripts/relay/stage-guard-extension-package.py \
  --base-app "$BASE_APP" --source-root "$SOURCE" \
  --signed-components "$COMPONENTS" --architecture arm64 \
  --output-parent "$STAGING_PARENT"
```

发布方完成授权签名后，使用同一组输入校验外层封印。只重新签名 `STAGED_APP` 外层，已签名的扩展和宿主资源保持原字节。`SIGNING_IDENTITY` 是对应 Team 已获准使用的 Developer ID Application 身份。`ENTITLEMENTS` 指向暂存脚本生成的文件。

```sh
codesign --force --sign "$SIGNING_IDENTITY" --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" "$STAGED_APP"

python3 scripts/relay/verify-guard-extension-package.py \
  --app "$STAGED_APP" --source-root "$SOURCE" \
  --signed-components "$COMPONENTS" --architecture arm64
```

Intel 产物使用 `x86_64`。离线校验成功仅表示签名、架构、权限及资源配对通过。公证、安装授权和实际网络保护分别验收。
