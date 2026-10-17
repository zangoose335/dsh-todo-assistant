/**
 * todo-assistant — the reminder detector (DESIGN.md §7, §3.3).
 *
 * Deterministic and model-free: it watches one session's tool calls, compares
 * the paths a turn touched against the cards that session created, and leaves at
 * most a couple of lines for the next prompt assembly. A false positive costs one
 * line; a miss can be filled in later. That asymmetry is why the matching is
 * deliberately coarse.
 *
 * No bare package imports: `scripts/verify-domain.mjs` drives it with fake
 * session events.
 */

/** Tool name → the argument that names the file it touched. */
const FILE_ARGUMENT = {
  read: 'file_path',
  write: 'file_path',
  edit: 'file_path',
  read_image: 'file_path',
}

/** Tool name → the argument that names a directory the tool searched. */
const DIRECTORY_ARGUMENT = {
  grep: 'path',
  glob: 'path',
}

/** Most cards one assembly may be reminded about. */
export const MAX_REMINDERS = 2
/** Title characters kept inside one reminder line. */
const REMINDER_TITLE_LIMIT = 24

/**
 * Make one path comparable across a card and a tool call: repo-relative,
 * forward slashes, no leading `./`.
 *
 * @param path - raw path from a tool argument or a card.
 * @param cwd - session working directory used to relativize absolute paths.
 * @returns the comparable form ('' when unusable).
 */
