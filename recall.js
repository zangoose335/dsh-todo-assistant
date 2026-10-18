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
 * Sources are pointers too: a session source points at `where.sessionId` and
 * `where.seqRange`; a file source has no body to read. The reader is
 * deterministic and import-free so the offline harness can drive it against
 * fake logs.
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

/** The source kind on a human message (`user`, `file-change`, ...). */
function sourceKindOf(event) {
  const direct = event?.data?.source?.kind
  if (typeof direct === 'string') return direct
  const wrapped = event?.data?.message?.source?.kind
  return typeof wrapped === 'string' ? wrapped : ''
}

/**
 * A source pointer may be an `origin` (`sessionId`/`seqRange`) or a stored
 * source (`where.sessionId`/`where.seqRange`). Both become one target.
 */
function targetOf(value) {
  const sessionId = typeof value?.where?.sessionId === 'string'
    ? value.where.sessionId
    : typeof value?.sessionId === 'string'
      ? value.sessionId
      : ''
  const range = Array.isArray(value?.where?.seqRange) ? value.where.seqRange : value?.seqRange
  if (sessionId === '' || !Array.isArray(range) || range.length !== 2) return undefined
  if (!Number.isInteger(range[0]) || !Number.isInteger(range[1])) return undefined
  return { sessionId, seqRange: [range[0], range[1]] }
}

/**
 * Create the recall reader.
 *
 * @param options - injected dependencies.
 * @param options.readSession - `(sessionId) => Promise<{events}>` (the raw log).
 * @param options.readSurface - optional `(sessionId) => Promise<{events}>` current model surface.
 * @param options.estimateTokens - `(message) => number`; when absent an estimate is derived from length.
 * @returns the two-stage reader used by `todo_recall`.
 */
