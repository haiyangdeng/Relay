# Relay 发布流程

公开仓库：<https://github.com/haiyangdeng/Relay>。应用版本沿用 1.0.0。同一版本再次发行时创建独立标签，例如 `v1.0.0-build.23`；保留原标签及资产，按架构分别记录实际构建号和对应源码。

## 对应源码与产物

1. 对最终源码完成相关检查、来源和隐私审阅。保留上游许可证、修改补丁、资源清单及构建说明。
2. 使用 `BUILD.md` 的显式构建流程，生成本次更新架构的 App 与一体安装包。继续提供旧架构时，从原正式 Release 下载并比对摘要，使用原文件名和构建号。
3. 核对包内原生组件、内核与信任清单，验证签名、架构、文件与对应源码关系。生成安装包 SHA-256。
4. 运行提交要求的 `pnpm run format:check`、`pnpm run lint:check` 和 `pnpm run typecheck`，通过正常 Git hooks 提交最终源码；不绕过 hooks。
5. 推送源码与对应版本标签，创建 Release，上传 `.pkg` 与 `SHA256SUMS`。确认下载可达且内容摘要一致。
6. 更新 `site/releases.json` 的真实仓库、发布日期、文件名、地址和摘要，并在资源实际上传后标记 `published`。
7. 运行 `.github/workflows/pages.yml` 发布 `site/`，核对线上页面、截图和下载入口。不要把本地预览称为线上发布。

## V1.0.0 文件名

- `Relay-1.0.0-macOS-arm64.pkg`
- `Relay-1.0.0-macOS-x64.pkg`
- `SHA256SUMS`

架构文件名保持稳定，因此 `/releases/latest/download/<文件名>` 在新 Release 标为 Latest 后仍能下载。各发行记录使用含标签的链接固定对应字节。

安装包放在 GitHub Releases，不提交到 Git 源码历史。真实截图由维护者核对无私人订阅、地址或凭据后提交；README 和网站使用同一组文件。

公开内容辅助检查：

```sh
python3 tools/check-public-source.py
```

该脚本只报告位置和类型，不输出疑似秘密值；不能替代人工审阅。

## 如实记录验证范围

分别记录离线检查、产物检查、实际网络与系统操作。发布说明保留未完成的实机验证范围，不能用构建或检查数量代替系统验收结果。本版 ad-hoc 签名、未使用 Developer ID 与 Apple 公证的状态应显示在下载区域。

## TUN 下载范围

Apple Silicon 构建 23 的安装包包含 App、系统代理、TUN 和自动卸载组件，安装时绑定目标 Mac 实际登录用户。发布前必须核对密封 App 的 admission pins、TUN client、双架构 Core、安装／升级／回滚及卸载链，并单独记录真实 TUN 验收结果。保留的 `tun-installer` 开发产物仍绑定构建用户 UID，不作为通用公开下载。Intel 下载沿用构建 2；在 GitHub Release 和站点显示对应构建号。
