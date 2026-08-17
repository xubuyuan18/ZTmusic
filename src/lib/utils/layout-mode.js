import { getSetting, setSetting } from './settings.js'

export const LAYOUT_MODE_KEY = 'layout_mode'

export function getLayoutMode() {
  return getSetting(LAYOUT_MODE_KEY, 'auto')
}

export function setLayoutMode(value) {
  const mode = setSetting(LAYOUT_MODE_KEY, value)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('layout-mode-change', { detail: mode }))
  }
  return mode
}

/** URL 带 ?mobile 时强制手持端布局（调试用），供各处统一判定 */
export function isForcedMobileParam() {
  const search = typeof window !== 'undefined' ? window.location?.search : ''
  return !!search && new URLSearchParams(search).has('mobile')
}

export function shouldUseMobileLayout(width, height, mode = getLayoutMode()) {
  // URL 调试参数优先级最高，即使用户设置了 pc 也强制手持端布局
  if (isForcedMobileParam()) return true

  // 用户显式设置
  if (mode === 'mobile') return true
  if (mode === 'pc') return false

  // auto 模式：优先判定触摸设备，再参考短边
  // 注意：PC 浏览器窗口较矮时，短边可能 <600，不应误判为移动端
  // 所以需要结合触摸设备判定，或者放宽条件
  const shortSide = Math.min(width || 0, height || 0)
  const hasTouch = typeof window !== 'undefined' && typeof navigator !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  // 触摸设备 + 短边 <= 720 → 移动端
  // 非触摸设备(PC 鼠标) → 永远 PC 布局，除非用户手动设置
  if (hasTouch) {
    return shortSide > 0 && shortSide <= 720
  }
  // PC 鼠标环境：即使窗口矮，也不自动判定移动端
  // 只有短边极小（比如开发者工具全屏）时才认为是移动端调试
  return shortSide > 0 && shortSide <= 420
}

// ==========================================
// 响应式布局 store — 全局唯一真相源
// ==========================================

const isBrowser = typeof window !== 'undefined'

/**
 * 创建全局响应式布局状态 store
 * 唯一监听 resize/orientationchange/layout-mode-change 事件
 */
function createLayoutModeStore() {
  if (!isBrowser) {
    return {
      subscribe: (fn) => {
        fn({ isMobile: false, width: 0, height: 0, mode: 'auto' })
        return () => {}
      }
    }
  }

  let current = {
    isMobile: shouldUseMobileLayout(window.innerWidth, window.innerHeight),
    width: window.innerWidth,
    height: window.innerHeight,
    mode: getLayoutMode()
  }

  const subscribers = new Set()

  function update() {
    const mode = getLayoutMode()
    const isMobile = shouldUseMobileLayout(window.innerWidth, window.innerHeight, mode)
    if (isMobile !== current.isMobile ||
        window.innerWidth !== current.width ||
        window.innerHeight !== current.height) {
      current = { isMobile, width: window.innerWidth, height: window.innerHeight, mode }
      subscribers.forEach(fn => fn(current))
    }
  }

  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  window.addEventListener('layout-mode-change', update)

  // 启动时多次校验，确保窗口尺寸就绪
  const scheduleUpdate = (ms) => setTimeout(update, ms)
  window.addEventListener('DOMContentLoaded', () => scheduleUpdate(50))
  scheduleUpdate(200)
  scheduleUpdate(500)

  return {
    subscribe(fn) {
      fn(current)
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }
  }
}

/** 全局响应式布局状态（唯一实例） */
export const layoutMode = createLayoutModeStore()