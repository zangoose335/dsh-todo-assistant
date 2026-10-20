/**
 * todo-assistant — test evidence from the current session (PLAN.md §C1).
 *
 * The point of this module is that an AI claim is not evidence: only a tool
 * call that actually ran a test command, paired with its tool result, can raise
 * a phase result above `claimed`. It stays free of DSH imports so the
 * verification harness can drive it with synthetic session events.
 */
import { TEST_STATUSES } from './domain.js'

/** Commands that read as a test/verification run. */
const TEST_COMMAND_RE =
  /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npm|pnpm|yarn)\s+run\s+verify\b|\bpytest\b|\bvitest\b|\bjest\b|\bgo\s+test\b|\bcargo\s+test\b|\bswift\s+test\b|\bxcodebuild\b[^\n]*\btest\b|\bmake\s+test\b|\bctest\b|\bnode\s+(?:\.\/)?scripts\/verify-[^\s]+)/iu

/** Tools whose arguments may carry a shell command. */
const EXEC_TOOL_RE = /(?:bash|shell|sh$|exec|command|subprocess|terminal|run)/iu

/** Tool result content blocks are text; keep their text for status markers. */
function resultText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** Whether one command looks like a test run. */
export function isTestCommand(command) {
  return typeof command === 'string' && TEST_COMMAND_RE.test(command)
}

/**
 * Extract the shell command from one tool call, or `''` when the call is not a
 * shell-shaped tool or carries no command.
 */
export function commandOfToolCall(name, rawArguments) {
  if (!EXEC_TOOL_RE.test(String(name ?? ''))) return ''
  let args = rawArguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
  for (const key of ['command', 'cmd', 'script', 'input']) {
    if (typeof args[key] === 'string' && args[key].trim() !== '') {
      return [...args[key].trim()].slice(0, 500).join('')
    }
  }
  if (Array.isArray(args.argv)) {
    const command = args.argv.filter((part) => typeof part === 'string').join(' ').trim()
    return command === '' ? '' : [...command].slice(0, 500).join('')
  }
  return ''
}

/** `failed` for an error result, a non-zero exit marker, a timeout or a signal. */
export function statusOfToolResult(message) {
  if (message === null || typeof message !== 'object') return 'not-run'
  if (message.isError === true) return 'failed'
  const text = resultText(message)
  if (/\[exit code: ([1-9]\d*)\]/u.test(text)) return 'failed'
  if (/\[timed out/u.test(text) || /\[killed by signal/u.test(text)) return 'failed'
  return 'passed'
}

/**
 * Scan session events for test commands that actually ran.
 *
 * One `tool/call` is paired with the `tool/result` carrying the same call id;
 * only the pair becomes evidence. Newest entries win when the list is capped.
 *
 * @param events - session events (`{seq,time,type,data}`), in order.
 * @param options - `limit` (default 20).
 * @returns test evidence entries `{command,status,verification:'tool-result',at}`.
 */
export function collectTestEvidence(events, { limit = 20 } = {}) {
  const calls = new Map()
  const evidence = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'tool/call') {
      const callId = event.data?.callId
      const command = commandOfToolCall(event.data?.name, event.data?.arguments)
      if (typeof callId === 'string' && command !== '' && isTestCommand(command)) {
        calls.set(callId, { command, at: event.time })
      }
      continue
    }
    if (event?.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId
      const call = calls.get(callId)
      if (call === undefined) continue
      calls.delete(callId)
      evidence.push({
        command: call.command,
        status: statusOfToolResult(event.data.message),
        verification: 'tool-result',
        at: Number.isFinite(event.time) ? event.time : call.at,
      })
    }
  }
  return evidence.slice(-limit)
}

/** Normalize a command for claimed-vs-observed matching. */
function comparable(command) {
  return String(command ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

/** Whether one claimed command and one observed command describe the same run. */
export function commandsMatch(claimed, observed) {
  const left = comparable(claimed)
  const right = comparable(observed)
  if (left === '' || right === '') return false
  return left === right || left.includes(right) || right.includes(left)
}

/** Result-level verification derived from its test evidence. */
export function deriveResultVerification(tests) {
  const list = Array.isArray(tests) ? tests : []
  const evidenced = list.filter((test) => test.verification === 'tool-result' || test.verification === 'developer')
  if (evidenced.length === 0) return 'claimed'
  if (list.some((test) => test.status === 'failed')) return 'unverified'
  return 'verified'
}

/**
 * Merge an AI-claimed result with what the session actually ran.
 *
 * Claimed commands are forced to `ai-claim` before matching (an AI cannot
 * declare its own evidence); a match adopts the observed status and becomes
 * `tool-result`. Observed tests the AI did not mention are appended, so the
 * developer sees everything that actually ran.
 *
 * @param result - a normalized `PhaseResult`.
 * @param observed - entries from {@link collectTestEvidence}; used to verify claims.
 * @param options - `at` fallback timestamp, `limit` test count (default 20), and
 *   `append` entries to add unmentioned (defaults to `observed`; the tool passes
 *   only this turn's runs so old debugging failures are not re-reported).
 * @returns a new result with merged tests and derived verification.
 */
export function mergeResultEvidence(result, observed, { at = Date.now(), limit = 20, append } = {}) {
  const tests = (Array.isArray(result?.tests) ? result.tests : []).map((test) => ({
    ...test,
    verification: 'ai-claim',
  }))
  const used = new Set()
  for (const test of tests) {
    const index = observed.findIndex((entry, position) => !used.has(position) && commandsMatch(test.command, entry.command))
    if (index < 0) continue
    used.add(index)
    test.status = TEST_STATUSES.includes(observed[index].status) ? observed[index].status : 'not-run'
    test.verification = 'tool-result'
    test.at = Number.isFinite(observed[index].at) ? observed[index].at : at
  }
  const existing = new Set(tests.map((test) => comparable(test.command)))
  const extra = Array.isArray(append) ? append : observed
  for (const entry of extra) {
    if (tests.length >= limit) break
    const key = comparable(entry.command)
    if (key === '' || existing.has(key)) continue
    existing.add(key)
    tests.push({
      command: entry.command,
      status: TEST_STATUSES.includes(entry.status) ? entry.status : 'not-run',
      verification: 'tool-result',
      at: Number.isFinite(entry.at) ? entry.at : at,
    })
  }
  return { ...result, tests, verification: deriveResultVerification(tests) }
}

/**
 * Apply the developer's "I checked the tests" confirmation: every test without
 * tool evidence becomes `developer`. An AI claim can never do this itself.
 *
 * @param result - a normalized `PhaseResult` (already merged with tool evidence).
 * @returns a new result with upgraded verified tests.
 */
export function confirmTestEvidence(result) {
  const tests = (Array.isArray(result?.tests) ? result.tests : []).map((test) =>
    test.verification === 'tool-result' ? test : { ...test, verification: 'developer' },
  )
  return { ...result, tests, verification: deriveResultVerification(tests) }
}
