# 开发参考文档

> 本文档对齐当前代码库状态（v1.2.0，审计修复后）。如有出入以代码为准。

## 两个运行时环境

ZTmusic 跑在两种环境下，请求链路不同：

| 环境 | 入口 | 请求路径 |
|---|---|---|
| 浏览器开发 | `pnpm dev` | `/ncm-api` → Vite proxy → `https://music.xubuyuan.top` |
| Tauri 桌面 / 移动 | `pnpm tauri:dev` | `invoke('ncm_request')` → `src-tauri/src/lib.rs` → reqwest |

所有网易云接口从 `src/lib/api/client.js` 的 `ncm` 对象发出。`isBrowserDevRuntime()` 和 `isTauriRuntime()` 判断当前走哪条路径。

浏览器开发时，`vite.config.js` 把 `/ncm-api` 代理到后端，规避跨域。Tauri 端走 IPC，由 Rust 用 reqwest 转发，**SSRF 白名单校验在 Rust 端做**（只允许 `music.xubuyuan.top` 等精确匹配的 host，且禁用自动重定向）。

默认请求带 `randomCNIP=true`，cookie 保存在 `api_cookie`。

---

## API 缓存

`src/lib/api/cache-policy.js` 管理 GET 响应缓存：

- `CACHE_TTL` 表定义各端点的 TTL（歌词 7 天、歌单详情 30 分钟、歌曲 URL 不缓存）
- 缓存 key 由 `base + endpoint + params + body + 完整 cookie` 生成（cookie 参与 hash，避免跨账号串数据）
- 存储走 `src/lib/db/cache.js`，优先 SQLite（SQLocal），不可用时降级到 IndexedDB（`utils/dbcache.js`）

---

## 登录链路

`src/lib/stores/auth.svelte.js`，Svelte 5 rune（`$state` / `$effect`）。

**登录方式**：手机号 / 邮箱 / 二维码。成功后 `ncm.setCookie(cookie)`，cookie 持久化到 `api_cookie`。

**cookie 过期检测**：播放拿不到 URL 或只有试听片段时，触发 `auth.checkLoginStatus()`。无效则置 `_cookieOk = false`，**延迟 100ms 后清除登录态**（让 UI 先捕捉到状态变化）。清除前用会话快照二次校验，避免清掉这 100ms 内的新登录。

**二维码轮询**：`startQrPolling` 带幂等保护（新一轮开始前 cancel 旧的）、网络错误指数退避（最多 3 次）、90s 硬超时。

**启动初始化**：`init()` 先 `checkLoginStatus()` 校验 cookie，通过后才 `refreshVipInfo()`，避免失效 cookie 下写入过期 VIP 信息。

---

## 播放链路

### 核心文件

- `src/lib/stores/player.svelte.js` — 播放状态 store
- `src/lib/player/engine.js` — 双 Audio 元素引擎
- `src/lib/player/fallback.js` — URL 遍历状态机
- `src/lib/player/url-resolver.js` — 音质 fallback 链
- `src/lib/player/prefetch.js` — 下一首预取
- `src/lib/player/queue.js` — 播放队列

### 音频引擎（engine.js）

`AudioEngine` 类用**两个 HTMLAudio 元素**：

- `audio` — 当前播放
- `preloadAudio` — 隐藏预加载器

```js
engine.preload(url)        // 后台加载，不播放
engine.swapToPreloaded()   // 零延迟切换（会检查预加载元素健康状态）
engine.load(url)           // 加载新 URL（入口去重：同 URL 直接返回）
```

`load()` 入口加了同 URL 去重，避免 store 重复下发同一 track 时打断播放。`swapToPreloaded()` 在 swap 前检查 `preloadAudio.error` 和 `readyState`，预加载失败时降级到普通 load。

### 音质 fallback 链（url-resolver.js）

```
Phase 1（3.5s 超时）: [standard, higher, 用户偏好] → 首条可用 URL 即播放
Phase 2（5s 超时）:
  1. 用户偏好音质（仅严格更好时升级）
  2. 上述 + unblock
  3. music.163.com 外链
  4. /song/url 老版 API
  5. /song/url/match (UnblockNeteaseMusic)
```

`withTimeout` 用 `Promise.race` + `AbortController`，`.finally(cleanup)` 释放 timer 和 abort listener。所有 `fetchSongUrl` 调用都传 signal，切歌时能中断飞行中的请求。

### 预加载（prefetch.js）

`createPrefetchManager()` 返回 `prefetchNextTrackUrl(options)`：

- 用 `prefetchId` 去重，`songUrl` 返回后复检 `prefetchId === activePrefetchId && !isStale()` 才调 `preload()`
- 避免 await 期间用户切歌，把过期的下一首预加载到 engine

### fallback 控制器（fallback.js）

