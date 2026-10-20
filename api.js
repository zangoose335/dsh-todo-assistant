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
import { BRIEF_BASES } from './brief.js'
import { confirmTestEvidence } from './evidence.js'
import { affectedPhaseIds, diffIsEmpty, diffPlans } from './plan-diff.js'
import { importPreviewToProjectInput, parsePlanMarkdown, renderPlanMarkdown } from './plan-markdown.js'
import {
  CHANGE_KINDS,
  INBOX,
  NOTE_KINDS,
  PHASE_STATUSES,
  PLAN_LIMITS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  SOURCE_LIMIT,
  TodoInputError,
  addPhaseToProject,
  applyPatch,
  applyProjectPatch,
  buildPhaseContextPack,
  buildProject,
  buildRecord,
  mintId,
  mintPlanId,
  movePhaseInProject,
  normalizePhaseResultInput,
  projectFull,
  projectL0,
  projectPlanFull,
  projectPlanL0,
  recordPhaseResultInProject,
  removePhaseFromProject,
  setPhaseStatusInProject,
  splitPhaseInProject,
  updatePhaseInProject,
} from './domain.js'

/** Absolute logical RPC channel; the browser calls it through `ctx.connection.rpc`. */
export const CHANNEL = '/todo-assistant'

/** Maximum notes a card may accumulate before the editor is told to prune. */
const NOTE_LIMIT = 200
/** A single note is a sentence or two, never a summary. */
const NOTE_TEXT_LIMIT = 300

/** Source pointer field caps; sources carry pointers, not bodies. */
const SOURCE_SID_LIMIT = 80
const SOURCE_KIND_LIMIT = 40
const SOURCE_LABEL_LIMIT = 120
const SOURCE_PURPOSE_LIMIT = 200

/** Keep only the pointer-shaped `where` fields; drop empty/unknown fields. */
function normalizeSourceWhere(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const where = {}
  if (typeof input.sessionId === 'string' && input.sessionId.trim() !== '') where.sessionId = input.sessionId.trim()
  if (Array.isArray(input.seqRange) && input.seqRange.length === 2 && input.seqRange.every(Number.isInteger)) {
    where.seqRange = [input.seqRange[0], input.seqRange[1]]
  }
  if (typeof input.file === 'string' && input.file.trim() !== '') where.file = input.file.trim()
  return Object.keys(where).length === 0 ? undefined : where
}

/** Normalize one source pointer; reject an empty sid/kind/label. */
function normalizeSource(input, at) {
  const sid = typeof input?.sid === 'string' ? input.sid.trim().slice(0, SOURCE_SID_LIMIT) : ''
  if (sid === '') throw new TodoInputError('todo/source-sid-required', 'source.sid 不能为空')
  const kind = typeof input?.kind === 'string' ? input.kind.trim().slice(0, SOURCE_KIND_LIMIT) : ''
  if (kind === '') throw new TodoInputError('todo/source-kind-required', 'source.kind 不能为空')
  const label = typeof input?.label === 'string' ? input.label.trim().slice(0, SOURCE_LABEL_LIMIT) : ''
  if (label === '') throw new TodoInputError('todo/source-label-required', 'source.label 不能为空')
  const purpose = typeof input?.purpose === 'string' && input.purpose.trim() !== ''
    ? input.purpose.trim().slice(0, SOURCE_PURPOSE_LIMIT)
    : undefined
  const where = normalizeSourceWhere(input?.where)
  const turnRange = Array.isArray(input?.turnRange) && input.turnRange.length === 2 && input.turnRange.every(Number.isInteger)
    ? [input.turnRange[0], input.turnRange[1]]
    : undefined
  const origin = ['stated', 'captured', 'derived', 'observed'].includes(input?.origin) ? input.origin : 'stated'
  return {
    sid,
    kind,
    label,
    ...(purpose === undefined ? {} : { purpose }),
    ...(where === undefined ? {} : { where }),
    ...(turnRange === undefined ? {} : { turnRange }),
    origin,
    verified: input?.verified === true,
    at: Number.isInteger(input?.at) ? input.at : at,
  }
}

/** Stable identity for source dedupe: kind + where + seqRange. */
function sourceKey(source) {
  return JSON.stringify([
    source.kind,
    source.where?.sessionId ?? '',
    source.where?.seqRange ?? [],
    source.where?.file ?? '',
  ])
}

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

// ── Project Plan (B1) helpers ────────────────────────────────────────────────

/** Top-level project fields a change compares, in a stable order. */
const PROJECT_CHANGE_FIELDS = ['name', 'goal', 'status', 'currentPhaseId', 'phases', 'decisions', 'risks', 'sources']

/** The fields whose value differs between two project records. */
function changedProjectFields(before, after) {
  return PROJECT_CHANGE_FIELDS.filter(
    (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
  )
}

/** A JSON-safe `{ field: value }` map; an absent field is stored as `null`. */
function fieldMap(record, fields) {
  const map = {}
  for (const field of fields) map[field] = record[field] === undefined ? null : record[field]
  return map
}

/** Normalize a session origin for a project (the same shape as a card's). */
function normalizeProjectOrigin(input, at) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim().slice(0, 256) : ''
  if (sessionId === '') return undefined
  const seqRange =
    Array.isArray(input.seqRange) && input.seqRange.length === 2 && input.seqRange.every(Number.isInteger)
      ? [input.seqRange[0], input.seqRange[1]]
      : [0, 0]
  return {
    sessionId,
    turn: Number.isInteger(input.turn) ? Math.max(0, input.turn) : 0,
    seqRange,
    cwd: typeof input.cwd === 'string' ? input.cwd : '',
    at: Number.isInteger(input.at) ? input.at : at,
  }
}

/** Trim one plan reason; over the limit rejects instead of truncating. */
function planReason(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  const length = [...text].length
  if (length > limit) throw new TodoInputError('plan/reason-too-long', `reason 最多 ${limit} 个字符（当前 ${length}）`)
  return text
}

/** A stored project, or a `plan/not-found` rejection. */
function requireProject(value) {
  if (value === undefined) throw new TodoInputError('plan/not-found', '计划不存在，可能已被删除')
  return value
}

/** A stored proposal, or a `plan/not-found` rejection. */
function requireProposal(value) {
  if (value === undefined) throw new TodoInputError('plan/not-found', '提议不存在，可能已被删除')
  return value
}