export function createRecall({ readSession, readSurface, estimateTokens }) {
  /** Load one session's raw log and attach the current turn to every message. */
  async function loadSession(sessionId) {
    const snapshot = await readSession(sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const rows = []
    let turn = 0
    for (const event of events) {
      if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn
      if (!Number.isInteger(event?.seq)) continue
      if (!MESSAGE_EVENTS.has(event.type)) continue
      rows.push({
        seq: event.seq,
        turn: Number.isInteger(event.data?.turn) ? event.data.turn : turn,
        role: roleOf(event),
        sourceKind: sourceKindOf(event),
        text: textOf(event),
        message: messageOf(event),
      })
    }
    return { rows, eventCount: events.length }
  }

  /** Load one target and keep only its inclusive sequence range. */
  async function load(value) {
    const target = targetOf(value)
    if (target === undefined) {
      return { available: false, reason: 'the source has no session seqRange' }
    }
    const loaded = await loadSession(target.sessionId)
    const rows = loaded.rows.filter((row) => row.seq >= target.seqRange[0] && row.seq <= target.seqRange[1])
    return {
      available: true,
      sessionId: target.sessionId,
      range: target.seqRange,
      rows,
      eventCount: loaded.eventCount,
    }
  }

  /** The seqs currently in the model surface, when the DSH service exposes it. */
  async function visibleSeqs(sessionId) {
    if (typeof readSurface !== 'function') return undefined
    try {
      const snapshot = await readSurface(sessionId)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      return new Set(events.map((event) => event?.seq).filter((seq) => Number.isInteger(seq)))
    } catch {
      return undefined
    }
  }

  /** Build manifest entries and their total token estimate, marking visible entries. */
  function entriesOf(rows, visible) {
    let tokens = 0
    const entries = rows.map((row) => {
      const count = typeof estimateTokens === 'function' && row.message !== undefined ? safeEstimate(estimateTokens, row.message) : roughTokens(row.text)
      tokens += count
      return {
        seq: row.seq,
        turn: row.turn,
        role: row.role,
        preview: previewOf(row.text),
        tokens: count,
        ...(visible === undefined ? {} : { visible: visible.has(row.seq) }),
      }
    })
    return { entries, tokens }
  }

  /** Stats carried by every read; estimates, not a historical bill. */
  function statsOf(loaded, entries, tokens, batch, visible, duplicatesSkipped = 0) {
    return {
      messages: entries.length,
      events: loaded.eventCount,
      estimatedTokens: tokens,
      batch,
      duplicatesSkipped,
      surfaceKnown: visible !== undefined,
      surfaceVisible: visible === undefined ? 0 : entries.filter((entry) => entry.visible === true).length,
    }
  }

  /** Effective human turns in a set of rows, ascending and de-duplicated. */
  function effectiveTurns(rows) {
    const turns = new Set()
    for (const row of rows) {
      if (row.role !== 'user') continue
      if (row.sourceKind !== 'user') continue
      if (row.text.trim() === '') continue
      turns.add(row.turn)
    }
    return [...turns].sort((left, right) => left - right)
  }

  return {
    /**
     * Stage one: a manifest of one source (origin or stored source pointer).
     *
     * @param value - origin or source pointer.
     * @returns the manifest, or an unavailable answer.
     */
    async manifest(value) {
      let loaded
      try {
        loaded = await load(value)
      } catch (error) {
        return { available: false, reason: `the source session could not be read: ${String(error?.message ?? error)}` }
      }
      if (loaded.available !== true) return { available: false, reason: loaded.reason }
      if (loaded.rows.length === 0) {
        return { available: false, reason: 'the source range holds no messages', range: loaded.range, sessionId: loaded.sessionId }
      }
      const visible = await visibleSeqs(loaded.sessionId)
      const { entries, tokens } = entriesOf(loaded.rows, visible)
      return {
        available: true,
        sessionId: loaded.sessionId,
        range: loaded.range,
        total: entries.length,
        tokens,
        entries,
        stop: visible !== undefined && entries.length > 0 && entries.every((entry) => entry.visible === true),
        stats: statsOf(loaded, entries, tokens, 0, visible),
      }
    },

    /**
     * Stage two: the text of one chosen sequence slice from one source.
     *
     * @param value - origin or source pointer.
     * @param slice - inclusive `[from, to]`.
     * @returns the body, clipped to a bounded size.
     */
    async body(value, slice) {
      const from = Number.isInteger(slice?.[0]) ? slice[0] : undefined
      const to = Number.isInteger(slice?.[1]) ? slice[1] : undefined
      if (from === undefined || to === undefined || from > to) {
        return { available: false, reason: 'slice must be an inclusive [from, to] pair of sequence numbers' }
      }
      let loaded
      try {
        loaded = await load(value)
      } catch (error) {
        return { available: false, reason: `the source session could not be read: ${String(error?.message ?? error)}` }
      }
      if (loaded.available !== true) return { available: false, reason: loaded.reason }
      const wanted = loaded.rows.filter((row) => row.seq >= from && row.seq <= to)
      if (wanted.length === 0) {
        return { available: false, reason: `no messages between seq ${from} and ${to}`, range: loaded.range }
      }
      const visible = await visibleSeqs(loaded.sessionId)
      const skipped = visible === undefined ? [] : wanted.filter((row) => visible.has(row.seq))
      const toRead = visible === undefined ? wanted : wanted.filter((row) => !visible.has(row.seq))
      if (toRead.length === 0) {
        return {
          available: false,
          stop: true,
          reason: 'all requested messages are already in the current model surface',
          range: loaded.range,
          sessionId: loaded.sessionId,
          stats: statsOf(loaded, [], 0, 0, visible, skipped.length),
        }
      }
      const entries = []
      let used = 0
      let truncated = false
      for (const row of toRead) {
        const chars = [...row.text]
        const text = chars.length <= BODY_MESSAGE_LIMIT ? row.text : `${chars.slice(0, BODY_MESSAGE_LIMIT).join('')}…`
        if (used + text.length > BODY_TOTAL_LIMIT) {
          truncated = true
          break
        }
        used += text.length
        entries.push({
          seq: row.seq,
          turn: row.turn,
          role: row.role,
          text,
          ...(visible === undefined ? {} : { visible: visible.has(row.seq) }),
        })
      }
      const tokens = entries.reduce((sum, entry) => sum + roughTokens(entry.text), 0)
      return {
        available: true,
        sessionId: loaded.sessionId,
        range: loaded.range,
        slice: [from, to],
        entries,
        truncated,
        stop: false,
        stats: statsOf(loaded, entries, tokens, 0, visible, skipped.length),
      }
    },

    /**
     * A3 seed: the first effective human turns in one source. Current turn is
     * excluded; fewer than `limit` turns return the actual count.
     *
     * @param value - origin or source pointer.
     * @param options - `currentTurn` and `limit` (default 5).
     * @returns the first-batch manifest, or unavailable.
     */
    async firstBatch(value, options = {}) {
      let loaded
      try {
        loaded = await load(value)
      } catch (error) {
        return { available: false, reason: `the source session could not be read: ${String(error?.message ?? error)}` }
      }
      if (loaded.available !== true) return { available: false, reason: loaded.reason }
      const currentTurn = Number.isInteger(options?.currentTurn) ? options.currentTurn : undefined
      const limit = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : 5
      const turns = effectiveTurns(loaded.rows)
        .filter((turn) => turn !== currentTurn)
        .slice(0, limit)
      if (turns.length === 0) {
        return { available: false, reason: 'the source has no effective human turns', range: loaded.range, sessionId: loaded.sessionId }
      }
      const rows = loaded.rows.filter((row) => turns.includes(row.turn))
      const visible = await visibleSeqs(loaded.sessionId)
      const { entries, tokens } = entriesOf(rows, visible)
      return {
        available: true,
        sessionId: loaded.sessionId,
        range: loaded.range,
        turns,
        total: entries.length,
        tokens,
        entries,
        stop: visible !== undefined && entries.length > 0 && entries.every((entry) => entry.visible === true),
        stats: statsOf(loaded, entries, tokens, 1, visible),
      }
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
