import assert from 'node:assert/strict'

globalThis.$state = (value) => value
globalThis.window = { __TAURI_INTERNALS__: {} }
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    platform: 'Win32',
  },
})

const { shouldUseNativeBridge, shouldUseWebMediaSession } = await import('./native-media.js')

assert.equal(shouldUseNativeBridge(), false, 'Windows Tauri should not create a second native media session')
assert.equal(shouldUseWebMediaSession(), true, 'Windows Tauri should reuse WebView2 Web Media Session')

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
  },
})
assert.equal(shouldUseNativeBridge(), true, 'Linux Tauri should keep the native MPRIS bridge')
assert.equal(shouldUseWebMediaSession(), false, 'Linux Tauri should not register a duplicate Web Media Session')

window.__TAURI_INTERNALS__ = null
assert.equal(shouldUseNativeBridge(), false, 'regular browser runtime should not use the native bridge')
assert.equal(shouldUseWebMediaSession(), true, 'regular browser runtime should keep Web Media Session enabled')

console.log('native media routing tests passed')