/** Resolve one phase reference (pid, display number, or `Phase 4a`). */
function phaseByRef(project, ref) {
  const wanted = String(ref ?? '')
    .replace(/^#/u, '')
    .replace(/^(?:Phase|阶段)\s*/iu, '')
    .trim()
  if (wanted === '') throw new TodoInputError('plan/phase-id-required', 'phaseId 不能为空')
  const phase = (project.phases ?? []).find(
    (entry) => entry.pid === wanted || entry.number.toLowerCase() === wanted.toLowerCase(),
  )
  if (phase === undefined) {
    throw new TodoInputError('plan/phase-not-found', `阶段 ${wanted} 不存在`)
  }
  return phase
}

/** Resolve a list of phase references to pids, de-duplicated. */
function phaseIdsFrom(project, value) {
  if (!Array.isArray(value)) throw new TodoInputError('plan/invalid-dependencies', 'dependsOn 必须是编号数组')
  return [...new Set(value.map((ref) => phaseByRef(project, ref).pid))]
}

/** Convert string (or evidence-shaped) items into stored evidence refs. */
function evidenceFromTexts(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TodoInputError('plan/invalid-evidence', `${label} 必须是数组`)
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : typeof item?.text === 'string' ? item.text.trim() : ''))
    .filter((text) => text !== '')
    .map((text) => ({ label, text, basis: 'decided' }))
}

/** Resolve `{ id }` to a stored project id. */
function resolveProject(store, payload) {
  const ref = typeof payload?.id === 'string' ? payload.id.trim() : ''
  if (ref === '') throw new TodoInputError('plan/id-required', 'id 不能为空')
  const record = store.findProject(ref)
  if (record === undefined) throw new TodoInputError('plan/not-found', `计划 ${ref} 不存在`)
  return record.id
}

/** Resolve `{ id }` to a stored proposal id. */
function resolveProposal(store, payload) {
  const ref = typeof payload?.id === 'string' ? payload.id.trim() : ''
  if (ref === '') throw new TodoInputError('plan/id-required', '提议 id 不能为空')
  if (store.getProposal(ref) === undefined) throw new TodoInputError('plan/not-found', `提议 ${ref} 不存在`)
  return ref
}

/**
 * Open a typed view over the `todos` table.
 *
 * @param domain - the opened `todo-assistant` domain handle.
 * @param options - optional test seam: `limits` overrides {@link PLAN_LIMITS}.
 * @returns store operations shared by the RPC surface (and, later, the tools).
 */
