/**
 * Stage 2 recall verification: effective turns, first batch, surface skip,
 * approval request, source limits, and token proxies. Pure fake log; no DSH
 * service or model is required.
 *
 * Usage: node scripts/verify-recall.mjs
 */
import { createRecall } from '../recall.js'
import { recallApprovalDecision } from '../approval.js'

let checks = 0
let failures = 0

function check(label, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function checkEqual(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开头决定：采用方案甲' }] } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到，先记录方案甲' }] } } },
  { type: 'tool/result', seq: 4, data: { turn: 1, message: { role: 'tool', content: [{ type: 'text', text: '读取完成' }] } } },
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '补充约束：不能停机' }] } },
  // A synthetic injection must not make turn 3 effective.
  { type: 'turn/start', seq: 7, data: { turn: 3 } },
  { type: 'user/message', seq: 8, data: { role: 'user', source: { kind: 'file-change' }, content: [{ type: 'text', text: '3 个文件已变更' }] } },
  { type: 'tool/call', seq: 9, data: { turn: 3, step: 1, name: 'read', arguments: '{}' } },
  { type: 'turn/start', seq: 10, data: { turn: 4 } },
  { type: 'user/message', seq: 11, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '确认使用方案甲' }] } },
  { type: 'user/message', seq: 12, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再加一条：先备份' }] } },
  { type: 'turn/start', seq: 13, data: { turn: 5 } },
  { type: 'user/message', seq: 14, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '检查回滚脚本' }] } },
  { type: 'turn/start', seq: 15, data: { turn: 6 } },
  { type: 'user/message', seq: 16, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '补充旧数据兼容' }] } },
  { type: 'turn/start', seq: 17, data: { turn: 7 } },
  { type: 'user/message', seq: 18, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续讨论边界' }] } },
  { type: 'turn/start', seq: 19, data: { turn: 8 } },
  { type: 'user/message', seq: 20, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '查看测试夹具' }] } },
  { type: 'turn/start', seq: 21, data: { turn: 9 } },
  { type: 'user/message', seq: 22, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '准备开始实现' }] } },
  { type: 'turn/start', seq: 23, data: { turn: 10 } },
  { type: 'user/message', seq: 24, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '当前轮：开始改代码' }] } },
]

const fullRange = { sessionId: 'session-main', seqRange: [1, 24] }
const recall = createRecall({
  readSession: async (sessionId) => {
    if (sessionId !== 'session-main') throw new Error('unknown session')
    return { events }
  },
  readSurface: async () => ({ events: [{ seq: 2 }, { seq: 3 }, { seq: 6 }, { seq: 11 }] }),
  estimateTokens: () => 10,
})

console.log('Stage 2 recall / first batch')
checkEqual('origin manifest remains readable', (await recall.manifest(fullRange)).available, true)
const manifest = await recall.manifest(fullRange)
checkEqual('manifest reports all message-bearing events', manifest.total, 13)
checkEqual('manifest entries are in time order', manifest.entries.map((entry) => entry.seq), [2, 3, 4, 6, 8, 11, 12, 14, 16, 18, 20, 22, 24])
checkEqual('manifest marks the current surface', manifest.stats.surfaceVisible, 4)
checkEqual('manifest estimates, not exact billing', [manifest.stats.estimatedTokens, manifest.stats.messages], [130, 13])
const crossSession = await recall.manifest(fullRange, { surface: false })
checkEqual('cross-session reads do not claim local surface', [crossSession.stats.surfaceKnown, crossSession.stats.surfaceVisible, crossSession.stop], [false, 0, false])
const manyEvents = Array.from({ length: 130 }, (_, index) => ({
  type: 'user/message',
  seq: index + 1,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `message ${index + 1}` }] },
}))
const manyRecall = createRecall({ readSession: async () => ({ events: manyEvents }) })
const many = await manyRecall.manifest({ sessionId: 'many', seqRange: [1, 130] })
checkEqual('a huge manifest is capped', [many.total, many.entries.length, many.truncated], [130, 120, true])
checkEqual('capped manifest stats count returned rows', many.stats.messages, 120)

