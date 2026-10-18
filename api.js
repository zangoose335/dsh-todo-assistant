/**
 * todo-assistant — host-side data operations and the wire surface.
 *
 * Like `domain.js`, this module has **no bare package imports**: it only needs
 * the opened domain handle, so `scripts/verify-domain.mjs` can drive it over a
 * real JSON backend without the profile runtime.
 *
 * Wire contract (DESIGN.md §10.1, verified channel):
 *   channel  `/todo-assistant`
 *   request  POST /todo-assistant/<endpoint> with the Connection RPC envelope
 *   result   `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`
 */
import {
  INBOX,
  NOTE_KINDS,
  TodoInputError,
  applyPatch,
  buildRecord,
  mintId,
  projectFull,
  projectL0,
} from './domain.js'

/** Absolute logical RPC channel; the browser calls it through `ctx.connection.rpc`. */
export const CHANNEL = '/todo-assistant'

/** Maximum notes a card may accumulate before the editor is told to prune. */
const NOTE_LIMIT = 200
/** A single note is a sentence or two, never a summary. */
const NOTE_TEXT_LIMIT = 300

/** Wrap any thrown value as a wire failure. */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** Resolve one wire reference (label or id) to the stored record's id. */
function resolveRef(store, payload) {
  const ref = typeof payload?.id === 'string' ? payload.id.trim() : ''
  if (ref === '') throw new TodoInputError('todo/id-required', 'id 不能为空')
  const record = store.findRef(ref)
  if (record === undefined) throw new TodoInputError('todo/not-found', `待办 #${ref} 不存在`)
  return record.id
}

/** Normalize one stored record for the wire; reject non-objects loudly. */
function requireRecord(value) {
  if (value === undefined) {
    throw new TodoInputError('todo/not-found', '待办不存在，可能已被删除')
  }
  return value
}

/** A diagnostic when a manual write supplies two different next actions. */
function nextActionWarnings(nextStep, brief) {
  const legacy = typeof nextStep === 'string' ? nextStep.replace(/\s+/gu, ' ').trim() : ''
  const canonical = typeof brief?.nextAction === 'string' ? brief.nextAction.replace(/\s+/gu, ' ').trim() : ''
  if (legacy !== '' && canonical !== '' && legacy !== canonical) {
    return ['nextStep differs from brief.nextAction; the brief value is canonical and core.nextStep was synchronized']
  }
  return []
}

/**
 * Open a typed view over the `todos` table.
 *
 * @param domain - the opened `todo-assistant` domain handle.
 * @returns store operations shared by the RPC surface (and, later, the tools).
 */
