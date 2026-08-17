# ZTmusic 桌面端适配现状

原文是对照 Tauri 2 Android 官方模板写的多平台研究报告。2026-08 放弃安卓端后，只保留仍然成立的 Windows / Linux / Web 部分。

---

## 一、各平台现状

### Windows

| 项 | 状态 |
|---|---|
| SMTC（系统媒体传输控制） | ✅ `src-tauri/src/windows_smtc.rs` + `windows` crate |
| NSIS 安装包（简体中文 + installer hooks） | ✅ `tauri.conf.json` 的 `bundle.windows.nsis` |
| WebView2 安装模式 | ⚠️ 未配置 `webviewInstallMode`，建议 `downloadBootstrapper`（现代 Windows 已内置 WebView2） |

### Linux

| 项 | 状态 |
|---|---|
| MPRIS 媒体控制 | ✅ `src-tauri/src/linux_mpris.rs` + `mpris-server` crate |
| `.deb` / `.rpm` 打包 | ✅ `pnpm tauri:build:linux` |

### Web

- Vite 纯前端构建（`pnpm build` → `dist/`），API 走 `/ncm-api` 代理
- 未部署；如需公网访问，建议 Cloudflare Pages / GitHub Pages 单独部署
- 手机浏览器访问走移动端布局（`pages/mobile/`），这套布局**保留**，与已放弃的安卓打包无关

---

## 二、待办

| 优先级 | 项 | 说明 |
|---|---|---|
| P1 | WebView2 `downloadBootstrapper` | 减小安装包体积，缺 WebView2 的旧机器自动下载 |
| P2 | tauri updater | 桌面端自动更新，需要签名密钥与更新服务器 |

版本号三处一致（`package.json` / `Cargo.toml` / `tauri.conf.json`）由 `pnpm check:versions` 校验，已并入 `pnpm verify`。

---

## 三、关键文件索引

| 文件 | 作用 |
|---|---|
| `src-tauri/src/windows_smtc.rs` | Windows 系统媒体控制 |
| `src-tauri/src/linux_mpris.rs` | Linux MPRIS |
| `src-tauri/Cargo.toml` | Rust 依赖 + 编译优化 |
| `src-tauri/tauri.conf.json` | Tauri 配置 + 版本号 |
| `src/lib/player/native-media.js` | 前端 ↔ 原生桥接（现仅 Linux MPRIS 走此桥，Windows 用 Web Media Session） |
| `.github/workflows/build.yml` | CI/CD 构建流程 |

---

## 四、链接汇总

| 资源 | 链接 |
|---|---|
| Tauri 2 官方文档 | https://v2.tauri.app/ |
| Tauri IPC 通信 | https://v2.tauri.app/concept/inter-process-communication/ |
| Tauri Updater | https://v2.tauri.app/distribute/updater/ |
| Tauri WebView2 分发 | https://v2.tauri.app/distribute/windows-installer/ |
