/**
 * todo-assistant — `#DB … #/db` capture markers (DESIGN.md §6.x, card 1.4).
 *
 * The marker is the developer declaring intent in the message itself, so no
 * follow-up question is needed: the host scans each human message, queues the
 * enclosed blocks, and the next prompt assembly tells the agent to record them.
 *
 * Two details matter:
 * - code is ignored, because a message *about* this syntax must not capture
 *   itself (fenced blocks and inline code are stripped before scanning);
 * - the end marker is optional: `#DB` through the end of the message is the
 *   common, shorter form.
 *
 * Pure and import-free so the offline harness drives it directly.
 */

/**
 * Start marker: not attached to a word or another `#`, and not followed by a
 * word char. Punctuation before it is fine (`两条：#db`), so a marker right
 * after a colon/comma still captures.
 */
const START = /(?<![\p{L}\p{N}_#])#(?:db|memo)(?![\p{L}\p{N}_])/iu
/**
 * End marker: `#/db` at a line start or after whitespace, so a marker quoted
 * inside the block ("自动补全对应的"#/db"") does not close it early.
 */
const END = /(^|\s)#\/(?:db|memo)(?![\p{L}\p{N}_])/imu

/** Remove fenced and inline code so markers inside code never capture. */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
}

/**
 * Extract every `#DB … #/db` block from one human message.
 *
 * @param text - the message text.
 * @returns trimmed block bodies, in message order (empty blocks dropped).
 */
export function extractTodoBlocks(text) {
  const source = stripCode(String(text ?? ''))
  const blocks = []
  let cursor = 0
  while (cursor < source.length) {
    const rest = source.slice(cursor)
    const start = START.exec(rest)
    if (start === null) break
    const markerLength = start[0].trim().length
    const bodyStart = cursor + start.index + markerLength
    const tail = source.slice(bodyStart)
    const end = END.exec(tail)
    const body = end === null ? tail : tail.slice(0, end.index)
    const content = body.trim()
    if (content !== '') blocks.push(content)
    if (end === null) break
    const closeLength = end[0].trim().length
    cursor = bodyStart + end.index + (end[1] ?? '').length + closeLength
  }
  return blocks
}

/**
 * Per-session queue of marked blocks, drained by the prompt assembly that
 * follows the message.
 *
 * @returns the queue face wired by `host.js`.
 */
export function createMarkerQueue() {
  const pending = new Map()
  const seen = new Map()
  return {
    /**
     * Scan one human message; queues its blocks when the marker is present.
     *
     * @param sessionId - session that received the message.
     * @param text - message text.
     * @param messageId - durable message id, to ignore a repeated claim.
     * @returns whether anything was queued.
     */
    onUserMessage(sessionId, text, messageId) {
      const id = typeof messageId === 'string' ? messageId : ''
      let scanned = seen.get(sessionId)
      if (scanned === undefined) {
        scanned = new Set()
        seen.set(sessionId, scanned)
      }
      if (id !== '' && scanned.has(id)) return false
      if (id !== '') scanned.add(id)
      const blocks = extractTodoBlocks(text)
      if (blocks.length === 0) return false
      pending.set(sessionId, blocks)
      return true
    },

    /**
     * Take the blocks owed to the next assembly (empties the session's queue).
     *
     * @param sessionId - session being assembled.
     * @returns the blocks, possibly empty.
     */
    take(sessionId) {
      const blocks = pending.get(sessionId)
      if (blocks === undefined) return []
      pending.delete(sessionId)
      return blocks
    },

    /** Drop one session's queue and scan history. */
    forget(sessionId) {
      pending.delete(sessionId)
      seen.delete(sessionId)
    },

    /** Live queue size, for tests. */
    get size() {
      return pending.size
    },
  }
}

/**
 * Plain text of one user message (text blocks joined by newlines).
 *
 * @param message - a `user/message` payload.
 * @returns the text.
 */
export function messageText(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}