export function createStore(domain) {
  const table = domain.table('todos')
  const rulesTable = domain.table('rules')

  /**
   * Allocate the label of a new card: same root session reuses its major and
   * takes the next minor; a new root session (or a session-less card) takes a
   * fresh major. Numbers are computed once, at creation, and persisted — a
   * later delete never renumbers anything.
   *
   * @param rootSessionId - root session of the card's origin ('' when none).
   * @returns the label parts.
   */
  function allocateLabel(rootSessionId) {
    const records = store.all()
    let maxMajor = 0
    let groupMajor = null
    let groupMinor = -1
    for (const record of records) {
      if (Number.isInteger(record.major) && record.major > maxMajor) maxMajor = record.major
      if (rootSessionId === '') continue
      // Only cards captured after this scheme carry a root session; the legacy
      // bucket (major 1) deliberately never absorbs new cards.
      if (record.origin?.rootSessionId !== rootSessionId) continue
      if (!Number.isInteger(record.major) || !Number.isInteger(record.minor)) continue
      if (groupMajor === null) groupMajor = record.major
      if (record.major === groupMajor && record.minor > groupMinor) groupMinor = record.minor
    }
    if (groupMajor !== null) return { major: groupMajor, minor: groupMinor + 1 }
    return { major: maxMajor + 1, minor: rootSessionId === '' ? 0 : 1 }
  }

  const store = {
    /** Allocate the label parts for one root session. */
    allocateLabel,

    /**
     * Resolve a user-facing reference: `3.2` / `#3.2` by label, otherwise the
     * internal id. Both forms stay valid everywhere a card is addressed.
     */
    findRef(ref) {
      const text = typeof ref === 'string' ? ref.trim() : ''
      if (text === '') return undefined
      const labelled = /^#?(\d+)[.](\d+)$/u.exec(text)
      if (labelled !== null) {
        const major = Number(labelled[1])
        const minor = Number(labelled[2])
        for (const [, record] of table.entries()) {
          if (record.major === major && record.minor === minor) return record
        }
        return undefined
      }
      // Pre-migration records may still carry a bare number.
      const numeric = /^#?(\d+)$/u.exec(text)
      if (numeric !== null) {
        const wanted = Number(numeric[1])
        for (const [, record] of table.entries()) if (record.number === wanted) return record
        return undefined
      }
      return table.get(text)
    },

    /**
     * Move every card onto the `major.minor` label once. Existing numbers become
     * `1.<old number>` (the legacy bucket); unnumbered leftovers follow in
     * creation order.
     *
     * @returns how many records were migrated.
     */
    async migrateLabels() {
      const records = store.all()
      const pending = records.filter((record) => !Number.isInteger(record.major))
      if (pending.length === 0) return 0
      let minor = records.reduce(
        (max, record) => (record.major === 1 && Number.isInteger(record.minor) && record.minor > max ? record.minor : max),
        0,
      )
      const ordered = [...pending].sort((a, b) => a.createdAt - b.createdAt)
      for (const record of ordered) {
        const assigned = Number.isInteger(record.number) ? record.number : (minor += 1)
        if (assigned > minor) minor = assigned
        const next = { ...record, major: 1, minor: assigned }
        delete next.number
        await table.put(record.id, next)
      }
      return ordered.length
    },
    /** Every stored record, newest change first. */
    all() {
      const items = []
      for (const [, record] of table.entries()) items.push(record)
      items.sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      return items
    },

    /** One record, or undefined. */
    get(id) {
      return table.get(id)
    },

    /** Whether an id is already taken (for id minting). */
    has(id) {
      return table.get(id) !== undefined
    },

    /** Create and durably store one card. */
    async create(input, now) {
      const rootSessionId = typeof input?.rootSessionId === 'string' ? input.rootSessionId : ''
      const label = allocateLabel(rootSessionId)
      const record = buildRecord(input, { now, nextId: () => mintId((id) => store.has(id)), label })
      await table.put(record.id, record)
      return record
    },

    /** Store one already-assembled record (the `todo_add` capture path). */
    async put(record) {
      const stored = Number.isInteger(record.major)
        ? record
        : { ...record, ...allocateLabel(typeof record.origin?.rootSessionId === 'string' ? record.origin.rootSessionId : '') }
      await table.put(stored.id, stored)
      return stored
    },

    /** Bind one card to the session that took it over. */
    async setHandling(id, sessionId, now) {
      const current = requireRecord(table.get(id))
      const next = { ...current, handling: { sessionId, at: now() }, updatedAt: now() }
      await table.put(id, next)
      return next
    },

    /** Apply a manual edit and durably store the result. */
    async update(id, patch, now) {
      const current = requireRecord(table.get(id))
      const next = applyPatch(current, patch, now())
      await table.put(id, next)
      return next
    },

    /**
     * One workspace's general rules (empty when never set).
     *
     * @param workspace - normalized workspace path.
     * @returns the text and when it was last written.
     */
    getRules(workspace) {
      const record = typeof workspace === 'string' && workspace !== '' ? rulesTable.get(workspace) : undefined
      return { workspace, text: record?.text ?? '', updatedAt: record?.updatedAt ?? null }
    },

    /**
     * Replace one workspace's rules; blank text removes the row entirely.
     *
     * @param workspace - normalized workspace path.
     * @param text - the rules text.
     * @param now - clock override.
     * @returns the stored state.
     */
    async setRules(workspace, text, now) {
      const path = typeof workspace === 'string' ? workspace.trim() : ''
      if (path === '') throw new TodoInputError('todo/workspace-required', 'workspace 不能为空')
      const value = typeof text === 'string' ? text : ''
      if (value.trim() === '') {
        if (rulesTable.get(path) !== undefined) await rulesTable.delete(path)
        return { workspace: path, text: '', updatedAt: null }
      }
      const record = { workspace: path, text: value, updatedAt: now() }
      await rulesTable.put(path, record)
      return { workspace: path, text: record.text, updatedAt: record.updatedAt }
    },

    /** Delete one card. */
    async remove(id) {
      const current = requireRecord(table.get(id))
      await table.delete(id)
      return current
    },

    /** Append one note (never rewrite the card, DESIGN.md §3.8). */
    async addNote(id, input, now) {
      const current = requireRecord(table.get(id))
      const text = typeof input?.text === 'string' ? input.text.replace(/\s+/gu, ' ').trim().slice(0, NOTE_TEXT_LIMIT) : ''
      if (text === '') throw new TodoInputError('todo/note-empty', 'note 内容不能为空')
      if ((current.notes ?? []).length >= NOTE_LIMIT) {
        throw new TodoInputError('todo/note-limit', `note 已达上限 ${NOTE_LIMIT} 条`)
      }
      const kind = NOTE_KINDS.includes(input?.kind) ? input.kind : 'supplement'
      const note = {
        at: now(),
        fromSession: typeof input?.fromSession === 'string' ? input.fromSession : '',
        turn: Number.isInteger(input?.turn) ? input.turn : 0,
        kind,
        text,
      }
      const next = { ...current, notes: [...(current.notes ?? []), note], updatedAt: note.at }
      await table.put(id, next)
      return next
    },

    /** Remove one note by position. */
    async removeNote(id, index) {
      const current = requireRecord(table.get(id))
      const notes = current.notes ?? []
      if (!Number.isInteger(index) || index < 0 || index >= notes.length) {
        throw new TodoInputError('todo/note-missing', 'note 序号无效')
      }
      const next = { ...current, notes: notes.filter((_, i) => i !== index), updatedAt: Date.now() }
      await table.put(id, next)
      return next
    },
  }

  return store
}

