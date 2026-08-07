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

assert.equal(shouldUseNativeBridge(), true, 'Windows Tauri should use the native media bridge')
assert.equal(shouldUseWebMediaSession(), false, 'Windows Tauri should not register a duplicate Web Media Session')

window.__TAURI_INTERNALS__ = null
assert.equal(shouldUseNativeBridge(), false, 'regular browser runtime should not use the native bridge')
assert.equal(shouldUseWebMediaSession(), true, 'regular browser runtime should keep Web Media Session enabled')

console.log('native media routing tests passed')
