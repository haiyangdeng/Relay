# Relay 发布流程

公开仓库：<https://github.com/haiyangdeng/Relay>。版本标签使用 `v1.0.0` 形式；App 显示版本、Release 标签与网站版本清单保持一致，内部构建号单独记录。

## 对应源码与产物

1. 对最终源码完成相关检查、来源和隐私审阅。保留上游许可证、修改补丁、资源清单及构建说明。
2. 使用 `BUILD.md` 的显式构建流程，生成 Apple Silicon 与 Intel App 和一体安装包。不要把旧开发版安装包改名充当新版本。
3. 核对包内原生组件、内核与信任清单，验证签名、架构、文件与对应源码关系。生成安装包 SHA-256。
4. 运行提交要求的 `pnpm run format:check`、`pnpm run lint:check` 和 `pnpm run typecheck`，通过正常 Git hooks 提交最终源码；不绕过 hooks。
5. 推送源码与对应版本标签，创建 Release，上传 `.pkg` 与 `SHA256SUMS`。确认下载可达且内容摘要一致。
6. 更新 `site/releases.json` 的真实仓库、发布日期、文件名、地址和摘要，并在资源实际上传后标记 `published`。
7. 运行 `.github/workflows/pages.yml` 发布 `site/`，核对线上页面、截图和下载入口。不要把本地预览称为线上发布。

## V1.0.0 文件名

- `Relay-1.0.0-macOS-arm64.pkg`
- `Relay-1.0.0-macOS-x64.pkg`
- `SHA256SUMS`

安装包放在 GitHub Releases，不提交到 Git 源码历史。真实截图由维护者核对无私人订阅、地址或凭据后提交；README 和网站使用同一组文件。

公开内容辅助检查：

```sh
python3 tools/check-public-source.py
```

该脚本只报告位置和类型，不输出疑似秘密值；不能替代人工审阅。

## 如实记录验证范围

分别记录离线检查、产物检查、实际网络与系统操作。发布说明保留未完成的实机验证范围，不能用构建或检查数量代替系统验收结果。本版 ad-hoc 签名、未使用 Developer ID 与 Apple 公证的状态应显示在下载区域。

## TUN 下载范围

现有独立 TUN 管理组件安装包绑定构建用户 UID，仅适用于相应本机构建场景。在实现通用安装身份流程之前，不将它放入面向任意用户的公开下载。App 与系统代理管理员组件的一体包是独立产物。
