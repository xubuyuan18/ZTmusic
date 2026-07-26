# ZTmusic（哲听）

一个网易云音乐第三方客户端，界面安静，专注听歌。用 Svelte 5 + Tauri 2 写的，跑在 Windows / Linux / Android / Web 上。

> ⚠️ 本项目仅供个人学习与技术交流。音乐数据来自第三方 API，版权归网易云音乐及各版权方。请勿用于商业用途。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Svelte](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri)

---

## 这是啥

哲听是一个干净、轻量的网易云音乐桌面端。没有广告，没有花里胡哨的社交功能，就是听歌。

最初是想给自己做一个安静的听歌工具，后来顺手支持了 Android 和 Linux。API 基于 [NeteaseCloudMusicApi Enhanced](https://github.com/NeteaseCloudMusicApiEnhanced)，默认后端是 `https://music.xubuyuan.top`。

## 能干什么

**登录**：二维码 / 手机号 / 邮箱，登录态持久化。

**浏览**：发现页、歌单、歌手主页、资料库、最近播放、历史日推。

**播放**：全屏歌词、播放队列、多音质切换（VIP/试听自动回退）、下一首预加载、IndexedDB 缓存、歌曲收藏。桌面端还接了系统媒体控制（Windows SMTC / Linux MPRIS）。

**外观**：深色 / 浅色，中文 / 英文，桌面端窗口状态记忆、单实例运行。

## 支持的平台

| 平台 | 包格式 | 状态 |
|---|---|---|
| Windows | `.exe`（NSIS） | ✅ |
| Linux | `.deb` / `.rpm` | ✅ |
| Android | `.apk` | ✅ |
| Web | 浏览器直开 | ✅ |

> macOS / iOS 没有预构建包，可以自己跑 `pnpm tauri:build` 编。

## 快速开始

需要 Node.js 22+ 和 Rust 工具链。包管理器用 pnpm（`corepack enable` 即可）。

```bash
pnpm install              # 装依赖
pnpm dev                  # 浏览器开发（Vite，默认走 /ncm-api 代理）
pnpm tauri:dev            # 桌面端开发（Tauri）
pnpm build                # 前端构建
pnpm tauri:build          # 构建当前平台安装包
pnpm test                 # 跑单元测试（12 个脚本，纯 node 无框架）
```

浏览器开发时，`/ncm-api` 会被 Vite 代理到后端，不用操心跨域。桌面端走 Tauri IPC 直接发请求。

跑单个测试：`node src/lib/player/fallback.test.js`，退出码 0 = 过，1 = 挂。

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Svelte 5 + Vite |
| 桌面 / 移动 | Tauri 2 + Rust |
| 音频 | HTML5 Audio（双缓冲预加载） |
| 本地存储 | IndexedDB / SQLocal |
| API | NeteaseCloudMusicApi Enhanced |

前端依赖很少：`@tauri-apps/api`、`qrcode`（二维码登录）、`sqlocal`（本地 SQLite）。

## 项目结构

```
ZTmusic/
├── src/                  # 前端源码（Svelte 5）
│   ├── App.svelte         # 根组件：路由、布局、overlay
│   ├── lib/
│   │   ├── api/           # API 客户端 + 缓存策略
│   │   ├── components/    # UI 组件（播放器、overlay、侧栏……）
│   │   ├── pages/         # 页面（PC / 移动分开）
│   │   ├── player/        # 音频引擎 + fallback 链
│   │   ├── stores/        # 状态管理（auth / player / router）
│   │   ├── services/      # 数据加载
│   │   └── utils/         # 工具函数
│   └── assets/
├── src-tauri/            # Tauri / Rust
│   ├── src/               # Rust 端：ncm_request IPC、SMTC、MPRIS
│   ├── android-src/       # Android 原生插件
│   ├── capabilities/      # Tauri 权限配置
│   └── icons/
├── public/               # 静态资源（SVG 图标）
├── docs/                 # 开发文档
├── .github/workflows/    # CI：build（四端）+ prepare-release
├── index.html
├── vite.config.js        # Vite + /ncm-api 代理
├── svelte.config.js
├── jsconfig.json
├── package.json          # 包名 zheting，当前 v1.3.0
└── pnpm-lock.yaml
```

> 包名 `zheting` 和仓库名 `ZTmusic` 不一致——`ZT` 是"哲听"的缩写，`zheting` 是拼音。历史遗留，暂时没改。

## 构建与发版

本地构建：`pnpm tauri:build`（桌面端）或 `pnpm tauri android build --apk --target aarch64`（Android）。

发版走 GitHub Actions：

1. 手动触发 **Prepare Release** workflow，选版本号策略（auto / patch / minor / major）
2. 它会自动：算下一版本号 → 更新 package.json / Cargo.toml / CHANGELOG.md → 打 tag → push
3. push tag（`v*`）触发 **Build Installers**，并行构建 Windows / Linux / Android / Web
4. 构建完自动发布到 GitHub Releases，release notes 从 CHANGELOG 抽

Android 签名密钥配在仓库 Secrets（`ANDROID_KEY_BASE64` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` / `ANDROID_STORE_PASSWORD`），没配的话会构建 unsigned APK。

详细的架构说明、API 链路、调试技巧见 [`docs/development.md`](docs/development.md)。

## 许可证

[MIT](./LICENSE)
