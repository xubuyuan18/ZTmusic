# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

**ZTmusic（哲听）** —— 一个简洁、安静的网易云音乐第三方跨平台桌面客户端。基于 Svelte 5 + Tauri 2 构建，支持 Windows / Linux / Web。

> ⚠️ 仅供个人学习与技术交流，音乐数据来自第三方 API，版权归网易云音乐及版权方。

## 常用命令

```bash
pnpm install              # 安装依赖（使用 pnpm，有 pnpm-lock.yaml）
pnpm dev                  # 浏览器端开发（Vite，默认走 /ncm-api 代理）
pnpm tauri:dev            # 桌面端开发（Tauri）
pnpm build                # 前端构建
pnpm tauri:build          # 构建当前平台安装包
pnpm test                 # 运行全部单元测试
pnpm verify               # = pnpm check:versions + pnpm test + pnpm build
```

**运行单个测试**：本项目没有测试框架，测试是独立的 `node` 脚本，直接运行单个文件即可：

```bash
node src/lib/player/fallback.test.js
```

退出码 0 = 通过，1 = 失败。测试风格：自包含的 assert + 控制台汇总，见 `src/lib/player/fallback.test.js`。

**API 默认地址**：`https://music.xubuyuan.top`，浏览器开发时由 Vite 代理转发（规避跨域），桌面端走 Tauri IPC。

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Svelte 5 + Vite 8 |
| 桌面端 | Tauri 2 + Rust |
| 音频 | HTML5 Audio（双缓冲预加载） |
| 本地存储 | IndexedDB / SQLocal |
| API | NeteaseCloudMusicApi Enhanced |

## 架构概览

### 前端（`src/`）

- **路由与布局**：`src/App.svelte` 是根组件，基于 `router.activeView` 状态做条件渲染（`#if}/{:else if}` 链），不是客户端路由。`isMobileRuntime()` 决定走 PC 布局（`Sidebar + MainArea + PlayerBar`）还是移动布局（`MobileApp`）。
- **状态管理**：`src/lib/stores/` 下用 Svelte 5 rune（`$state` / `$effect`）—— `auth`（登录态）、`player`（播放状态）、`router`（视图切换）。
- **API 层**：`src/lib/api/client.js` 导出 `ncm` 对象。浏览器开发走 `/ncm-api` → Vite proxy；Tauri 桌面走 `invoke('ncm_request')` → `src-tauri/src/lib.rs` → reqwest。缓存策略在 `cache-policy.js`。
- **播放链路**：`stores/player.svelte.js` + `player/engine.js`。`engine.js` 用**双 Audio 元素**实现预加载（`preload` 隐藏加载 → `swapToPreloaded` 零延迟切换）。音质 fallback 链在 `player/fallback.js`（Phase 1 标准/高清/用户偏好 → Phase 2 逐步降级到 unblock / 外链 / 老 API / match）。
- **页面**：`src/lib/pages/pc/` 与 `pages/mobile/` 分开；通用页面（歌单、歌手、搜索）在 `pages/` 根下。
- **i18n**：`src/lib/i18n/`（`zh.js` / `en.js`）。
- **持久化**：`src/lib/db/`（IndexedDB 缓存、播放历史、设置）。

### 桌面原生（`src-tauri/`）

Rust 端，关键模块：
- `lib.rs` / `api.rs`：处理前端 `ncm_request` IPC 调用（reqwest 转发）
- `windows_smtc.rs`：Windows 系统媒体控制（SMTC）
- `linux_mpris.rs`：Linux MPRIS 媒体控制
- `media_playback.rs` / `media_metadata.rs`：播放与元数据
- `pending_action.rs`：待处理动作队列

### 调试

```js
localStorage.setItem('debug_playback', 'true')  // Console 输出 [play-url:result] / [playback:xxx]
```

播放失败排查：确认 `index.html` 有 `<meta name="referrer" content="no-referrer">`；音频 URL 需 HTTPS（`normalizePlayUrl()` 自动转）；Network 面板查 403/404；`api_cookie` 权限。

## 开发约定（来自 [`.github/copilot-instructions.md`](.github/copilot-instructions.md)）

项目采用 **"ponytail" 懒Senior 模式**：

- 动手前先问：真的需要建吗？标准库/平台特性/已有依赖能解决吗？能一行写就别多写。
- 没有明确请求就不加抽象、不加依赖、不加 boilerplate。
- **删减优于添加，无聊优于巧妙，文件越少越好。**
- 对复杂需求要敢于反问"真的需要 X 吗，Y 行不行？"
- 有意简化必须用 `ponytail:` 注释标注，并说明该简化的已知上限与升级路径。
- **不能偷懒的地方**：信任边界输入校验、防数据丢失的错误处理、安全、无障碍、硬件校准。
- 非平凡逻辑要留**一个**可运行的检查（assert 自检或一个最小测试文件，不用框架/夹具）。一行逻辑不用测。

## 文档

- 详细架构与调试：[`docs/development.md`](docs/development.md)
- 发版流程：GitHub Actions（`release-prepare.yml` → 打 tag → `build.yml` 构建 `.deb/.rpm/.msi`）