/**
 * Build the endpoint dispatcher registered on the Connection RPC channel.
 *
 * @param options - dependencies.
 * @param options.store - the store from {@link createStore}.
 * @param options.now - clock override (tests).
 * @returns `{ handle(endpoint, payload) }` answering wire results.
 */
export function createApi({ store, now = Date.now, hitIds, resolveRoot }) {
  const endpointMap = {
    /** List cards for one bucket, or every bucket. */
    async list(payload) {
      const all = payload?.all === true
      const workspace = typeof payload?.workspace === 'string' ? payload.workspace : INBOX
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const hits = sessionId !== '' && typeof hitIds === 'function' ? hitIds(sessionId) : undefined
      const items = store.all().filter((record) => all || record.workspace === workspace)
      return {
        items: items.map((record) => {
          const row = projectL0(record)
          if (hits !== undefined && hits.has(record.id)) row.hit = true
          return row
        }),
        total: items.length,
        workspace: all ? null : workspace,
      }
    },

    /** Bind a card to the session that is handling it. */
    /** Read one workspace's general rules. */
    async 'rules.get'(payload) {
      const workspace = typeof payload?.workspace === 'string' ? payload.workspace : ''
      return store.getRules(workspace)
    },

    /** Replace one workspace's general rules (blank clears them). */
    async 'rules.set'(payload) {
      const workspace = typeof payload?.workspace === 'string' ? payload.workspace : ''
      return await store.setRules(workspace, payload?.text, now)
    },

    async handle(payload) {
      const id = resolveRef(store, payload)
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId === '') throw new TodoInputError('todo/session-required', 'sessionId 不能为空')
      const record = await store.setHandling(id, sessionId, now)
      return { item: projectL0(record) }
    },

    /** Full card for the right-sidebar detail expansion. */
    async detail(payload) {
      const record = requireRecord(store.get(resolveRef(store, payload)))
      return { item: projectFull(record) }
    },

    /** Manual creation from the right-sidebar tab. */
    async create(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const rootSessionId = sessionId !== '' && typeof resolveRoot === 'function' ? resolveRoot(sessionId) : ''
      const record = await store.create({ ...payload, rootSessionId }, now)
      const warnings = nextActionWarnings(payload?.nextStep, payload?.brief)
      return { item: projectL0(record), ...(warnings.length === 0 ? {} : { warnings }) }
    },

    /** Manual edit: title, status, next step. */
    async patch(payload) {
      const id = resolveRef(store, payload)
      const record = await store.update(id, payload?.patch, now)
      const warnings = nextActionWarnings(payload?.patch?.nextStep, payload?.patch?.brief)
      return { item: projectL0(record), ...(warnings.length === 0 ? {} : { warnings }) }
    },

    /** Delete a card. */
    async remove(payload) {
      const id = resolveRef(store, payload)
      await store.remove(id)
      return { id }
    },

    /** Append a note (M3 exposes this in the tab; the store is ready now). */
    async 'note.add'(payload) {
      const id = resolveRef(store, payload)
      const record = await store.addNote(id, payload, now)
      return { item: projectL0(record) }
    },

    /** Delete one note. */
    async 'note.remove'(payload) {
      const id = resolveRef(store, payload)
      const record = await store.removeNote(id, payload?.index)
      return { item: projectL0(record) }
    },
  }

  return {
    /** Endpoints this channel answers, for diagnostics. */
    endpoints: Object.keys(endpointMap),

    /**
     * Dispatch one decoded RPC call.
     *
     * @param endpoint - channel-relative endpoint name.
     * @param payload - decoded request payload.
     * @returns the wire result.
     */
    async handle(endpoint, payload) {
      const handler = endpointMap[endpoint]
      if (handler === undefined) return failure('todo/unknown-endpoint', `未知接口 ${endpoint}`)
      try {
        return { ok: true, value: await handler(payload) }
      } catch (error) {
        if (error instanceof TodoInputError) return failure(error.code, error.message)
        return failure('todo/internal', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
