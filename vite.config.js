import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import https from 'node:https'

const PROXY_TARGET = 'https://music.xubuyuan.top'
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 25000,
  rejectUnauthorized: true,
})
// 禁用 Node.js 全局代理，避免走系统代理
process.env.NO_PROXY = '*'
process.env.no_proxy = '*'
process.env.HTTP_PROXY = ''
process.env.http_proxy = ''
process.env.HTTPS_PROXY = ''
process.env.https_proxy = ''

// Tauri 的 WebView 通过自定义协议加载资源，带 crossorigin 的 module 脚本/样式
// 会因 CORS 被拦截，导致只显示未渲染的裸 HTML。此插件移除 crossorigin 属性。
// - transformIndexHtml：处理 index.html 里的静态入口标签
// - generateBundle：处理 Vite 预加载 helper 运行时动态注入的 <link>/<script>
//   将所有 `.crossOrigin=''` 改成 `.crossOrigin=null` 即不写入该属性，
//   同时不影响封面取色用的 `crossOrigin="anonymous"`。
const stripCrossorigin = () => ({
  name: 'strip-crossorigin',
  transformIndexHtml(html) {
    return html.replace(/\s+crossorigin(=["'][^"']*["'])?/gi, '')
  },
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== 'chunk') continue
      // 匹配所有 crossOrigin 空字符串赋值（预加载 helper、Svelte 动态注入等）
      // 覆盖：= '', = "", = ``, ='' , ="" , =``
      file.code = file.code.replace(/\.crossOrigin\s*=\s*(["'`])\1\s*(?=[,;\n)])/g, '.crossOrigin=null')
      // 额外处理可能的属性设置
      file.code = file.code.replace(/setAttribute\s*\(\s*(["'`])crossorigin\1\s*,\s*(["'`])\2\s*\)/g, '')
    }
  },
})

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    // 禁用 CSS 动态注入和 modulepreload：动态注入的 <link>/<script> 会自带 crossorigin，
    // 在 Tauri 自定义协议下被 CORS 拦截（与上面的 stripCrossorigin 配套）。
    // ponytail: target 'chrome100' 原是为兼容 Android WebView（minSdk 24）而压低的。
    // 安卓端已放弃，桌面端 WebView2 是 evergreen、能吃更高的 target；但 Linux 的
    // WebKitGTK 不是 Chromium，抬高 target 需要 Windows + Linux 两端实机验证，暂不动。
    target: 'chrome100',
    cssCodeSplit: false,
    modulePreload: false,
    // sql.js WASM 文件不能内联，必须作为独立资源加载
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // 确保 WASM 使用可缓存的文件名格式
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [
    svelte(),
    stripCrossorigin(),
  ],
  resolve: {
    alias: {
      '@': '/src'
    }
  },
  server: {
    hmr: {
      protocol: 'ws',
      host: 'localhost',
    },
    watch: {
      usePolling: false,
      interval: 100,
    },
    proxy: {
      '/ncm-api': {
        target: PROXY_TARGET,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/ncm-api/, ''),
        timeout: 25000,
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            console.error('[proxy] error:', err.message, req.url)
            try {
              if (!res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ code: 503, msg: 'Proxy upstream error' }))
              }
            } catch {}
          })
        },
        agent: httpsAgent,
        headers: { Connection: 'keep-alive' },
        followRedirects: true,
      },
      '/user': {
        target: PROXY_TARGET,
        changeOrigin: true,
        secure: true,
        timeout: 25000,
        agent: httpsAgent,
        headers: { Connection: 'keep-alive' },
      },
      '/api': {
        target: PROXY_TARGET,
        changeOrigin: true,
        secure: true,
        timeout: 25000,
        agent: httpsAgent,
        headers: { Connection: 'keep-alive' },
      },
    }
  },
  optimizeDeps: {
    force: false,
  },
  clearScreen: false,
})
