/**
 * todo-assistant — the L2 read-back (DESIGN.md §5.5, §3.7).
 *
 * A card stores a *pointer* into the session that produced it, never the
 * transcript. Reading that pointer is the most expensive thing this plugin can
 * do — the content it returns stays in context and is billed on every later
 * step — so the surface is deliberately two-stage:
 *
 *   1. a manifest (per message: seq, turn, role, first line, token estimate),
 *   2. the body of one chosen sequence slice.
 *
 * The controller asking for stage 2 is the developer, through the tool's hard rule
 * ("ask first"). This module is deterministic and import-free so the offline
 * harness can drive it against fake logs.
 */

/** Message-bearing event types a manifest may list. */
const MESSAGE_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result', 'developer/message'])

/** One manifest preview keeps at most this many code points of the first line. */
const PREVIEW_LIMIT = 40
/** Body reads truncate one message to this many characters. */
const BODY_MESSAGE_LIMIT = 2000
/** …and the whole body to this many characters. */
const BODY_TOTAL_LIMIT = 12000

/**
 * The message a message-bearing event carries. `user/message` stores the message
 * *as* its data; the others wrap it in `data.message`.
 *
 * @param event - one raw log event.
 * @returns the message, or undefined.
 */
function messageOf(event) {
  if (event === undefined || event === null) return undefined
  if (event.data?.message !== undefined) return event.data.message
  if (event.type === 'user/message') return event.data
  return undefined
}

/** Read every text block of one message, joined for display. */
function textOf(event) {
  try {
    const message = messageOf(event)
    if (message === undefined) return ''
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    const parts = []
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

/** First non-empty line, shortened for a manifest row. */
function previewOf(text) {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? ''
  const chars = [...line.trim()]
  return chars.length <= PREVIEW_LIMIT ? chars.join('') : `${chars.slice(0, PREVIEW_LIMIT).join('')}…`
}

/** The role a surface event speaks as. */
function roleOf(event) {
  switch (event?.type) {
    case 'user/message':
      return 'user'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool'
    case 'developer/message':
      return 'developer'
    default:
      return ''
  }
}

/**
 * Create the recall reader.
 *
 * @param options - injected dependencies.
 * @param options.readSession - `(sessionId) => Promise<{events}>` (the raw log).
 * @param options.estimateTokens - `(message) => number`; when absent an estimate is derived from length.
 * @returns the two-stage reader used by `todo_recall`.
 */
export function createRecall({ readSession, estimateTokens }) {
  /** Load and index one session's raw log, tracking the turn each event belongs to. */
  async function load(origin) {
    const snapshot = await readSession(origin.sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const from = Number.isInteger(origin.seqRange?.[0]) ? origin.seqRange[0] : 0
    const to = Number.isInteger(origin.seqRange?.[1]) ? origin.seqRange[1] : from
    const rows = []
    let turn = 0
    for (const event of events) {
      if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn
      if (!Number.isInteger(event?.seq) || event.seq < from || event.seq > to) continue
      if (!MESSAGE_EVENTS.has(event.type)) continue
      rows.push({ seq: event.seq, turn: Number.isInteger(event.data?.turn) ? event.data.turn : turn, role: roleOf(event), text: textOf(event), message: messageOf(event) })
    }
    return { rows, range: [from, to], available: from !== to || rows.length > 0 }
  }

  return {
    /**
     * Stage one: the manifest of what lives in the card's origin range.
     *
     * @param origin - the card's `origin` pointer.
     * @returns the manifest, or an unavailable answer.
     */
    async manifest(origin) {
      if (origin === undefined || origin === null || typeof origin.sessionId !== 'string' || origin.sessionId === '') {
        return { available: false, reason: 'this card has no origin session' }
      }
      let loaded
      try {
        loaded = await load(origin)
      } catch (error) {
        return { available: false, reason: `the origin session could not be read: ${String(error?.message ?? error)}` }
      }
      if (loaded.rows.length === 0) {
        return { available: false, reason: 'the origin range holds no messages', range: loaded.range, sessionId: origin.sessionId }
      }
      let tokens = 0
      const entries = loaded.rows.map((row) => {
        const count = typeof estimateTokens === 'function' && row.message !== undefined ? safeEstimate(estimateTokens, row.message) : roughTokens(row.text)
        tokens += count
        return { seq: row.seq, turn: row.turn, role: row.role, preview: previewOf(row.text), tokens: count }
      })
      return {
        available: true,
        sessionId: origin.sessionId,
        range: loaded.range,
        total: entries.length,
        tokens,
        entries,
      }
    },

    /**
     * Stage two: the text of one chosen sequence slice.
     *
     * @param origin - the card's `origin` pointer.
     * @param slice - inclusive `[from, to]`.
     * @returns the body, clipped to a bounded size.
     */
    async body(origin, slice) {
      if (origin === undefined || origin === null || typeof origin.sessionId !== 'string' || origin.sessionId === '') {
        return { available: false, reason: 'this card has no origin session' }
      }
      const from = Number.isInteger(slice?.[0]) ? slice[0] : undefined
      const to = Number.isInteger(slice?.[1]) ? slice[1] : undefined
      if (from === undefined || to === undefined || from > to) {
        return { available: false, reason: 'slice must be an inclusive [from, to] pair of sequence numbers' }
      }
      const loaded = await load(origin)
      const wanted = loaded.rows.filter((row) => row.seq >= from && row.seq <= to)
      if (wanted.length === 0) {
        return { available: false, reason: `no messages between seq ${from} and ${to}`, range: loaded.range }
      }
      const entries = []
      let used = 0
      let truncated = false
      for (const row of wanted) {
        const chars = [...row.text]
        const text = chars.length <= BODY_MESSAGE_LIMIT ? row.text : `${chars.slice(0, BODY_MESSAGE_LIMIT).join('')}…`
        if (used + text.length > BODY_TOTAL_LIMIT) {
          truncated = true
          break
        }
        used += text.length
        entries.push({ seq: row.seq, turn: row.turn, role: row.role, text })
      }
      return { available: true, sessionId: origin.sessionId, range: loaded.range, slice: [from, to], entries, truncated }
    },
  }
}

/** Token estimate through the injected meter, never throwing. */
function safeEstimate(estimate, message) {
  try {
    const value = estimate(message)
    return Number.isFinite(value) ? value : roughTokens('')
  } catch {
    return roughTokens('')
  }
}

/** Fallback estimate: ~4 characters per token. */
function roughTokens(text) {
  return Math.ceil([...(text ?? '')].length / 4)
}
