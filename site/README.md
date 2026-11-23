# Relay 介绍与下载页

纯静态中文页面，无构建依赖、统计脚本、外部字体或 CDN。页面展示实际应用截图，不使用手绘软件界面或虚构网络读数。

- 线上地址：<https://haiyangdeng.github.io/Relay/>
- 对应仓库：<https://github.com/haiyangdeng/Relay>
- 当前发布：<https://github.com/haiyangdeng/Relay/releases/latest>
- 历史版本：<https://github.com/haiyangdeng/Relay/releases/tag/v1.0.0>

## 本地预览

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

打开 `http://127.0.0.1:4173`。使用 HTTP 预览，以便浏览器读取版本 JSON；无需 npm 构建。

## 截图与图标

`assets/app-icon.png` 使用本次打包的实际 Relay 图标。`assets/screenshots/overview.png` 与 `configuration.png` 使用运行中的 macOS 应用实拍；仓库 README 使用 `docs/assets/screenshots/` 中的同一组截图。替换时同时更新两处，保持字节一致，并核对截图内不含私人订阅、地址或凭据。素材来源说明保留在 `docs/ASSETS.md`。

## 下载清单

`releases.json` 管理发行标签（不含 v 前缀）、发布日期、架构、文件名、下载 URL 与 SHA-256。同一应用版本的不同发行记录按日期区分；每张下载卡显示该架构资产的实际构建号。早期两个架构共用构建号的记录沿用发行级 buildVersion。下载仅在版本为 `published` 且同仓库 Release URL、文件名及摘要全部匹配时开放。JSON 不可用或数据无效时关闭动态入口；无 JavaScript 的访客仍可通过 GitHub Release 链接下载。

更新版本时先上传 Release 安装包并核对远端资源，再将已验证的数据写入清单。不能仅靠本地校验声称远端资源已可访问。

## GitHub Pages

使用仓库的 `.github/workflows/pages.yml`，部署目录为 `site/`，安装包存放在 GitHub Releases，不进入 Pages 构建产物。仓库 Pages 来源选择 GitHub Actions，然后运行 `Publish introduction site (manual)` 工作流。工作流成功及公开页面可访问后，才算完成网页部署。

此页面沿用根目录 GPL-3.0 许可，保留 Clash Party 与 Mihomo 归属。页面不宣称系统级进程防直连或 Apple 公证。