纯同步状态机，caller 通过 `next()` 返回值决定下一步：

```js
const ctl = createFallbackController(urls)
const r = ctl.next()
if (r.status === 'playing') engine.load(r.url)
// 播放失败时再调 ctl.next()
```

`updateUrls()` 复位到第一个（切歌或 fill 完成），`removeUrl()` 移除失败 URL 并自动调整索引。

### 切歌进度恢复

`player._restoreSeeking` 标志：fallback 切 URL 前若 `currentTime > 0` 则置 `true`，engine `canplay` 时 seek 回原位置。

---

## 状态管理

Svelte 5 rune 模式（`$state` / `$effect` / `$derived`），集中在 `src/lib/stores/`：

| Store | 职责 |
|---|---|
| `auth.svelte.js` | 登录态、cookie、VIP 信息 |
| `player.svelte.js` | 播放状态、队列、fallback |
| `router.svelte.js` | 视图切换（非客户端路由，基于 `activeView` 状态） |

**注意**：`$effect` 的依赖是自动追踪的。写 rune 时注意：
- 纯写 `$state` 不会让 effect 依赖它，只有读才会
- `player.restore()` 用 `untrack` 包裹，避免读到内部 rune 形成循环依赖
- 订阅（如 `responsive.subscribe`）必须在 effect cleanup 里取消

---

## 存储层

三层存储，按优先级降级：

| 层 | 文件 | 用途 |
|---|---|---|
| SQLite（SQLocal） | `db/cache.js` | API 缓存、歌曲 URL 缓存、设置 |
| IndexedDB | `utils/dbcache.js` | SQLite 不可用时的 fallback |
| localStorage | `utils/storage.js` | 简单键值（主题、登录态等） |

**IndexedDB 事务注意**：
- `trimUrlCache` 全程用回调链在同一事务内排队，**不能 await**（否则事务提前 auto-commit，删除来不及执行）
- 过期项由 `dbCleanExpired()` 统一清理，读路径不再嵌套开 readwrite 事务

---

## 调试

```js
localStorage.setItem('debug_playback', 'true')
```

Console 输出 `[play-url:result]` / `[playback:xxx]` 日志。

**播放失败排查**：
1. 确认 `index.html` 保留 `<meta name="referrer" content="no-referrer">`
2. 检查音频 URL 是否为 HTTPS（`normalizePlayUrl()` 自动转换）
3. Network 面板确认无 403/404
4. 检查 `api_cookie` 是否有权限

**Rust 端调试**：`src-tauri/src/api.rs` 的 `ncm_request` 命令处理所有 IPC 请求，SSRF 白名单和重定向策略都在这里。

---

## 构建与发版

```bash
pnpm build                # 前端构建
pnpm tauri:build          # 桌面端安装包（当前平台）
```

**Windows + gnu 工具链的前提**：`tauri-winres` 编译 Windows 资源（图标、版本信息）时要调 `windres`，rustup 自带的 self-contained mingw 里**没有**它。MSYS2 有，但 Git Bash 的 PATH 不含 MSYS2 的 mingw64 目录，所以裸跑 `cargo check` 会在 build script 阶段 panic（`Couldn't to execute windres`）。加进 PATH 即可，不用装东西：

```bash
export PATH="$HOME/.cargo/bin:/c/msys64/mingw64/bin:$PATH"
cargo check                        # 在 src-tauri/ 下跑
```

注意 Windows 主机只编译 `cfg(target_os = "windows")` 分支，`linux_mpris` 那条路径要靠 CI 的 linux job 验证。

**CI**（`.github/workflows/`）：
- `build.yml`：PR / tag `v*` 触发原生构建（Windows `.msi` + Linux `.deb/.rpm`），tag 时发布 GitHub Release。前置的 `version-check` job 只校验三处版本号一致 —— **单元测试不在 CI 跑，推送前本地 `pnpm test` 自己过一遍**。
- `release-prepare.yml`：手动触发，跑 `pnpm verify`（含测试）→ 自动算版本号 → 更新 package.json / Cargo.toml / CHANGELOG → 打 tag → push（commit 带 `[skip ci]` 避免双触发）

---

## 代码风格约定

项目遵循 **"ponytail" 懒 Senior 模式**（见 `.github/copilot-instructions.md`）：

- 动手前先问：真的需要建吗？标准库 / 平台特性 / 已有依赖能解决吗？
- 没有明确请求就不加抽象、不加依赖、不加 boilerplate
- **删减优于添加，无聊优于巧妙，文件越少越好**
- 有意简化必须用 `ponytail:` 注释标注，并说明该简化的已知上限与升级路径
- 非平凡逻辑要留**一个**可运行的检查（assert 自检或一个最小测试文件，不用框架/夹具）
- 不能偷懒的地方：信任边界输入校验、防数据丢失的错误处理、安全、无障碍