export function normalizePath(path, cwd) {
  if (typeof path !== 'string') return ''
  let value = path.trim().replaceAll('\\', '/')
  if (value === '') return ''
  if (typeof cwd === 'string' && cwd !== '') {
    const base = cwd.replaceAll('\\', '/').replace(/\/+$/u, '')
    if (value === base) return '.'
    if (value.startsWith(`${base}/`)) value = value.slice(base.length + 1)
  }
  value = value.replace(/^\.\//u, '').replace(/\/+$/u, '')
  return value
}

/**
 * Extract the paths one tool call touched.
 *
 * @param name - registered tool name.
 * @param rawArguments - the raw argument string from the session log.
 * @param cwd - session working directory.
 * @returns comparable paths (possibly empty).
 */
export function filesFromToolCall(name, rawArguments, cwd) {
  const key = FILE_ARGUMENT[name] ?? DIRECTORY_ARGUMENT[name]
  if (key === undefined) return []
  let args
  try {
    args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
  } catch {
    return []
  }
  if (args === null || typeof args !== 'object') return []
  const value = args[key]
  if (typeof value !== 'string') return []
  const path = normalizePath(value, cwd)
  return path === '' ? [] : [path]
}

/** Number of leading path segments both files share as a directory prefix. */
function sharedDirectoryDepth(a, b) {
  const left = a.split('/').slice(0, -1)
  const right = b.split('/').slice(0, -1)
  let depth = 0
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1
  return depth
}

/** Depth when one of the two paths is a directory prefix of the other. */
function directoryPrefixDepth(a, b) {
  const left = a.split('/')
  const right = b.split('/')
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (shorter.length < 2 || shorter.length >= longer.length) return 0
  return shorter.every((segment, index) => segment === longer[index]) ? shorter.length : 0
}

/**
 * Decide whether one card relates to the paths a turn touched.
 *
 * @param card - stored card with `touchedFiles`.
 * @param touched - comparable paths collected for the turn.
 * @param threshold - shared directory segments required for a non-exact match.
 * @returns the matching path, or undefined.
 */
export function matchingPath(card, touched, threshold = 2) {
  const targets = Array.isArray(card.touchedFiles) ? card.touchedFiles.map((path) => normalizePath(path, '')).filter(Boolean) : []
  if (targets.length === 0) return undefined
  for (const target of targets) {
    for (const path of touched) if (target === path) return path
  }
  for (const target of targets) {
    for (const path of touched) {
      const depth = Math.max(sharedDirectoryDepth(target, path), directoryPrefixDepth(target, path))
      if (depth >= threshold) return path
    }
  }
  return undefined
}

/** Shorten one title for a single reminder line. */
function shortTitle(title) {
  const text = typeof title === 'string' ? title.trim() : ''
  return [...text].length <= REMINDER_TITLE_LIMIT ? text : `${[...text].slice(0, REMINDER_TITLE_LIMIT).join('')}…`
}

/**
 * Compose the one-line reminder for one hit.
 *
 * @param hit - `{ cardId, title, file }`.
 * @returns the model-facing line.
 */
export function reminderLine(hit) {
  const where = hit.file === undefined || hit.file === '' ? 'this step' : hit.file
  return `A file touched this step (${where}) relates to todo #${hit.label ?? hit.cardId}「${shortTitle(hit.title)}」; call todo_note if there is evidence worth keeping.`
}

/**
 * Create the per-session detector.
 *
 * @param options - dependencies.
 * @param options.store - the todo store (`all()` is used).
 * @param options.now - clock override.
 * @param options.threshold - shared directory segments for a coarse match.
 * @returns the detector face wired by `host.js`.
 */
export function createDetector({ store, now = Date.now, threshold = 2 }) {
  /** @type {Map<string, {turn: number, touched: Set<string>, hits: Map<string, object>, pending: object[], announced: Set<string>}>} */
  const sessions = new Map()

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { turn: 0, touched: new Set(), hits: new Map(), pending: [], announced: new Set() }
      sessions.set(sessionId, state)
    }
    return state
  }

  /** Recompute the hits of one session from the paths its turn touched so far. */
  function detect(sessionId) {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    const touched = [...state.touched]
    if (touched.length === 0) return
    const hits = new Map()
    const fresh = []
    for (const card of store.all()) {
      if (card.origin === undefined || card.origin.sessionId !== sessionId) continue
      if (card.status !== 'open' && card.status !== 'doing') continue
      const file = matchingPath(card, touched, threshold)
      if (file === undefined) continue
      const label = Number.isInteger(card.major) && Number.isInteger(card.minor) ? `${card.major}.${card.minor}` : undefined
      const hit = { cardId: card.id, label, title: card.title, file, at: now() }
      hits.set(card.id, hit)
      // One reminder per card per turn: accumulated turn paths keep matching, but
      // repeating the same line every step would be noise.
      if (!state.announced.has(card.id)) fresh.push(hit)
    }
    state.hits = hits
    if (fresh.length > 0) state.pending = fresh
  }

  return {
    /**
     * Feed one committed session event.
     *
     * @param session - the live session (id, header.cwd).
     * @param event - the appended event.
     */
    onSessionEvent(session, event) {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || event === undefined || event === null) return
      if (event.type === 'turn/start') {
        // Pending reminders survive into the next turn: a turn may end before
        // the next assembly ever ran.
        const state = stateOf(sessionId)
        state.turn = event.data.turn
        state.touched = new Set()
        state.hits = new Map()
        state.announced = new Set()
        return
      }
      if (event.type === 'turn/end') {
        detect(sessionId)
        const state = sessions.get(sessionId)
        if (state !== undefined) state.touched = new Set()
        return
      }
      if (event.type === 'tool/call') {
        const state = stateOf(sessionId)
        const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : ''
        for (const path of filesFromToolCall(event.data.name, event.data.arguments, cwd)) state.touched.add(path)
        return
      }
      if (event.type === 'step/end') {
        detect(sessionId)
      }
    },

    /**
     * Take the lines owed to the next assembly, marking them announced.
     *
     * @param sessionId - the session being assembled.
     * @returns zero or more model-facing lines.
     */
    takeReminder(sessionId) {
      const state = sessions.get(sessionId)
      if (state === undefined || state.pending.length === 0) return ''
      const taken = state.pending.slice(0, MAX_REMINDERS)
      state.pending = []
      for (const hit of taken) state.announced.add(hit.cardId)
      return taken.map(reminderLine).join('\n')
    },

    /**
     * Card ids currently related to one session, for the sidebar badge.
     *
     * @param sessionId - the session shown in the sidebar.
     * @returns the related card ids.
     */
    hitIds(sessionId) {
      const state = sessions.get(sessionId)
      return state === undefined ? new Set() : new Set(state.hits.keys())
    },

    /** Drop one session's state (session disposal). */
    forget(sessionId) {
      sessions.delete(sessionId)
    },

    /** Number of sessions with live state, for tests. */
    get size() {
      return sessions.size
    },
  }
}
