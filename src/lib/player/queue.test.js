/**
 * Queue index self-check（重点是 shuffle 指针语义）。
 * Run: node src/lib/player/queue.test.js
 * Status code: 0 = pass, 1 = fail.
 */

import { getNextIndex, getPrevIndex, commitNextIndex } from './queue.js'

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) { passed++ } else { console.error('FAIL:', msg); failed++ }
}

function assertEqual(a, b, msg) {
  if (a === b) { passed++ } else { console.error(`FAIL: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); failed++ }
}

function freshState() {
  return { order: [], position: -1 }
}

// ── 空队列 ──
{
  assertEqual(getNextIndex({ currentIndex: 0, queueLength: 0, mode: 'list' }), -1, 'empty queue next = -1')
  assertEqual(getPrevIndex({ currentIndex: 0, queueLength: 0 }), -1, 'empty queue prev = -1')
}

// ── list 模式环绕 ──
{
  assertEqual(getNextIndex({ currentIndex: 0, queueLength: 3, mode: 'list' }), 1, 'list next')
  assertEqual(getNextIndex({ currentIndex: 2, queueLength: 3, mode: 'list' }), 0, 'list next wraps')
  assertEqual(getPrevIndex({ currentIndex: 0, queueLength: 3 }), 2, 'prev wraps')
  assertEqual(getPrevIndex({ currentIndex: 2, queueLength: 3 }), 1, 'prev')
}

// ── repeat 模式停在原地 ──
{
  assertEqual(getNextIndex({ currentIndex: 1, queueLength: 3, mode: 'repeat' }), 1, 'repeat stays')
}

// ── 回归：shuffle 下 peek 幂等（曾因预取推进指针导致隔一首跳歌）──
{
  const shuffleState = freshState()
  const first = getNextIndex({ currentIndex: 0, queueLength: 6, mode: 'shuffle', shuffleState })
  const again = getNextIndex({ currentIndex: 0, queueLength: 6, mode: 'shuffle', shuffleState })
  const third = getNextIndex({ currentIndex: 0, queueLength: 6, mode: 'shuffle', shuffleState })
  assertEqual(again, first, 'shuffle peek 幂等：预取与切歌看到同一首')
  assertEqual(third, first, 'shuffle peek 幂等：连续三次一致')
  assertEqual(shuffleState.position, -1, 'peek 不推进 position')
}

// ── commit 之后 peek 才前进 ──
{
  const shuffleState = freshState()
  const first = getNextIndex({ currentIndex: 0, queueLength: 6, mode: 'shuffle', shuffleState })
  commitNextIndex({ mode: 'shuffle', shuffleState })
  assertEqual(shuffleState.position, 0, 'commit 推进 position')
  const second = getNextIndex({ currentIndex: first, queueLength: 6, mode: 'shuffle', shuffleState })
  assert(second !== first, 'commit 后 peek 前进到下一首')
}

// ── 一轮洗牌覆盖全部索引，不重不漏 ──
{
  const queueLength = 8
  const shuffleState = freshState()
  let currentIndex = 0
  const visited = []
  for (let i = 0; i < queueLength; i++) {
    const idx = getNextIndex({ currentIndex, queueLength, mode: 'shuffle', shuffleState })
    commitNextIndex({ mode: 'shuffle', shuffleState })
    visited.push(idx)
    currentIndex = idx
  }
  assertEqual(visited.length, queueLength, 'shuffle cycle length')
  assertEqual(new Set(visited).size, queueLength, 'shuffle 一轮覆盖全部索引，无重复无跳过')
  assert(visited.every((i) => i >= 0 && i < queueLength), 'shuffle 索引在范围内')
}

// ── 走完一轮后自动重新洗牌 ──
{
  const queueLength = 4
  const shuffleState = freshState()
  for (let i = 0; i < queueLength; i++) {
    getNextIndex({ currentIndex: 0, queueLength, mode: 'shuffle', shuffleState })
    commitNextIndex({ mode: 'shuffle', shuffleState })
  }
  assertEqual(shuffleState.position, queueLength - 1, '一轮走完 position 到末尾')
  const firstOfNextRound = getNextIndex({ currentIndex: 0, queueLength, mode: 'shuffle', shuffleState })
  assertEqual(shuffleState.position, -1, '走完一轮后 peek 触发重新洗牌')
  assert(firstOfNextRound >= 0 && firstOfNextRound < queueLength, '新一轮索引合法')
}

// ── 新一轮的第一首不会撞上正在播的那首 ──
{
  for (let trial = 0; trial < 50; trial++) {
    const shuffleState = freshState()
    const idx = getNextIndex({ currentIndex: 2, queueLength: 4, mode: 'shuffle', shuffleState })
    assert(idx !== 2, 'shuffle 首选不等于当前曲目')
    if (idx === 2) break
  }
}

// ── 队列长度变化触发重新洗牌 ──
{
  const shuffleState = freshState()
  getNextIndex({ currentIndex: 0, queueLength: 5, mode: 'shuffle', shuffleState })
  commitNextIndex({ mode: 'shuffle', shuffleState })
  const idx = getNextIndex({ currentIndex: 0, queueLength: 3, mode: 'shuffle', shuffleState })
  assertEqual(shuffleState.order.length, 3, '队列变短后重新洗牌')
  assert(idx >= 0 && idx < 3, '重洗后索引在新范围内')
}

// ── 单曲队列 ──
{
  const shuffleState = freshState()
  assertEqual(getNextIndex({ currentIndex: 0, queueLength: 1, mode: 'shuffle', shuffleState }), 0, 'single track shuffle')
}

// ── 缺少 shuffleState 时降级为随机，不抛错 ──
{
  const idx = getNextIndex({ currentIndex: 0, queueLength: 5, mode: 'shuffle' })
  assert(idx >= 0 && idx < 5, 'shuffle 无 state 时降级安全')
}

// ── commitNextIndex 在非 shuffle / 无 state 下是空操作 ──
{
  const shuffleState = freshState()
  commitNextIndex({ mode: 'list', shuffleState })
  assertEqual(shuffleState.position, -1, 'list 模式 commit 不动 position')
  commitNextIndex({ mode: 'shuffle', shuffleState: null })
  commitNextIndex({ mode: 'shuffle' })
  passed++ // 上面两行不抛错即通过
}

console.log(`\n${passed} passed, ${failed} failed${failed ? ' — FAIL' : ' — all good'}`)
process.exit(failed ? 1 : 0)
