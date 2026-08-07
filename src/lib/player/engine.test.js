import assert from 'node:assert/strict'

class FakeAudio {
  constructor() {
    this.preload = ''
    this.src = ''
    this.currentSrc = ''
    this.currentTime = 0
    this.duration = 180
    this.ended = false
    this.networkState = 1
    this.readyState = 1
    this.paused = true
    this.error = null
    this.volume = 1
    this._listeners = new Map()
  }

  addEventListener(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(handler)
  }

  removeEventListener(event, handler) {
    this._listeners.get(event)?.delete(handler)
  }

  dispatch(event, payload = {}) {
    for (const handler of this._listeners.get(event) || []) handler(payload)
  }

  play() {
    this.paused = false
    this.dispatch('play')
    return Promise.resolve()
  }

  pause() {
    if (this.paused) return
    this.paused = true
    this.dispatch('pause')
  }

  load() {}

  removeAttribute(name) {
    if (name === 'src') this.src = ''
  }

  canPlayType() {
    return 'probably'
  }
}

globalThis.Audio = FakeAudio

const { engine } = await import('./engine.js')

const calls = []
const removeFirst = engine.onPlay(() => calls.push('first'))
engine.onPlay(() => calls.push('second'))

await engine.play()
assert.deepEqual(calls, ['first', 'second'], 'all play listeners should run')

removeFirst()
engine.pause()
await engine.play()
assert.deepEqual(calls, ['first', 'second', 'second'], 'unsubscribe should remove only one listener')

engine.destroy()
console.log('engine event subscription tests passed')