export function createStore(domain, options = {}) {
  const table = domain.table('todos')
  const rulesTable = domain.table('rules')
  const projectsTable = domain.table('projects')
  const proposalsTable = domain.table('plan_proposals')
  const changesTable = domain.table('plan_changes')
  const limits = { ...PLAN_LIMITS, ...(options?.limits ?? {}) }

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

    /**
     * Append one source pointer to a card. Duplicate kind+where+seqRange
     * pointers are ignored; `updatedAt` is intentionally unchanged.
     *
     * @param id - card id.
     * @param input - source pointer fields.
     * @param now - clock override.
     * @returns the current record (with the source when appended).
     */
    async addSource(id, input, now) {
      const current = requireRecord(table.get(id))
      const source = normalizeSource(input, now())
      const key = sourceKey(source)
      if ((current.sources ?? []).some((existing) => sourceKey(existing) === key)) return current
      if ((current.sources ?? []).length >= SOURCE_LIMIT) {
        throw new TodoInputError('todo/source-limit', `sources 已达上限 ${SOURCE_LIMIT} 条`)
      }
      return await table.update(id, (latest) => {
        const sources = latest.sources ?? []
        if (sources.some((existing) => sourceKey(existing) === key)) return latest
        if (sources.length >= SOURCE_LIMIT) {
          throw new TodoInputError('todo/source-limit', `sources 已达上限 ${SOURCE_LIMIT} 条`)
        }
        return { ...latest, sources: [...sources, source] }
      })
    },

    /** Find one source pointer on a card, or undefined. */
    findSource(id, sid) {
      const record = table.get(id)
      if (record === undefined) return undefined
      return (record.sources ?? []).find((source) => source.sid === sid)
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
      const sourceIds = Array.isArray(input?.sourceIds)
        ? [...new Set(input.sourceIds.filter((sid) => typeof sid === 'string' && sid.trim() !== '').map((sid) => sid.trim()))].slice(0, 32)
        : []
      const basis = typeof input?.basis === 'string' && BRIEF_BASES.includes(input.basis) ? input.basis : undefined
      const role = typeof input?.role === 'string' && input.role.trim() !== '' ? input.role.trim().slice(0, 40) : undefined
      const note = {
        at: now(),
        fromSession: typeof input?.fromSession === 'string' ? input.fromSession : '',
        turn: Number.isInteger(input?.turn) ? input.turn : 0,
        kind,
        text,
        ...(basis === undefined ? {} : { basis }),
        ...(role === undefined ? {} : { role }),
        ...(sourceIds.length === 0 ? {} : { sourceIds }),
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

    // ── Project Plan (B1) ───────────────────────────────────────────────────

    /** Every stored project, newest change first. */
    allProjects() {
      const items = []
      for (const [, record] of projectsTable.entries()) items.push(record)
      items.sort(
        (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      )
      return items
    },

    /** One project by id, or undefined. */
    getProject(id) {
      return projectsTable.get(id)
    },

    /** Resolve a project id (projects carry no display number). */
    findProject(ref) {
      const text = typeof ref === 'string' ? ref.trim() : ''
      return text === '' ? undefined : projectsTable.get(text)
    },

    /** One stored proposal, or undefined. */
    getProposal(id) {
      return proposalsTable.get(id)
    },

    /** How many pending proposals one project has. */
    pendingProposalCount(projectId) {
      let count = 0
      for (const [, record] of proposalsTable.entries()) {
        if (record.projectId === projectId && record.status === 'pending') count += 1
      }
      return count
    },

    /** The project list projection, with its pending-proposal count. */
    projectRow(record) {
      return projectPlanL0(record, { pendingProposalCount: store.pendingProposalCount(record.id) })
    },

    /** The full project projection, with its pending-proposal count. */
    projectDetail(record) {
      return projectPlanFull(record, { pendingProposalCount: store.pendingProposalCount(record.id) })
    },

    /**
     * The phase handoff pack (B4): structured fields, source pointers, the
     * workspace rules, and the pending-proposal count. Read-only.
     *
     * @param projectId - project id.
     * @param phaseId - phase pid; omitted uses the project's current phase.
     * @returns the pack.
     */
    planContext(projectId, phaseId) {
      const project = requireProject(projectsTable.get(projectId))
      const pack = buildPhaseContextPack(project, phaseId)
      pack.pendingProposalCount = store.pendingProposalCount(project.id)
      pack.rules = store.getRules(project.workspace).text
      return pack
    },

    /**
     * Create one project (version 1) and record its `create` change.
     *
     * @param input - untrusted create payload.
     * @param at - write timestamp.
     * @returns the stored project and its initial change.
     */
    async createProject(input, at) {
      const project = buildProject(input, {
        now: () => at,
        nextId: () => mintPlanId('pj', (id) => projectsTable.get(id) !== undefined),
        // Phase pids only need to be unique inside the project; duplicates in the
        // payload are rejected by buildProject.
        phaseId: () => mintPlanId('ph', () => false),
        origin: normalizeProjectOrigin(input?.origin, at),
        limits,
      })
      await projectsTable.put(project.id, project)
      const change = {
        id: mintPlanId('pc', (id) => changesTable.get(id) !== undefined),
        projectId: project.id,
        version: project.version,
        at,
        by: 'developer',
        kind: 'create',
        reason: '',
        affectedPhaseIds: [],
        diff: { before: null, after: { ...project } },
        sourceIds: [],
      }
      await changesTable.put(change.id, change)
      return { project, change }
    },

    /**
     * The single write path for a stored project (PLAN.md §B1 item 2).
     *
     * @param id - project id.
     * @param patch - project-level patch.
     * @param options - timestamp, actor, kind, reason, ids, and the optional
     *   `baseVersion` (a mismatch rejects with `plan/stale`).
     * @returns the stored project and the appended change (none if nothing changed).
     */
    async applyChange(id, patch, options = {}) {
      const current = requireProject(projectsTable.get(id))
      const at = Number.isInteger(options.at) ? options.at : now()
      if (Number.isInteger(options.baseVersion) && options.baseVersion !== current.version) {
        throw new TodoInputError(
          'plan/stale',
          `计划已更新（当前版本 ${current.version}，提议基于 ${options.baseVersion}）；请重新读取 plan.detail 后再应用`,
        )
      }
      const next = applyProjectPatch(current, patch, at, { limits })
      const changed = changedProjectFields(current, next)
      if (changed.length === 0) return { project: current, change: undefined }
      const planDiff = diffPlans(current, next)
      const impacted = affectedPhaseIds(current, next, planDiff)
      const existing = store.changeCount(id)
      if (existing >= limits.changes) {
        throw new TodoInputError('plan/change-limit', `计划变更记录已达上限 ${limits.changes} 条；先归档或新建项目`)
      }
      const version = current.version + 1
      const change = {
        id: mintPlanId('pc', (candidate) => changesTable.get(candidate) !== undefined),
        projectId: id,
        version,
        at,
        by: options.by === 'proposal' || options.by === 'system' ? options.by : 'developer',
        kind: CHANGE_KINDS.includes(options.kind) ? options.kind : 'patch',
        reason: planReason(options.reason, limits.changeReason),
        affectedPhaseIds: impacted,
        // Summary-only (C4): the human diff, not full field copies except the
        // initial plan on create. `affectedPhaseIds` is computed from the diff.
        diff: { plan: planDiff },
        sourceIds: Array.isArray(options.sourceIds)
          ? [...new Set(options.sourceIds.filter((sid) => typeof sid === 'string' && sid.trim() !== ''))].slice(0, SOURCE_LIMIT)
          : [],
      }
      const updated = { ...next, version }
      await projectsTable.put(id, updated)
      await changesTable.put(change.id, change)
      return { project: updated, change }
    },

    // ── Phase operations (B2) ───────────────────────────────────────────────

    /** Append one phase to a project. */
    async addPhase(projectId, input, at) {
      const current = requireProject(projectsTable.get(projectId))
      const { patch, affectedPhaseIds } = addPhaseToProject(current, input, at, {
        phaseId: () => mintPlanId('ph', () => false),
        limits,
      })
      return await store.applyChange(projectId, patch, { at, kind: 'phase-add', affectedPhaseIds, reason: input?.reason })
    },

    /** Edit one phase's fields. */
    async updatePhase(projectId, phaseId, patch, at, reason) {
      const current = requireProject(projectsTable.get(projectId))
      const result = updatePhaseInProject(current, phaseId, patch, at, { limits })
      return await store.applyChange(projectId, result.patch, {
        at,
        kind: 'phase-update',
        affectedPhaseIds: result.affectedPhaseIds,
        reason,
      })
    },

    /** Remove one phase (rejects dependents and children; clears current). */
    async removePhase(projectId, phaseId, at, reason) {
      const current = requireProject(projectsTable.get(projectId))
      const result = removePhaseFromProject(current, phaseId, at, { limits })
      return await store.applyChange(projectId, result.patch, {
        at,
        kind: 'phase-remove',
        affectedPhaseIds: result.affectedPhaseIds,
        reason,
      })
    },

    /** Split one phase into children (`4` → `4a/4b/4c`). */
    async splitPhase(projectId, phaseId, children, at, reason) {
      const current = requireProject(projectsTable.get(projectId))
      const result = splitPhaseInProject(current, phaseId, children, at, {
        phaseId: () => mintPlanId('ph', () => false),
        limits,
      })
      return await store.applyChange(projectId, result.patch, {
        at,
        kind: 'phase-split',
        affectedPhaseIds: result.affectedPhaseIds,
        reason,
      })
    },

    /** Reorder one phase within its parent group (numbers do not change). */
    async movePhase(projectId, phaseId, input, at, reason) {
      const current = requireProject(projectsTable.get(projectId))
      const result = movePhaseInProject(current, phaseId, input, at, { limits })
      return await store.applyChange(projectId, result.patch, {
        at,
        kind: 'phase-move',
        affectedPhaseIds: result.affectedPhaseIds,
        reason,
      })
    },

    /** Change one phase's status (`split` and split parents are rejected). */
    async setPhaseStatus(projectId, phaseId, status, at, reason) {
      const current = requireProject(projectsTable.get(projectId))
      const result = setPhaseStatusInProject(current, phaseId, status, at, { limits })
      return await store.applyChange(projectId, result.patch, {
        at,
        kind: 'phase-status',
        affectedPhaseIds: result.affectedPhaseIds,
        reason,
      })
    },

    /** Record (or replace) one phase's result; the status is untouched. */
    async recordPhaseResult(projectId, phaseId, result, sessionId, at, reason) {
      const current = requireProject(projectsTable.get(projectId))
      const resultInput =
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        typeof result.recordedBySession !== 'string' &&
        typeof sessionId === 'string' &&
        sessionId !== ''
          ? { ...result, recordedBySession: sessionId }
          : result
      const applied = recordPhaseResultInProject(current, phaseId, resultInput, at, { limits })
      return await store.applyChange(projectId, applied.patch, {
        at,
        kind: 'phase-result',
        affectedPhaseIds: applied.affectedPhaseIds,
        reason,
      })
    },

    /**
     * Delete a project and every proposal/change that belongs to it. Cards that
     * point at it keep their (now dangling) weak link.
     *
     * @param id - project id.
     * @returns the removed project and the cascade counts.
     */
    async removeProject(id) {
      const current = requireProject(projectsTable.get(id))
      let proposals = 0
      let changes = 0
      for (const [key, record] of proposalsTable.entries()) {
        if (record.projectId !== id) continue
        await proposalsTable.delete(key)
        proposals += 1
      }
      for (const [key, record] of changesTable.entries()) {
        if (record.projectId !== id) continue
        await changesTable.delete(key)
        changes += 1
      }
      await projectsTable.delete(id)
      return { project: current, proposals, changes }
    },

    /** How many changes one project has recorded. */
    changeCount(projectId) {
      let count = 0
      for (const [, record] of changesTable.entries()) if (record.projectId === projectId) count += 1
      return count
    },

    /** How many proposals one project has (optionally in one status). */
    proposalCount(projectId, status) {
      let count = 0
      for (const [, record] of proposalsTable.entries()) {
        if (record.projectId !== projectId) continue
        if (status !== undefined && record.status !== status) continue
        count += 1
      }
      return count
    },

    /** Proposals for one project, newest first. */
    proposalsFor(projectId, status) {
      const items = []
      for (const [, record] of proposalsTable.entries()) {
        if (record.projectId !== projectId) continue
        if (status !== undefined && record.status !== status) continue
        items.push(record)
      }
      items.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      return items
    },

    /**
     * Record one pending proposal. Every kind is dry-run against the current
     * project first, so a proposal that could never apply is never stored and
     * the project itself is untouched. The host also computes the structured
     * diff and affected phases here (PLAN.md §C2).
     *
     * @param input - `{ projectId, baseVersion, kind?, ...payload, reason?, proposedBySession? }`.
     * @param at - write timestamp.
     * @returns the stored proposal.
     */
    async addProposal(input, at) {
      const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : ''
      const project = requireProject(projectsTable.get(projectId))
      if (!Number.isInteger(input?.baseVersion) || input.baseVersion < 1) {
        throw new TodoInputError('plan/base-version-required', 'baseVersion 必须是正整数（先读 plan/detail 或 todo_plan_read）')
      }
      if (input.baseVersion !== project.version) {
        throw new TodoInputError(
          'plan/stale',
          `提议基于第 ${input.baseVersion} 版，计划已是第 ${project.version} 版；先重新读取再提议`,
        )
      }
      const kind = input?.kind === undefined ? 'project-patch' : input.kind
      if (!PROPOSAL_KINDS.includes(kind)) {
        throw new TodoInputError('plan/invalid-kind', `kind 必须是 ${PROPOSAL_KINDS.join(' / ')}`)
      }
      const proposal = {
        id: mintPlanId('pp', (id) => proposalsTable.get(id) !== undefined),
        projectId,
        baseVersion: input.baseVersion,
        kind,
        reason: planReason(input?.reason, limits.proposalReason),
        proposedBySession:
          typeof input?.proposedBySession === 'string' ? input.proposedBySession.trim().slice(0, 256) : '',
        status: 'pending',
        createdAt: at,
      }
      let next = project

      if (kind === 'project-patch') {
        if (input?.patch === null || input.patch === undefined || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
          throw new TodoInputError('plan/invalid-patch', 'project-patch 提议必须带 patch')
        }
        next = applyProjectPatch(project, input.patch, at, { limits })
        proposal.patch = { ...input.patch }
      } else if (kind === 'phase-result') {
        const phaseId = typeof input?.phaseId === 'string' ? input.phaseId.trim() : ''
        if (phaseId === '') throw new TodoInputError('plan/phase-id-required', 'phase-result 提议必须带 phaseId')
        const phase = (project.phases ?? []).find((entry) => entry.pid === phaseId)
        if (phase === undefined) throw new TodoInputError('plan/phase-not-found', `阶段 ${phaseId} 不存在`)
        proposal.phaseId = phaseId
        proposal.result = normalizePhaseResultInput(input?.result, at, { limits })
        if (input?.status !== undefined) {
          if (!PHASE_STATUSES.includes(input.status)) {
            throw new TodoInputError('plan/invalid-phase-status', `status 必须是 ${PHASE_STATUSES.join(' / ')}`)
          }
          if (input.status === 'split') {
            throw new TodoInputError('plan/phase-status-split', 'split 只能通过拆分产生')
          }
          if (phase.status === 'split') {
            throw new TodoInputError('plan/phase-is-split', `阶段 ${phase.number} 已拆分；状态由子阶段体现`)
          }
          proposal.suggestedStatus = input.status
        }
        const nextPhases = (project.phases ?? []).map((entry) =>
          entry.pid === phaseId
            ? {
                ...entry,
                result: proposal.result,
                ...(proposal.suggestedStatus === undefined ? {} : { status: proposal.suggestedStatus }),
                updatedAt: at,
              }
            : entry,
        )
        next = applyProjectPatch(project, { phases: nextPhases }, at, { limits })
      } else if (kind === 'phase-add') {
        const number = String(input?.number ?? '').trim()
        const title = String(input?.title ?? '').trim()
        if (number === '') throw new TodoInputError('plan/phase-number-required', '新增阶段必须给 number')
        if (title === '') throw new TodoInputError('plan/invalid-phase', '新增阶段必须给 title')
        let parentPid
        if (input?.parentNumber !== undefined && input.parentNumber !== null && String(input.parentNumber).trim() !== '') {
          parentPid = phaseByRef(project, input.parentNumber).pid
        } else if (typeof input?.parentPid === 'string' && input.parentPid.trim() !== '') {
          parentPid = phaseByRef(project, input.parentPid).pid
        }
        const pid = mintPlanId('ph', (id) => (project.phases ?? []).some((entry) => entry.pid === id))
        const phaseInput = {
          pid,
          number,
          title,
          goal: typeof input?.goal === 'string' ? input.goal : '',
          nextStep: typeof input?.nextStep === 'string' ? input.nextStep : '',
          ...(parentPid === undefined ? {} : { parentPid }),
          dependsOn: input?.dependsOn === undefined ? [] : phaseIdsFrom(project, input.dependsOn),
          acceptance: evidenceFromTexts(input?.acceptance, 'acceptance') ?? [],
          mustKeep: evidenceFromTexts(input?.mustKeep, 'context') ?? [],
          decisions: evidenceFromTexts(input?.decisions, 'decision') ?? [],
        }
        const built = addPhaseToProject(project, phaseInput, at, {
          phaseId: () => pid,
          limits,
        })
        next = applyProjectPatch(project, built.patch, at, { limits })
        proposal.payload = phaseInput
      } else if (kind === 'phase-split') {
        const phase = phaseByRef(project, input?.phaseId)
        const children = Array.isArray(input?.children) ? input.children : []
        if (children.length === 0) throw new TodoInputError('plan/split-children-required', '拆分提议至少需要一个子阶段')
        const prepared = children.map((child) => {
          const title = String(child?.title ?? '').trim()
          if (title === '') throw new TodoInputError('plan/invalid-phase', '子阶段必须给 title')
          const pid = mintPlanId('ph', (id) => (project.phases ?? []).some((entry) => entry.pid === id))
          return {
            pid,
            title,
            ...(child?.number === undefined || String(child.number).trim() === '' ? {} : { number: String(child.number).trim() }),
            ...(typeof child?.goal === 'string' ? { goal: child.goal } : {}),
          }
        })
        const built = splitPhaseInProject(project, phase.pid, prepared, at, {
          phaseId: () => prepared[0].pid,
          limits,
        })
        next = applyProjectPatch(project, built.patch, at, { limits })
        const beforePids = new Set((project.phases ?? []).map((entry) => entry.pid))
        const added = (next.phases ?? [])
          .filter((entry) => entry.parentPid === phase.pid && !beforePids.has(entry.pid))
          .map((entry) => ({ pid: entry.pid, number: entry.number, title: entry.title, goal: entry.goal }))
        proposal.payload = { phaseId: phase.pid, children: added }
      } else if (kind === 'dependency') {
        const phase = phaseByRef(project, input?.phaseId)
        if (!Array.isArray(input?.dependsOn)) {
          throw new TodoInputError('plan/invalid-dependencies', 'dependency 提议必须带 dependsOn 编号数组')
        }
        const dependsOn = phaseIdsFrom(project, input.dependsOn)
        const built = updatePhaseInProject(project, phase.pid, { dependsOn }, at, { limits })
        next = applyProjectPatch(project, built.patch, at, { limits })
        proposal.payload = { phaseId: phase.pid, dependsOn }
      } else if (kind === 'acceptance') {
        const phase = phaseByRef(project, input?.phaseId)
        const patch = {}
        if (input?.acceptance !== undefined) patch.acceptance = evidenceFromTexts(input.acceptance, 'acceptance')
        if (input?.mustKeep !== undefined) patch.mustKeep = evidenceFromTexts(input.mustKeep, 'context')
        if (input?.decisions !== undefined) patch.decisions = evidenceFromTexts(input.decisions, 'decision')
        if (Object.keys(patch).length === 0) {
          throw new TodoInputError('plan/no-change', 'acceptance 提议至少要改 acceptance/mustKeep/decisions 之一')
        }
        const built = updatePhaseInProject(project, phase.pid, patch, at, { limits })
        next = applyProjectPatch(project, built.patch, at, { limits })
        proposal.payload = { phaseId: phase.pid, ...patch }
      }

      const diff = diffPlans(project, next)
      if (diffIsEmpty(diff)) throw new TodoInputError('plan/no-change', '提议没有改变计划：先确认要改什么')
      proposal.diff = diff
      proposal.affectedPhaseIds = affectedPhaseIds(project, next, diff)
      if (store.proposalCount(projectId) >= limits.proposals) {
        throw new TodoInputError('plan/proposal-limit', `提议已达上限 ${limits.proposals} 条`)
      }
      if (store.proposalCount(projectId, 'pending') >= limits.pendingProposals) {
        throw new TodoInputError('plan/pending-proposal-limit', `待处理提议已达上限 ${limits.pendingProposals} 条；先应用或拒绝`)
      }
      await proposalsTable.put(proposal.id, proposal)
      return proposal
    },

    /**
     * Apply a pending proposal: version + change, then mark it applied. A stale
     * `baseVersion` rejects before anything is written. For a `phase-result`
     * proposal, `confirmTests` is the developer's explicit "I checked the tests"
     * and upgrades tests without tool evidence to `developer`.
     *
     * @param id - proposal id.
     * @param at - write timestamp.
     * @param options - `confirmTests` (phase-result only).
     * @returns the stored project, the change, and the updated proposal.
     */
    async applyProposal(id, at, options = {}) {
      const proposal = requireProposal(proposalsTable.get(id))
      if (proposal.status !== 'pending') {
        throw new TodoInputError('plan/proposal-not-pending', `提议状态是 ${proposal.status}，只有 pending 可以应用`)
      }
      const project = requireProject(projectsTable.get(proposal.projectId))
      if (proposal.baseVersion !== project.version) {
        throw new TodoInputError(
          'plan/stale',
          `提议基于版本 ${proposal.baseVersion}，计划已是 ${project.version}；请重新读取 plan/detail 后重新提议`,
        )
      }
      const appliedProposal = async (updated, change) => {
        const applied = { ...proposal, status: 'applied', appliedAt: at }
        await proposalsTable.put(id, applied)
        return { project: updated, change, proposal: applied }
      }

      if (proposal.kind === 'phase-result') {
        const phases = project.phases ?? []
        const phase = phases.find((entry) => entry.pid === proposal.phaseId)
        if (phase === undefined) throw new TodoInputError('plan/phase-not-found', `阶段 ${proposal.phaseId} 不存在`)
        const result = options.confirmTests === true ? confirmTestEvidence(proposal.result) : proposal.result
        if (result === null || typeof result !== 'object') {
          throw new TodoInputError('plan/invalid-result', '提议没有可应用的结果')
        }
        const nextPhases = phases.map((entry) => {
          if (entry.pid !== proposal.phaseId) return entry
          return {
            ...entry,
            result,
            ...(proposal.suggestedStatus === undefined ? {} : { status: proposal.suggestedStatus }),
            updatedAt: at,
          }
        })
        const { project: updated, change } = await store.applyChange(
          project.id,
          { phases: nextPhases },
          {
            at,
            by: 'proposal',
            baseVersion: proposal.baseVersion,
            kind: 'phase-result',
            affectedPhaseIds: proposal.affectedPhaseIds,
            reason: proposal.reason,
            sourceIds: [],
          },
        )
        return appliedProposal(updated, change)
      }

      if (proposal.kind === 'project-patch') {
        const { project: updated, change } = await store.applyChange(project.id, proposal.patch, {
          at,
          by: 'proposal',
          baseVersion: proposal.baseVersion,
          affectedPhaseIds: proposal.affectedPhaseIds,
          reason: proposal.reason,
          sourceIds: [],
        })
        return appliedProposal(updated, change)
      }

      const payload = proposal.payload ?? {}
      let built
      let kind
      if (proposal.kind === 'phase-add') {
        built = addPhaseToProject(project, payload, at, { phaseId: () => payload.pid, limits })
        kind = 'phase-add'
      } else if (proposal.kind === 'phase-split') {
        built = splitPhaseInProject(project, payload.phaseId, payload.children ?? [], at, {
          phaseId: () => {
            throw new TodoInputError('plan/phase-pid-required', '拆分提议缺少子阶段 pid')
          },
          limits,
        })
        kind = 'phase-split'
      } else if (proposal.kind === 'dependency') {
        built = updatePhaseInProject(project, payload.phaseId, { dependsOn: payload.dependsOn ?? [] }, at, { limits })
        kind = 'phase-update'
      } else if (proposal.kind === 'acceptance') {
        built = updatePhaseInProject(
          project,
          payload.phaseId,
          {
            ...(payload.acceptance === undefined ? {} : { acceptance: payload.acceptance }),
            ...(payload.mustKeep === undefined ? {} : { mustKeep: payload.mustKeep }),
            ...(payload.decisions === undefined ? {} : { decisions: payload.decisions }),
          },
          at,
          { limits },
        )
        kind = 'phase-update'
      } else {
        throw new TodoInputError('plan/invalid-kind', `未知提议类型 ${proposal.kind}`)
      }
      const { project: updated, change } = await store.applyChange(project.id, built.patch, {
        at,
        by: 'proposal',
        baseVersion: proposal.baseVersion,
        kind,
        affectedPhaseIds: proposal.affectedPhaseIds,
        reason: proposal.reason,
        sourceIds: [],
      })
      return appliedProposal(updated, change)
    },

    /**
     * Reject a pending proposal; the project is untouched.
     *
     * @param id - proposal id.
     * @param reason - why it was rejected (optional).
     * @param at - write timestamp.
     * @returns the updated proposal.
     */
    async rejectProposal(id, reason, at) {
      const proposal = requireProposal(proposalsTable.get(id))
      if (proposal.status !== 'pending') {
        throw new TodoInputError('plan/proposal-not-pending', `提议状态是 ${proposal.status}，只有 pending 可以拒绝`)
      }
      const rejectedReason = planReason(reason, limits.proposalReason)
      const next = { ...proposal, status: 'rejected', rejectedAt: at }
      if (rejectedReason !== '') next.rejectedReason = rejectedReason
      await proposalsTable.put(id, next)
      return next
    },

    /** One project's changes, oldest version first, with offset pagination. */
    changesFor(projectId, limit, offset) {
      const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, limits.changes) : 50
      const start = Number.isInteger(offset) && offset > 0 ? Math.min(offset, limits.changes) : 0
      const items = []
      for (const [, record] of changesTable.entries()) if (record.projectId === projectId) items.push(record)
      items.sort((left, right) => left.version - right.version || left.at - right.at || left.id.localeCompare(right.id))
      const page = items.slice(start, start + cap)
      return { items: page, total: items.length, offset: start, limit: cap, nextOffset: start + page.length }
    },

    /** The full initial project snapshot stored on the create change. */
    initialProject(projectId) {
      const create = [...changesTable.entries()]
        .map(([, change]) => change)
        .filter((change) => change.projectId === projectId && change.version === 1 && change.kind === 'create')
        .sort((left, right) => left.version - right.version)[0]
      const raw = create?.diff?.initial ?? create?.diff?.after
      if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.phases)) return undefined
      return { ...raw, version: 1 }
    },

    /** One change record by version. */
    changeAt(projectId, version) {
      for (const [, change] of changesTable.entries()) {
        if (change.projectId === projectId && change.version === version) return change
      }
      return undefined
    },

    /**
     * Rebuild a legacy (pre-C4) version from its stored changed-field values.
     * Summary-only changes cannot be replayed, so a mix returns undefined.
     */
    legacyState(projectId, targetVersion) {
      const initial = store.initialProject(projectId)
      if (initial === undefined) return undefined
      let state = { ...initial }
      const changes = [...changesTable.entries()]
        .map(([, change]) => change)
        .filter((change) => change.projectId === projectId && change.version > 1 && change.version <= targetVersion)
        .sort((left, right) => left.version - right.version)
      for (const change of changes) {
        if (change.diff?.plan !== undefined) return undefined
        if (change.diff?.after === undefined) return undefined
        state = { ...state, ...change.diff.after, version: change.version }
      }
      return state
    },

    /** The structured summary for one change: stored, or computed for legacy. */
    changePlan(projectId, change) {
      if (change?.diff?.plan !== undefined) return change.diff.plan
      if (change === undefined || change.version <= 1) return undefined
      const before = store.legacyState(projectId, change.version - 1)
      const after = store.legacyState(projectId, change.version)
      if (before === undefined || after === undefined) return undefined
      return diffPlans(before, after)
    },

    /**
     * A diff view. Only two ranges are supported by the summary-only history:
     * initial→current and one consecutive change. Other ranges need full
     * snapshots, which C4 deliberately does not store.
     */
    changeDiff(projectId, from, to) {
      const project = requireProject(projectsTable.get(projectId))
      const target = Number.isInteger(to) ? to : project.version
      const source = Number.isInteger(from) ? from : Math.max(1, target - 1)
      if (target < 1 || target > project.version || source < 1 || source > target) {
        throw new TodoInputError('plan/invalid-range', `版本范围 ${source}→${target} 不合法（当前 ${project.version}）`)
      }
      if (source === target) {
        return { fromVersion: source, toVersion: target, diff: diffPlans(project, project), source: 'empty' }
      }
      if (source === 1 && target === project.version) {
        const initial = store.initialProject(projectId)
        if (initial === undefined) throw new TodoInputError('plan/replay-unavailable', '找不到初始计划快照')
        return { fromVersion: 1, toVersion: target, diff: diffPlans(initial, project), source: 'initial' }
      }
      if (target === source + 1) {
        const change = store.changeAt(projectId, target)
        if (change === undefined) throw new TodoInputError('plan/change-not-found', `第 ${target} 版没有变更记录`)
        const plan = store.changePlan(projectId, change)
        if (plan === undefined) {
          throw new TodoInputError(
            'plan/replay-unavailable',
            '历史只保存摘要，无法重放这一段；可查看该版变更前后的摘要或“初始 vs 当前”',
          )
        }
        return {
          fromVersion: source,
          toVersion: target,
          diff: plan,
          source: change.diff?.plan === undefined ? 'computed' : 'stored',
        }
      }
      throw new TodoInputError(
        'plan/replay-unavailable',
        '历史只保存摘要，不能重建任意中间版本；支持初始→当前和单条变更',
      )
    },

    /** Initial (v1) or current project detail; other versions are unavailable. */
    versionShow(projectId, version) {
      const project = requireProject(projectsTable.get(projectId))
      if (version === project.version) {
        return { item: store.projectDetail(project), version, available: true }
      }
      if (version === 1) {
        const initial = store.initialProject(projectId)
        if (initial === undefined) throw new TodoInputError('plan/version-unavailable', '找不到初始计划快照')
        return { item: projectPlanFull(initial, { pendingProposalCount: 0 }), version, available: true }
      }
      throw new TodoInputError(
        'plan/version-unavailable',
        '历史只保存摘要，只能查看初始版和当前版；其他版本可看单条变更的 diff',
      )
    },

    /** A merged decision timeline: decision/risk deltas plus proposal outcomes. */
    decisionTimeline(projectId, { limit = 20, offset = 0 } = {}) {
      const project = requireProject(projectsTable.get(projectId))
      const items = []
      const initial = store.initialProject(projectId)
      if (initial !== undefined) {
        const create = store.changeAt(projectId, 1)
        for (const decision of initial.decisions ?? []) {
          items.push({
            type: 'change',
            version: 1,
            at: create?.at ?? initial.createdAt,
            by: 'developer',
            kind: 'create',
            reason: '',
            scope: 'project',
            field: 'decision',
            action: 'added',
            text: decision.text,
            sourceIds: [],
          })
        }
        for (const risk of initial.risks ?? []) {
          items.push({
            type: 'change',
            version: 1,
            at: create?.at ?? initial.createdAt,
            by: 'developer',
            kind: 'create',
            reason: '',
            scope: 'project',
            field: 'risk',
            action: 'added',
            text: risk.text,
            sourceIds: [],
          })
        }
      }
      const changes = [...changesTable.entries()]
        .map(([, change]) => change)
        .filter((change) => change.projectId === projectId && change.version > 1)
        .sort((left, right) => left.version - right.version)
      for (const change of changes) {
        const plan = store.changePlan(projectId, change)
        if (plan === undefined) continue
        for (const field of ['decisions', 'risks']) {
          const delta = plan[field] ?? {}
          for (const action of ['added', 'removed']) {
            for (const text of delta[action] ?? []) {
              items.push({
                type: 'change',
                version: change.version,
                at: change.at,
                by: change.by,
                kind: change.kind,
                reason: change.reason,
                scope: 'project',
                field: field === 'decisions' ? 'decision' : 'risk',
                action,
                text,
                sourceIds: change.sourceIds ?? [],
              })
            }
          }
        }
        for (const entry of plan.acceptance ?? []) {
          if (entry.field !== 'decisions') continue
          for (const action of ['added', 'removed']) {
            for (const text of entry[action] ?? []) {
              items.push({
                type: 'change',
                version: change.version,
                at: change.at,
                by: change.by,
                kind: change.kind,
                reason: change.reason,
                scope: 'phase',
                phaseId: entry.pid,
                phaseNumber: entry.number,
                phaseTitle: entry.title,
                field: 'decision',
                action,
                text,
                sourceIds: change.sourceIds ?? [],
              })
            }
          }
        }
      }
      items.sort((left, right) => right.at - left.at || (right.version ?? 0) - (left.version ?? 0))
      const start = Number.isInteger(offset) && offset > 0 ? offset : 0
      const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
      return { items: items.slice(start, start + cap), total: items.length, offset: start, nextOffset: start + cap }
    },

    /**
     * A JSON snapshot for `plan.export` (B3 renders Markdown from the same data).
     *
     * @param id - project id.
     * @returns the full project plus its change history.
     */
    exportProject(id, { includeDiff = false } = {}) {
      const project = requireProject(projectsTable.get(id))
      const { items } = store.changesFor(id, limits.changes)
      return {
        project: store.projectDetail(project),
        changes: items.map((change) => ({
          version: change.version,
          at: change.at,
          by: change.by,
          kind: change.kind,
          reason: change.reason,
          affectedPhaseIds: change.affectedPhaseIds ?? [],
          sourceIds: change.sourceIds ?? [],
          ...(includeDiff ? { diff: change.diff } : {}),
        })),
      }
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
 * @param options.resolveSessionWorkspace - optional async session-id → workspace-key
 *   resolver used by `list` when `bySession` is true and `sessionId` is non-empty.
 *   `host.js` wires it to the session's cwd and the workspace registry; this module
 *   only calls it. A thrown resolver error is caught by `list`, which falls back to
 *   INBOX.
 * @returns `{ handle(endpoint, payload) }` answering wire results.
 */
function changeSummaryMarkdown(changes) {
  const lines = ['## 变更摘要', '']
  if (!Array.isArray(changes) || changes.length === 0) {
    lines.push('- 无')
  } else {
    for (const change of changes) {
      lines.push(`- v${change.version} · ${change.kind} · ${change.by}${change.reason ? ` · ${change.reason}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function createApi({ store, now = Date.now, hitIds, resolveRoot, resolveSessionWorkspace, writePlanFile }) {
  const endpointMap = {
    /**
     * List cards for one bucket, or every bucket.
     *
     * Filtering:
     * - `all: true` without `bySession` returns every workspace; the result
     *   `workspace` is null.
     * - `bySession: true` with a non-empty string `sessionId` resolves that
     *   session's workspace through `resolveSessionWorkspace` and returns the
     *   cards in it. If the resolver is absent, `payload.workspace`/INBOX is
     *   used; if it throws, the endpoint falls back to INBOX.
     * - `bySession: true` with an empty/missing `sessionId` does not call the
     *   resolver; `all` is false and `payload.workspace`/INBOX is used.
     * - Otherwise, `payload.workspace`/INBOX is used.
     *
     * A non-empty `sessionId` is also passed to `hitIds`, whether or not
     * `bySession` is set. Host-level fallbacks: `host.js` resolves a missing
     * session/cwd to INBOX; when the workspace registry is absent, or
     * `resolveByPath` returns undefined or throws, it falls back to the session
     * cwd.
     */
    async list(payload) {
      const all = payload?.all === true && payload?.bySession !== true
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      let workspace = typeof payload?.workspace === 'string' ? payload.workspace : INBOX
      if (payload?.bySession === true && sessionId !== '' && typeof resolveSessionWorkspace === 'function') {
        try {
          workspace = await resolveSessionWorkspace(sessionId)
        } catch {
          workspace = INBOX
        }
      }
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

    // ── Project Plan (B1 endpoints, PLAN.md §B1 item 3) ─────────────────────

    /**
     * List project plans for one workspace, or every workspace (`all: true`).
     * Only the plan tables are read; ordinary cards are unaffected.
     */
    async 'plan.list'(payload) {
      const all = payload?.all === true
      const workspace = all
        ? null
        : typeof payload?.workspace === 'string' && payload.workspace !== ''
          ? payload.workspace
          : INBOX
      const items = store.allProjects().filter((project) => all || project.workspace === workspace)
      return { items: items.map((project) => store.projectRow(project)), total: items.length, workspace }
    },

    /** Full project for the detail view / AI read; phases included. */
    async 'plan.detail'(payload) {
      const id = resolveProject(store, payload)
      return { item: store.projectDetail(store.getProject(id)) }
    },

    /**
     * The phase handoff pack (B4). `phaseId` omitted uses the current phase.
     * Read-only: it never bumps the project version.
     */
    async 'plan.context'(payload) {
      const id = resolveProject(store, payload)
      return { pack: store.planContext(id, payload?.phaseId) }
    },

    /**
     * Create a project plan. `phases` may seed 阶段; phase.* operations are B2.
     * Creation records a `create` change, so the initial plan stays auditable.
     */
    async 'plan.create'(payload) {
      const { project } = await store.createProject(payload, now())
      return { item: store.projectRow(project) }
    },

    /**
     * Apply a project-level patch. `baseVersion` (optional) turns a stale write
     * into `plan/stale`; every accepted patch bumps `version` and appends a change.
     */
    async 'plan.patch'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.applyChange(id, payload?.patch, {
        at: now(),
        baseVersion: payload?.baseVersion,
        reason: payload?.reason,
        sourceIds: payload?.sourceIds,
      })
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    // ── Phase endpoints (B2) ────────────────────────────────────────────────

    /** Append one phase; `number` is required here (display numbers stay explicit). */
    async 'plan.phase.add'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.addPhase(id, payload, now())
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Edit one phase's fields; status/result have their own endpoints. */
    async 'plan.phase.update'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.updatePhase(id, payload?.phaseId, payload?.patch, now(), payload?.reason)
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Remove one phase; rejects dependents/children, clears a removed current phase. */
    async 'plan.phase.remove'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.removePhase(id, payload?.phaseId, now(), payload?.reason)
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Split one phase into children (`children` = phase-shaped objects). */
    async 'plan.phase.split'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.splitPhase(id, payload?.phaseId, payload?.children, now(), payload?.reason)
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Reorder one phase within its parent group (beforePid/afterPid). */
    async 'plan.phase.move'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.movePhase(id, payload?.phaseId, payload, now(), payload?.reason)
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Change one phase's status; `split` is reached only through plan.phase.split. */
    async 'plan.phase.status'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.setPhaseStatus(id, payload?.phaseId, payload?.status, now(), payload?.reason)
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Record (or replace) one phase's actual result; the status is unchanged. */
    async 'plan.phase.result'(payload) {
      const id = resolveProject(store, payload)
      const { project, change } = await store.recordPhaseResult(
        id,
        payload?.phaseId,
        payload?.result,
        payload?.sessionId,
        now(),
        payload?.reason,
      )
      return { item: store.projectRow(project), ...(change === undefined ? {} : { change }) }
    },

    /** Delete a project and cascade its proposals/changes (cards keep dangling links). */
    async 'plan.remove'(payload) {
      const id = resolveProject(store, payload)
      const { proposals, changes } = await store.removeProject(id)
      return { id, removed: { proposals, changes } }
    },

    /** Proposals recorded for one project, newest first (`status` optional). */
    async 'plan.proposal.list'(payload) {
      const id = resolveProject(store, payload)
      const status = PROPOSAL_STATUSES.includes(payload?.status) ? payload.status : undefined
      const items = store.proposalsFor(id, status)
      return { items, total: items.length }
    },

    /** Apply a pending proposal; a stale `baseVersion` rejects before writing. */
    async 'plan.proposal.apply'(payload) {
      const id = resolveProposal(store, payload)
      const { project, change, proposal } = await store.applyProposal(id, now(), {
        confirmTests: payload?.confirmTests === true,
      })
      return { item: store.projectRow(project), proposal, ...(change === undefined ? {} : { change }) }
    },

    /** Reject a pending proposal; the project is untouched. */
    async 'plan.proposal.reject'(payload) {
      const id = resolveProposal(store, payload)
      const proposal = await store.rejectProposal(id, payload?.reason, now())
      return { item: proposal }
    },

    /** One project's applied changes, oldest version first (`limit` optional). */
    async 'plan.change.list'(payload) {
      const id = resolveProject(store, payload)
      return { id, ...store.changesFor(id, payload?.limit, payload?.offset) }
    },

    /** A diff for one consecutive change, or initial→current. */
    async 'plan.change.diff'(payload) {
      const id = resolveProject(store, payload)
      return { id, ...store.changeDiff(id, payload?.from, payload?.to) }
    },

    /** The initial snapshot or the current project (other versions unavailable). */
    async 'plan.version.show'(payload) {
      const id = resolveProject(store, payload)
      const record = store.getProject(id)
      const version = Number.isInteger(payload?.version) ? payload.version : record.version
      return { id, ...store.versionShow(id, version) }
    },

    /** Decision/risk deltas plus applied/rejected proposal outcomes. */
    async 'plan.decision.list'(payload) {
      const id = resolveProject(store, payload)
      return { id, ...store.decisionTimeline(id, { limit: payload?.limit, offset: payload?.offset }) }
    },

    // ── Markdown import/export (B3) ─────────────────────────────────────────

    /** Parse the developer's Markdown into an editable preview; never writes. */
    async 'plan.import.preview'(payload) {
      return { preview: parsePlanMarkdown(payload?.text) }
    },

    /**
     * Create a project from a (possibly edited) preview. Inferred dependency
     * bindings / auto numbers must be confirmed first; an unresolvable edge
     * always rejects rather than being silently dropped.
     */
    async 'plan.import.commit'(payload) {
      const preview = payload?.preview
      if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
        throw new TodoInputError('plan/import-preview-required', 'preview 必须是 plan.import.preview 的结果')
      }
      const inferred = Array.isArray(preview.inferred) ? preview.inferred : []
      // Every dependency binding is an inference, even if a client edited the
      // list away; the confirmation flag is the only accepted way to say yes.
      const phases = Array.isArray(preview.phases) ? preview.phases : []
      const hasDependencies = phases.some((phase) => Array.isArray(phase?.dependsOn) && phase.dependsOn.length > 0)
      if ((inferred.length > 0 || hasDependencies) && payload?.confirmedInferred !== true) {
        const count = inferred.length > 0 ? `${inferred.length} 条推断` : '依赖绑定'
        throw new TodoInputError(
          'plan/import-inferred-unconfirmed',
          `有${count}（依赖映射/自动编号）需要确认；确认后再提交（confirmedInferred: true）`,
        )
      }
      const at = now()
      const input = importPreviewToProjectInput(preview, {
        phaseId: () => mintPlanId('ph', () => false),
        at,
      })
      const workspace = typeof payload?.workspace === 'string' ? payload.workspace.trim() : ''
      if (workspace !== '') input.workspace = workspace
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId !== '') {
        input.origin = { sessionId, turn: 0, seqRange: [0, 0], cwd: workspace, at }
      }
      const { project } = await store.createProject(input, at)
      return { item: store.projectRow(project) }
    },

    /**
     * Export one project: `format:'json'` (default) keeps the B1 snapshot;
     * `format:'markdown'` renders the minimal plan syntax for re-import.
     */
    async 'plan.export'(payload) {
      const id = resolveProject(store, payload)
      const format = payload?.format === undefined ? 'json' : payload.format
      if (format === 'json') return store.exportProject(id, { includeDiff: payload?.includeDiff === true })
      if (format !== 'markdown') {
        throw new TodoInputError('plan/invalid-export-format', "format 必须是 'json' 或 'markdown'")
      }
      const record = store.getProject(id)
      const project = store.projectDetail(record)
      const markdown = `${renderPlanMarkdown(project)}\n\n${changeSummaryMarkdown(store.exportProject(id).changes)}\n`
      if (payload?.write === true) {
        if (typeof writePlanFile !== 'function') {
          throw new TodoInputError('plan/export-unavailable', '当前环境不能写文件')
        }
        let written
        try {
          written = await writePlanFile({ workspace: record.workspace, name: record.name, content: markdown })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new TodoInputError('plan/export-file', `写文件失败：${message}`)
        }
        return {
          id,
          format: 'markdown',
          version: project.version,
          markdown,
          path: written.path,
          fileName: written.fileName,
        }
      }
      return { id, format: 'markdown', version: project.version, markdown }
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