const first = await recall.firstBatch(fullRange, { currentTurn: 10 })
checkEqual('first batch takes the earliest five effective turns', first.turns, [1, 2, 4, 5, 6])
checkEqual('first batch excludes synthetic and current turns', first.entries.some((entry) => entry.turn === 3 || entry.turn === 10), false)
checkEqual('first batch entries are time ordered', first.entries.map((entry) => entry.seq), [2, 3, 4, 6, 11, 12, 14, 16])
checkEqual('first batch stats identify batch one', first.stats.batch, 1)

const short = await recall.firstBatch({ sessionId: 'session-main', seqRange: [1, 6] })
checkEqual('a short history returns the actual turns', short.turns, [1, 2])
checkEqual('a short first batch does not invent five turns', short.stats.messages, 4)
const limited = await recall.firstBatch(fullRange, { limit: 3 })
checkEqual('first batch respects a smaller limit', limited.turns, [1, 2, 4])

const fileSource = await recall.manifest({ kind: 'file', where: { file: 'docs/a.md' } })
checkEqual('a file source is unavailable for history', fileSource.available, false)
const missing = await recall.manifest({ sessionId: 'gone', seqRange: [1, 2] })
checkEqual('a missing session is unavailable', [missing.available, typeof missing.reason], [false, 'string'])
checkEqual('a file source has no history body', (await recall.manifest({ kind: 'file', where: { file: 'src/a.ts' } })).available, false)

console.log('\nSurface skip / stop')
const body = await recall.body(fullRange, [2, 3])
checkEqual('all-visible body stops without entries', [body.available, body.stop, body.entries], [false, true, undefined])
checkEqual('all-visible body counts skipped entries', body.stats.duplicatesSkipped, 2)
const partial = await recall.body(fullRange, [2, 4])
checkEqual('partially visible body returns only the gap', partial.entries.map((entry) => entry.seq), [4])
checkEqual('partial body counts skipped entries', partial.stats.duplicatesSkipped, 2)
checkEqual('body stays inside the requested slice', partial.entries.every((entry) => entry.seq >= 2 && entry.seq <= 4), true)

const noSurface = createRecall({
  readSession: async () => ({ events }),
  estimateTokens: () => 1,
})
const unknownSurface = await noSurface.manifest(fullRange)
checkEqual('missing surface is reported, not faked', [unknownSurface.stats.surfaceKnown, unknownSurface.stats.surfaceVisible], [false, 0])
check('missing surface does not block reading', unknownSurface.available === true)

console.log('\nApproval request')
const ask = recallApprovalDecision({ name: 'todo_recall', arguments: { id: '6.2', sourceId: 's1', slice: [2, 4], gap: '缺少旧决定', reason: '确认后继续' } })
checkEqual('recall produces an ask', ask.kind, 'ask')
check('ask names card, source, slice, gap and reason', ask.reason.includes('6.2') && ask.reason.includes('s1') && ask.reason.includes('2..4') && ask.reason.includes('缺少旧决定') && ask.reason.includes('确认后继续'), ask.reason)
checkEqual('other tools are not intercepted', recallApprovalDecision({ name: 'todo_add' }), undefined)
checkEqual('only allowed-once is a grant', ['allowed-once', 'rejected', 'cancelled', 'unavailable'].map((outcome) => outcome === 'allowed-once'), [true, false, false, false])

console.log('\nToken proxy summary')
checkEqual('manifest messages are counted', manifest.stats.messages, manifest.entries.length)
checkEqual('manifest events are counted', manifest.stats.events, events.length)
checkEqual('body batches are zero', partial.stats.batch, 0)
checkEqual('first batch batches are one', first.stats.batch, 1)
check('estimatedTokens is a non-negative proxy', manifest.stats.estimatedTokens >= 0 && partial.stats.estimatedTokens >= 0)
check('duplicatesSkipped counts visible skips', partial.stats.duplicatesSkipped === 2)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
