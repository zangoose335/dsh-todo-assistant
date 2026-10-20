/**
 * todo-assistant — domain declaration and record logic.
 *
 * This module deliberately has **no bare package imports**. The plugin entry
 * passes `zod` and the storage-domain helpers in through {@link createTodoSpec},
 * which keeps the record model testable outside the profile (scripts/
 * verify-domain.mjs instantiates the real storage-domain facility over a real
 * JSON backend and drives this module directly).
 *
 * Record shape follows docs/DESIGN.md §4. Fields that only the (later) AI
 * capture path can fill are declared with defaults so a manually created card
 * is valid under the same schema.
 */

/**
 * Domain name; also the JSON backend unit name (`<root>/todo_assistant.json`).
 *
 * The storage layer enforces `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` on domain and
 * table names, so the domain uses the underscore spelling while the package,
 * the channel, and every user-facing string say `todo-assistant`.
 */
import { BRIEF_BASES, BRIEF_IMPACTS, briefForRecord, briefQuality, normalizeBrief } from './brief.js'

export const DOMAIN_NAME = 'todo_assistant'
/** Bumped only when a stored record would no longer validate. */
export const DOMAIN_VERSION = 1

/**
 * Why B1 can add three tables without bumping {@link DOMAIN_VERSION}:
 *
 * - The JSON backend's `single` layout (this domain's default) compares the
 *   stored `unit.version` with the declared one for **exact equality** at open,
 *   so bumping the version would make every existing `todo_assistant.json`
 *   unreadable (`version-mismatch`).
 * - The domain facility reads a table that the stored file does not contain as
 *   empty (`snapshot.tables[table] ?? {}`), and the backend's parser only walks
 *   the declared tables. A version-1 file without `projects` /
 *   `plan_proposals` / `plan_changes` therefore opens with three empty tables,
 *   and the old cards keep validating.
 * - Every field added to an existing record (`todos.projectId`/`phaseId`) is
 *   optional, so a stored version-1 card still parses.
 */

/** Workspace bucket for cards that belong to no repository. */
export const INBOX = 'inbox'

/** Card status values, in the order the UI cycles/writes them. */
export const STATUSES = ['open', 'doing', 'done', 'dropped']
/** Card kinds; only `defect` requires `nextStep` to read as a fix plan. */
export const KINDS = ['defect', 'idea']

/** Note kinds accepted by the append-only note list. */
export const NOTE_KINDS = ['supplement', 'evidence', 'status', 'no-result']

/** A card may reference at most this many history/file sources. */
export const SOURCE_LIMIT = 32

/** Project lifecycle (PLAN.md §2.4). */
export const PROJECT_STATUSES = ['active', 'paused', 'done', 'dropped']
/** Phase statuses; `split` keeps its children (PLAN.md §2.4). */
export const PHASE_STATUSES = ['pending', 'active', 'blocked', 'done', 'dropped', 'split']
/** How a phase result was verified; an AI claim is never `verified`. */
export const RESULT_VERIFICATIONS = ['verified', 'claimed', 'unverified']
/** One test command's outcome. */
export const TEST_STATUSES = ['passed', 'failed', 'not-run']
/** Where a test outcome came from; `ai-claim` is the default. */
export const TEST_VERIFICATIONS = ['tool-result', 'developer', 'ai-claim']
/** Proposal lifecycle (PLAN.md §C3); B1 knows only these three states. */
export const PROPOSAL_STATUSES = ['pending', 'applied', 'rejected']
/**
 * Proposal kinds B1 accepts. B2/C2 add `phase-add`, `phase-split`,
 * `dependency`, `acceptance`, … — stored proposals keep their recorded kind.
 */
export const PROPOSAL_KINDS = ['project-patch']

/**
 * Change kinds recorded in `plan_changes`. B2 adds the phase write operations;
 * the enum only grows, so stored changes keep validating without a version bump.
 */
export const CHANGE_KINDS = [
  'create',
  'patch',
  'phase-add',
  'phase-update',
  'phase-remove',
  'phase-split',
  'phase-move',
  'phase-status',
  'phase-result',
]

/**
 * Project-plan limits. A write over a limit is rejected with an actionable
 * code instead of being silently truncated; the bounds keep a single-layout
 * JSON file (rewritten in full on every write) from growing without a ceiling.
 */
export const PLAN_LIMITS = {
  name: 80,
  goal: 1000,
  workspace: 4096,
  /** Phases embedded in one project. */
  phases: 50,
  phaseTitle: 120,
  phaseGoal: 1000,
  phaseNextStep: 280,
  phaseNotes: 100,
  /** Acceptance / must-keep items per phase, decisions+risks per project. */
  acceptance: 20,
  mustKeep: 20,
  decisions: 50,
  risks: 50,
  notes: 100,
  evidenceLabel: 120,
  evidenceText: 500,
  resultSummary: 1000,
  resultItems: 50,
  resultFiles: 100,
  resultTests: 20,
  /** Markdown plan import: input size and how many unclassified lines are listed. */
  importText: 100000,
  importUnclassified: 200,
  /** Proposals and applied changes kept per project. */
  proposals: 200,
  pendingProposals: 100,
  changes: 500,
  proposalReason: 500,
  changeReason: 500,
}

/** Sources one phase handoff carries (project + phase + direct prerequisites, capped). */
export const CONTEXT_SOURCE_LIMIT = 12
/** Soft cap for the generated handoff text; the renderer guarantees this bound. */
export const CONTEXT_TEXT_LIMIT = 4000

/** Backend record keys must match `[a-zA-Z0-9_-]+` (storage-json rule). */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_LENGTH = 4

/**
 * Declare the `todo-assistant` storage domain.
 *
 * @param deps - the real dependencies; injected so this file stays import-free.
 * @param deps.z - zod namespace (v4).
 * @param deps.defineDomain - `defineDomain` from `@deepseek-ai/dsh-storage-domain`.
 * @param deps.domainTable - `domainTable` from the same package.
 * @returns the declared domain spec, ready for `ctx.storageDomain.open()`.
 */
export function createTodoSpec({ z, defineDomain, domainTable }) {
  const seqRange = z.array(z.number().int()).length(2)
  const where = z.object({
    sessionId: z.string().optional(),
    seqRange: seqRange.optional(),
    file: z.string().optional(),
  })

  const sourceRef = z.object({
    sid: z.string(),
    kind: z.string(),
    label: z.string(),
    purpose: z.string().optional(),
    where: where.optional(),
    turnRange: seqRange.optional(),
    origin: z.enum(['stated', 'captured', 'derived', 'observed']).default('stated'),
    verified: z.boolean().default(false),
    at: z.number().int(),
  })

  const evidenceRef = z.object({
    label: z.string(),
    text: z.string(),
    where: where.optional(),
    basis: z.enum(BRIEF_BASES).optional(),
    observed: z.boolean().optional(),
    sourceIds: z.array(z.string()).optional(),
  })

  const parkedRef = z.object({
    id: z.string(),
    label: z.string(),
    why: z.string(),
    where: where.extend({ offset: z.number().optional() }).optional(),
    basis: z.enum(BRIEF_BASES).optional(),
    observed: z.boolean().optional(),
    sourceIds: z.array(z.string()).optional(),
  })

  const note = z.object({
    at: z.number(),
    fromSession: z.string(),
    turn: z.number().int(),
    kind: z.enum(NOTE_KINDS),
    text: z.string(),
    basis: z.enum(BRIEF_BASES).optional(),
    sourceIds: z.array(z.string()).optional(),
    role: z.string().optional(),
  })

  const origin = z.object({
    sessionId: z.string(),
    /** Root session a subagent's card belongs to; absent on legacy records. */
    rootSessionId: z.string().optional(),
    /** 0 means "not captured from a turn" (a manually created card). */
    turn: z.number().int(),
    seqRange,
    cwd: z.string(),
    at: z.number(),
  })

  const symbol = z.object({
    file: z.string(),
    symbol: z.string().optional(),
    line: z.number().int().optional(),
  })

  const briefItem = z.object({
    text: z.string(),
    basis: z.enum(BRIEF_BASES),
    sourceIds: z.array(z.string()).optional(),
    impact: z.enum(BRIEF_IMPACTS).optional(),
  })

  const brief = z.object({
    goal: z.string(),
    why: z.string().optional(),
    confirmed: z.array(briefItem).default([]),
    constraints: z.array(briefItem).default([]),
    leads: z.array(briefItem).default([]),
    nextAction: z.string(),
    openQuestions: z.array(briefItem).default([]),
  })

  // ── Project Plan (B1, PLAN.md §2.4) ───────────────────────────────────────
  // These records live in their own tables, so every required field here only
  // constrains *new* project data; no version-1 card record touches them.

  const testEvidence = z.object({
    command: z.string().optional(),
    status: z.enum(TEST_STATUSES),
    /** An AI claim never becomes `verified` without a tool result or the developer. */
    verification: z.enum(TEST_VERIFICATIONS).default('ai-claim'),
    sourceId: z.string().optional(),
    at: z.number().int(),
  })

  const phaseResult = z.object({
    summary: z.string(),
    completed: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    tests: z.array(testEvidence).default([]),
    issues: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    decisionsChanged: z.array(z.string()).default([]),
    planDelta: z.string().default(''),
    sourceIds: z.array(z.string()).default([]),
    verification: z.enum(RESULT_VERIFICATIONS).default('claimed'),
    recordedAt: z.number().int(),
    recordedBySession: z.string().default(''),
  })

  const phase = z.object({
    /** Stable phase id (`ph_x7k2`); display `number` may change, `pid` never. */
    pid: z.string(),
    /** Display number ("4" / "4a"); B2 owns renumbering rules. */
    number: z.string().default(''),
    parentPid: z.string().optional(),
    title: z.string(),
    goal: z.string().default(''),
    status: z.enum(PHASE_STATUSES).default('pending'),
    dependsOn: z.array(z.string()).default([]),
    acceptance: z.array(evidenceRef).default([]),
    mustKeep: z.array(evidenceRef).default([]),
    decisions: z.array(evidenceRef).default([]),
    sources: z.array(sourceRef).max(SOURCE_LIMIT).default([]),
    nextStep: z.string().default(''),
    notes: z.array(note).default([]),
    result: phaseResult.optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  const projectPlan = z.object({
    id: z.string(),
    workspace: z.string(),
    name: z.string(),
    goal: z.string(),
    status: z.enum(PROJECT_STATUSES).default('active'),
    currentPhaseId: z.string().optional(),
    phases: z.array(phase).default([]),
    decisions: z.array(evidenceRef).default([]),
    risks: z.array(evidenceRef).default([]),
    sources: z.array(sourceRef).max(SOURCE_LIMIT).default([]),
    /** 1 at creation, +1 for every applied change. */
    version: z.number().int().default(1),
    createdAt: z.number(),
    updatedAt: z.number(),
    origin: origin.optional(),
  })

  /** The only fields a patch — or a `project-patch` proposal — may change. */
  const projectPatch = z.object({
    name: z.string().optional(),
    goal: z.string().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    /** `null` clears the current phase. */
    currentPhaseId: z.string().nullable().optional(),
    phases: z.array(phase).optional(),
    decisions: z.array(evidenceRef).optional(),
    risks: z.array(evidenceRef).optional(),
    sources: z.array(sourceRef).optional(),
  })

  const planProposal = z.object({
    id: z.string(),
    projectId: z.string(),
    /** The project version the proposal was computed against (PLAN.md §C2). */
    baseVersion: z.number().int(),
    kind: z.enum(PROPOSAL_KINDS).default('project-patch'),
    patch: projectPatch,
    reason: z.string().default(''),
    proposedBySession: z.string().default(''),
    status: z.enum(PROPOSAL_STATUSES).default('pending'),
    createdAt: z.number(),
    appliedAt: z.number().optional(),
    rejectedAt: z.number().optional(),
    rejectedReason: z.string().optional(),
  })

  const planChange = z.object({
    id: z.string(),
    projectId: z.string(),
    /** The project version this change produced. */
    version: z.number().int(),
    at: z.number(),
    by: z.enum(['developer', 'proposal', 'system']).default('developer'),
    kind: z.enum(CHANGE_KINDS).default('patch'),
    reason: z.string().default(''),
    affectedPhaseIds: z.array(z.string()).default([]),
    /**
     * `create` stores the whole initial project in `after`; `patch` stores only
     * the changed top-level fields. Field-level phase diffs are C2's job.
     */
    diff: z.object({ before: z.unknown().optional(), after: z.unknown().optional() }),
    sourceIds: z.array(z.string()).default([]),
  })

  const todoRecord = z.object({
    id: z.string(),
    /** Short label `major.minor`: major per origin session, minor within it. */
    major: z.number().int().optional(),
    minor: z.number().int().optional(),
    /** Legacy single-number label (kept so startup migration can read it). */
    number: z.number().int().optional(),
    workspace: z.string(),
    title: z.string(),
    status: z.enum(STATUSES),
    kind: z.enum(KINDS),
    createdAt: z.number(),
    updatedAt: z.number(),

    origin: origin.optional(),

    /**
     * The developer's own words, verbatim, when the card came from a typed
     * request. Never summarized: their phrasing beats any interpretation, and it
     * is what they compare the card against later.
     */
    request: z
      .object({
        text: z.string(),
        turn: z.number().int(),
        at: z.number(),
        messageId: z.string().optional(),
        /** Index of the `#DB` block this card came from, when the message had several. */
        block: z.number().int().optional(),
        truncated: z.boolean().optional(),
      })
      .optional(),

    /** The session that took this card over ("处理"), if any. */
    handling: z
      .object({ sessionId: z.string(), at: z.number() })
      .optional(),

    code: z
      .object({
        commit: z.string(),
        branch: z.string(),
        symbols: z.array(symbol),
      })
      .default({ commit: '', branch: '', symbols: [] }),

    touchedFiles: z.array(z.string()).default([]),

    core: z.object({
      symptom: z.string().optional(),
      cause: z.string().optional(),
      nextStep: z.string(),
      intent: z.string().optional(),
    }),

    /** Optional task brief; old cards project a derived brief at read time. */
    brief: brief.optional(),

    /**
     * Weak link to a project plan and one of its phases (B1). Both are optional:
     * an ordinary card behaves exactly as before, and a dangling id is allowed
     * (deleting a project does not rewrite cards).
     */
    projectId: z.string().optional(),
    phaseId: z.string().optional(),

    mustRead: z.array(evidenceRef).default([]),
    park: z.array(parkedRef).default([]),
    /** Pointers to history/file evidence; never the body. */
    sources: z.array(sourceRef).max(SOURCE_LIMIT).default([]),
    notes: z.array(note).default([]),
  })

  // One rules text per workspace, keyed by the workspace path itself.
  const rulesRecord = z.object({
    workspace: z.string(),
    text: z.string(),
    updatedAt: z.number(),
  })

  return defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables: {
      todos: domainTable(todoRecord),
      rules: domainTable(rulesRecord),
      projects: domainTable(projectPlan),
      plan_proposals: domainTable(planProposal),
      plan_changes: domainTable(planChange),
    },
  })
}

/**
 * The short label parts of one record: `{ major, minor, label }`.
 *
 * @param record - stored record.
 * @returns numbers (null when not yet labelled) and the display string.
 */
export function labelOf(record) {
  const major = Number.isInteger(record?.major) ? record.major : null
  const minor = Number.isInteger(record?.minor) ? record.minor : null
  return { major, minor, label: major === null || minor === null ? null : `${major}.${minor}` }
}

/**
 * Make one path comparable to the paths the detector sees: forward slashes,
 * repo-relative when it lives under the workspace, no `./`, no trailing slash.
 * Absolute paths outside the workspace stay absolute (they then compare against
 * equally absolute tool paths).
 *
 * @param path - raw path from the model or the form.
 * @param workspace - normalized workspace path ('inbox' when unowned).
 * @returns the stored form ('' when unusable).
 */
export function normalizeTouchedPath(path, workspace) {
  let value = typeof path === 'string' ? path.trim().replaceAll('\\', '/') : ''
  if (value === '') return ''
  const base =
    typeof workspace === 'string' && workspace !== '' && workspace !== 'inbox'
      ? workspace.replaceAll('\\', '/').replace(/\/+$/u, '')
      : ''
  if (base !== '' && value === base) return ''
  if (base !== '' && value.startsWith(`${base}/`)) value = value.slice(base.length + 1)
  value = value.replace(/^\.\//u, '').replace(/\/+$/u, '')
  return value === '.' ? '' : value
}

/** The code-coordinate block a card starts with before any capture fills it. */
export function emptyCode() {
  return { commit: '', branch: '', symbols: [] }
}

/**
 * Mint a backend-safe card id (`td_x7k2`), avoiding ids already stored.
 *
 * @param taken - predicate answering whether an id is in use.
 * @returns a free id.
 */
export function mintId(taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let body = ''
    for (let i = 0; i < ID_LENGTH; i += 1) {
      body += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
    }
    const candidate = `td_${body}`
    if (!taken(candidate)) return candidate
  }
  // Extremely unlikely; a longer timestamp-derived suffix still obeys the key rule.
  return `td_${Date.now().toString(36)}`
}

/** Prefixes the plan tables use; every key still matches `[a-zA-Z0-9_-]+`. */
const PLAN_ID_PREFIXES = ['pj', 'ph', 'pp', 'pc']

/**
 * Mint a backend-safe plan id (`pj_x7k2`, `ph_…`, `pp_…`, `pc_…`), avoiding ids
 * already stored in that table.
 *
 * @param prefix - one of {@link PLAN_ID_PREFIXES}.
 * @param taken - predicate answering whether an id is in use.
 * @returns a free id.
 */
export function mintPlanId(prefix, taken) {
  if (!PLAN_ID_PREFIXES.includes(prefix)) throw new Error(`unknown plan id prefix '${prefix}'`)
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let body = ''
    for (let i = 0; i < ID_LENGTH; i += 1) {
      body += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
    }
    const candidate = `${prefix}_${body}`
    if (!taken(candidate)) return candidate
  }
  return `${prefix}_${Date.now().toString(36)}`
}

/** Trim a value while keeping paragraph breaks: project goals are prose. */
function cleanParagraph(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r\n/gu, '\n').trim()
  return limit === undefined ? text : [...text].slice(0, limit).join('')
}

/** Throw unless `value` is a non-empty string within `limit` code points. */
function requiredPlanText(value, limit, code, label) {
  const text = cleanParagraph(value)
  if (text === '') throw new TodoInputError(code, `${label} 不能为空`)
  if (textLength(text) > limit) {
    throw new TodoInputError(`${code}-too-long`, `${label} 最多 ${limit} 个字符（当前 ${textLength(text)}）`)
  }
  return text
}

/** Cap one free-text plan field; over the limit it is rejected, never truncated. */
function optionalPlanText(value, limit, code, label) {
  const text = cleanParagraph(value)
  if (text === '') return ''
  if (textLength(text) > limit) {
    throw new TodoInputError(`${code}-too-long`, `${label} 最多 ${limit} 个字符（当前 ${textLength(text)}）`)
  }
  return text
}

/** Undefined/null reads as an empty list; a non-array or an over-long list rejects. */
function arrayWithin(value, limit, code, message) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TodoInputError(code, message)
  if (value.length > limit) throw new TodoInputError(code, message)
  return value
}

/** Normalize one `EvidenceRef` (label + text + provenance). */
function normalizePlanEvidence(item, index, field) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new TodoInputError('plan/invalid-evidence', `${field}[${index}] 必须是对象`)
  }
  const label = cleanLine(item.label, PLAN_LIMITS.evidenceLabel)
  if (label === '') throw new TodoInputError('plan/invalid-evidence', `${field}[${index}].label 不能为空`)
  const text = cleanParagraph(item.text, PLAN_LIMITS.evidenceText)
  if (text === '') throw new TodoInputError('plan/invalid-evidence', `${field}[${index}].text 不能为空`)
  const where = normalizeWhere(item.where)
  const basis = normalizeBasis(item.basis, field)
  const sourceIds = normalizeSourceIds(item.sourceIds)
  return {
    label,
    text,
    ...(where === undefined ? {} : { where }),
    ...(basis === undefined ? {} : { basis }),
    ...(sourceIds.length === 0 ? {} : { sourceIds }),
  }
}

/** Normalize one evidence list, enforcing its declared cap. */
function normalizePlanEvidenceList(value, limit, field, code) {
  const items = arrayWithin(value, limit, code, `${field} 最多 ${limit} 条`)
  return items.map((item, index) => normalizePlanEvidence(item, index, field))
}

/** Normalize one `SourceRef`; only pointer fields are kept, never a body. */
function normalizePlanSource(item, index, at, field) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new TodoInputError('plan/invalid-source', `${field}[${index}] 必须是对象`)
  }
  const sid = cleanLine(item.sid, 80)
  if (sid === '') throw new TodoInputError('plan/invalid-source', `${field}[${index}].sid 不能为空`)
  const kind = cleanLine(item.kind, 40)
  if (kind === '') throw new TodoInputError('plan/invalid-source', `${field}[${index}].kind 不能为空`)
  const label = cleanLine(item.label, 120)
  if (label === '') throw new TodoInputError('plan/invalid-source', `${field}[${index}].label 不能为空`)
  const purpose = optionalText(item.purpose, 200)
  const where = normalizeWhere(item.where)
  const turnRange =
    Array.isArray(item.turnRange) && item.turnRange.length === 2 && item.turnRange.every(Number.isInteger)
      ? [item.turnRange[0], item.turnRange[1]]
      : undefined
  const origin = ['stated', 'captured', 'derived', 'observed'].includes(item.origin) ? item.origin : 'stated'
  return {
    sid,
    kind,
    label,
    ...(purpose === undefined ? {} : { purpose }),
    ...(where === undefined ? {} : { where }),
    ...(turnRange === undefined ? {} : { turnRange }),
    origin,
    verified: item.verified === true,
    at: Number.isInteger(item.at) ? item.at : at,
  }
}

/** Normalize one source list, enforcing its declared cap. */
function normalizePlanSourceList(value, limit, field, code, at) {
  const items = arrayWithin(value, limit, code, `${field} 最多 ${limit} 条来源`)
  return items.map((item, index) => normalizePlanSource(item, index, at, field))
}

/** Normalize one append-only phase note. */
function normalizePlanNote(item, index, at) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new TodoInputError('plan/invalid-note', `notes[${index}] 必须是对象`)
  }
  const text = cleanParagraph(item.text, 300)
  if (text === '') throw new TodoInputError('plan/invalid-note', `notes[${index}].text 不能为空`)
  const kind = NOTE_KINDS.includes(item.kind) ? item.kind : 'supplement'
  const basis = normalizeBasis(item.basis, 'notes')
  const role = optionalText(item.role, 40)
  const sourceIds = normalizeSourceIds(item.sourceIds)
  return {
    at: Number.isInteger(item.at) ? item.at : at,
    fromSession: cleanLine(item.fromSession, 256),
    turn: Number.isInteger(item.turn) ? item.turn : 0,
    kind,
    text,
    ...(basis === undefined ? {} : { basis }),
    ...(role === undefined ? {} : { role }),
    ...(sourceIds.length === 0 ? {} : { sourceIds }),
  }
}

/** Normalize one test evidence entry; an AI claim is never `verified`. */
function normalizeTestEvidence(item, index, at) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new TodoInputError('plan/invalid-test', `tests[${index}] 必须是对象`)
  }
  if (!TEST_STATUSES.includes(item.status)) {
    throw new TodoInputError('plan/invalid-test', `tests[${index}].status 必须是 ${TEST_STATUSES.join(' / ')}`)
  }
  const command = optionalText(item.command, 500)
  const sourceId = optionalText(item.sourceId, 80)
  const verification = TEST_VERIFICATIONS.includes(item.verification) ? item.verification : 'ai-claim'
  return {
    ...(command === undefined ? {} : { command }),
    status: item.status,
    verification,
    ...(sourceId === undefined ? {} : { sourceId }),
    at: Number.isInteger(item.at) ? item.at : at,
  }
}

/** Normalize a short string list (completed/files/issues/…). */
function normalizeStringList(value, limit, code, field) {
  const items = arrayWithin(value, limit, code, `${field} 最多 ${limit} 条`)
  return items
    .map((item) => cleanParagraph(item, 500))
    .filter((item) => item !== '')
}

/** Normalize one `PhaseResult`. */
function normalizePhaseResult(input, at, limits = PLAN_LIMITS) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TodoInputError('plan/invalid-result', 'result 必须是对象')
  }
  const summary = requiredPlanText(input.summary, limits.resultSummary, 'plan/result-summary', 'result.summary')
  const tests = arrayWithin(input.tests, limits.resultTests, 'plan/too-many-tests', `result.tests 最多 ${limits.resultTests} 条`).map(
    (item, index) => normalizeTestEvidence(item, index, at),
  )
  const verification = RESULT_VERIFICATIONS.includes(input.verification) ? input.verification : 'claimed'
  return {
    summary,
    completed: normalizeStringList(input.completed, limits.resultItems, 'plan/too-many-completed', 'result.completed'),
    files: normalizeStringList(input.files, limits.resultFiles, 'plan/too-many-result-files', 'result.files'),
    tests,
    issues: normalizeStringList(input.issues, limits.resultItems, 'plan/too-many-issues', 'result.issues'),
    risks: normalizeStringList(input.risks, limits.resultItems, 'plan/too-many-result-risks', 'result.risks'),
    decisionsChanged: normalizeStringList(
      input.decisionsChanged,
      limits.resultItems,
      'plan/too-many-decisions-changed',
      'result.decisionsChanged',
    ),
    planDelta: optionalPlanText(input.planDelta, limits.resultSummary, 'plan/result-plan-delta', 'result.planDelta'),
    sourceIds: normalizeSourceIds(input.sourceIds),
    verification,
    recordedAt: Number.isInteger(input.recordedAt) ? input.recordedAt : at,
    recordedBySession: cleanLine(input.recordedBySession, 256),
  }
}

/**
 * Normalize one phase embedded in a project.
 *
 * B1 validates shape, caps, and duplicate pids only. Dependency existence,
 * cycles, `number` uniqueness, `parentPid` cycles, and `currentPhaseId`
 * existence are B2 rules and are deliberately not enforced here.
 *
 * @param input - untrusted phase.
 * @param index - position in the array (used for messages and default numbering).
 * @param at - write timestamp.
 * @param context - id allocation, the pids already used in this project, and the
 *   stored phases (so a patch keeps each phase's `createdAt`).
 * @returns the normalized phase.
 */
function normalizePhase(input, index, at, { phaseId, taken, previous, requirePid, limits }) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TodoInputError('plan/invalid-phase', `phases[${index}] 必须是对象`)
  }
  let pid = cleanLine(input.pid, 64)
  if (pid === '') {
    if (requirePid) throw new TodoInputError('plan/phase-pid-required', `phases[${index}].pid 不能为空（替换 phases 时必须带稳定 pid）`)
    pid = phaseId()
  }
  if (taken.has(pid)) throw new TodoInputError('plan/duplicate-phase', `阶段 pid ${pid} 重复`)
  taken.add(pid)
  const prior = previous?.get(pid)
  const title = requiredPlanText(input.title, limits.phaseTitle, 'plan/phase-title', `phases[${index}].title`)
  const number = cleanLine(input.number, 32) || String(index + 1)
  const goal = optionalPlanText(input.goal, limits.phaseGoal, 'plan/phase-goal', `phases[${index}].goal`)
  const status = input.status === undefined ? 'pending' : input.status
  if (!PHASE_STATUSES.includes(status)) {
    throw new TodoInputError('plan/invalid-phase-status', `phases[${index}].status 必须是 ${PHASE_STATUSES.join(' / ')}`)
  }
  const parentPid = optionalText(input.parentPid, 64)
  const dependsOn = [
    ...new Set(
      arrayWithin(input.dependsOn, limits.phases, 'plan/too-many-dependencies', `phases[${index}].dependsOn 最多 ${limits.phases} 项`)
        .map((value) => cleanLine(value, 64))
        .filter((value) => value !== ''),
    ),
  ]
  const acceptance = normalizePlanEvidenceList(
    input.acceptance,
    limits.acceptance,
    `phases[${index}].acceptance`,
    'plan/too-many-acceptance',
  )
  const mustKeep = normalizePlanEvidenceList(input.mustKeep, limits.mustKeep, `phases[${index}].mustKeep`, 'plan/too-many-must-keep')
  const decisions = normalizePlanEvidenceList(input.decisions, limits.decisions, `phases[${index}].decisions`, 'plan/too-many-decisions')
  const sources = normalizePlanSourceList(input.sources, SOURCE_LIMIT, `phases[${index}].sources`, 'plan/source-limit', at)
  const nextStep = optionalPlanText(input.nextStep, limits.phaseNextStep, 'plan/phase-next-step', `phases[${index}].nextStep`)
  const notes = arrayWithin(input.notes, limits.phaseNotes, 'plan/too-many-notes', `phases[${index}].notes 最多 ${limits.phaseNotes} 条`).map(
    (item, noteIndex) => normalizePlanNote(item, noteIndex, at),
  )
  return {
    pid,
    number,
    ...(parentPid === undefined ? {} : { parentPid }),
    title,
    goal,
    status,
    dependsOn,
    acceptance,
    mustKeep,
    decisions,
    sources,
    nextStep,
    notes,
    ...(input.result === undefined ? {} : { result: normalizePhaseResult(input.result, at, limits) }),
    createdAt: Number.isInteger(input.createdAt) ? input.createdAt : (prior?.createdAt ?? at),
    // Re-normalizing an already-stored phase (phase.* writes) must not refresh
    // every phase's timestamp; a real edit passes `updatedAt: at` explicitly.
    updatedAt: Number.isInteger(input.updatedAt) ? input.updatedAt : at,
  }
}

/** Normalize the embedded phase array. */
function normalizePhaseList(value, at, { phaseId, previous, requirePid, limits }) {
  const items = arrayWithin(value, limits.phases, 'plan/too-many-phases', `phases 最多 ${limits.phases} 个阶段`)
  const taken = new Set()
  return items.map((item, index) => normalizePhase(item, index, at, { phaseId, taken, previous, requirePid, limits }))
}

/**
 * Build a new project record from a create request (B1).
 *
 * @param input - untrusted wire payload.
 * @param deps - clock, project-id and phase-id allocation, optional origin.
 * @returns the complete project record (version 1).
 * @throws {TodoInputError} with a `plan/*` code when a field is unusable.
 */
export function buildProject(input, { now, nextId, phaseId, origin, limits = PLAN_LIMITS }) {
  const at = now()
  const workspace = cleanLine(input?.workspace, limits.workspace)
  if (workspace === '') throw new TodoInputError('plan/workspace-required', 'workspace 不能为空')
  const name = requiredPlanText(input?.name, limits.name, 'plan/name', 'name')
  const goal = requiredPlanText(input?.goal, limits.goal, 'plan/goal', 'goal')
  const status = input?.status === undefined ? 'active' : input.status
  if (!PROJECT_STATUSES.includes(status)) {
    throw new TodoInputError('plan/invalid-status', `status 必须是 ${PROJECT_STATUSES.join(' / ')}`)
  }
  const currentPhaseId = optionalText(input?.currentPhaseId, 64)
  const phases = normalizePhaseList(input?.phases, at, { phaseId, limits })
  // `currentPhaseId` existence is B2's rule; B1 stores the weak link as given.
  const decisions = normalizePlanEvidenceList(input?.decisions, limits.decisions, 'decisions', 'plan/too-many-decisions')
  const risks = normalizePlanEvidenceList(input?.risks, limits.risks, 'risks', 'plan/too-many-risks')
  const sources = normalizePlanSourceList(input?.sources, SOURCE_LIMIT, 'sources', 'plan/source-limit', at)
  const record = {
    id: nextId(),
    workspace,
    name,
    goal,
    status,
    ...(currentPhaseId === undefined ? {} : { currentPhaseId }),
    phases,
    decisions,
    risks,
    sources,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...(origin === undefined ? {} : { origin }),
  }
  return validateProjectPlan(record, { limits })
}

/** The fields a project patch may carry. */
const PROJECT_PATCH_FIELDS = ['name', 'goal', 'status', 'currentPhaseId', 'phases', 'decisions', 'risks', 'sources']

/**
 * Apply a validated project patch to a stored project.
 *
 * The result keeps the record identity (`id`/`workspace`/`createdAt`/`origin`)
 * and the current `version`; the caller (`applyChange`) bumps the version and
 * records the change. A dry run of this function is what validates a proposal
 * patch before it is stored.
 *
 * @param project - the stored project (not mutated).
 * @param patch - partial changes from the wire or a proposal.
 * @param at - write timestamp.
 * @returns the updated project record.
 * @throws {TodoInputError} when a provided field is unusable.
 */
export function applyProjectPatch(project, patch, at, { limits = PLAN_LIMITS } = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TodoInputError('plan/invalid-patch', 'patch 必须是对象')
  }
  const unknown = Object.keys(patch).filter((key) => !PROJECT_PATCH_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new TodoInputError('plan/unknown-field', `patch 不接受字段：${unknown.join(', ')}（B1 只支持 ${PROJECT_PATCH_FIELDS.join('/')}）`)
  }
  const next = { ...project }
  if (patch.name !== undefined) next.name = requiredPlanText(patch.name, limits.name, 'plan/name', 'name')
  if (patch.goal !== undefined) next.goal = requiredPlanText(patch.goal, limits.goal, 'plan/goal', 'goal')
  if (patch.status !== undefined) {
    if (!PROJECT_STATUSES.includes(patch.status)) {
      throw new TodoInputError('plan/invalid-status', `status 必须是 ${PROJECT_STATUSES.join(' / ')}`)
    }
    next.status = patch.status
  }
  if (patch.currentPhaseId !== undefined) {
    const currentPhaseId = patch.currentPhaseId === null ? undefined : optionalText(patch.currentPhaseId, 64)
    if (currentPhaseId === undefined) delete next.currentPhaseId
    else next.currentPhaseId = currentPhaseId
  }
  if (patch.phases !== undefined) {
    const previous = new Map((project.phases ?? []).map((phase) => [phase.pid, phase]))
    next.phases = normalizePhaseList(patch.phases, at, {
      phaseId: () => {
        throw new TodoInputError('plan/phase-pid-required', '替换 phases 时每个阶段都必须带稳定 pid')
      },
      previous,
      requirePid: true,
      limits,
    })
  }
  if (patch.decisions !== undefined) {
    next.decisions = normalizePlanEvidenceList(patch.decisions, limits.decisions, 'decisions', 'plan/too-many-decisions')
  }
  if (patch.risks !== undefined) {
    next.risks = normalizePlanEvidenceList(patch.risks, limits.risks, 'risks', 'plan/too-many-risks')
  }
  if (patch.sources !== undefined) {
    next.sources = normalizePlanSourceList(patch.sources, SOURCE_LIMIT, 'sources', 'plan/source-limit', at)
  }
  next.updatedAt = at
  return validateProjectPlan(next, { limits })
}

// ── Phase operations (B2, PLAN.md §B2) ─────────────────────────────────────
// Every helper validates its own input and returns the patch the store hands
// to `applyChange`; none of them writes. The project-wide invariants (pids,
// numbers, dependencies, parents, current phase) are enforced by
// `validateProjectPlan` on every write, including `plan.create`/`plan.patch`.

/**
 * Check the project-plan invariants that span the whole phase array.
 *
 * @param project - a complete project record (normalized phases).
 * @param options - `limits` override.
 * @returns the same project (for chaining).
 * @throws {TodoInputError} with a specific `plan/*` code.
 */
export function validateProjectPlan(project, { limits = PLAN_LIMITS } = {}) {
  const phases = Array.isArray(project.phases) ? project.phases : []
  if (phases.length > limits.phases) {
    throw new TodoInputError('plan/too-many-phases', `phases 最多 ${limits.phases} 个阶段`)
  }
  const byPid = new Map()
  const byNumber = new Map()
  for (const [index, phase] of phases.entries()) {
    const pid = typeof phase?.pid === 'string' ? phase.pid.trim() : ''
    if (pid === '') throw new TodoInputError('plan/phase-pid-required', `phases[${index}].pid 不能为空`)
    if (byPid.has(pid)) throw new TodoInputError('plan/duplicate-phase', `阶段 pid ${pid} 重复`)
    byPid.set(pid, phase)
    const number = typeof phase.number === 'string' ? phase.number.trim() : ''
    if (number === '') throw new TodoInputError('plan/phase-number-required', `阶段 ${pid} 缺少展示号 number`)
    if (byNumber.has(number)) {
      throw new TodoInputError(
        'plan/phase-duplicate-number',
        `展示号 ${number} 同时被阶段 ${byNumber.get(number).pid} 和 ${pid} 使用；先改成唯一编号`,
      )
    }
    byNumber.set(number, phase)
  }
  for (const phase of phases) {
    for (const dep of phase.dependsOn ?? []) {
      if (dep === phase.pid) throw new TodoInputError('plan/phase-self-dependency', `阶段 ${phase.pid} 不能依赖自己`)
      if (!byPid.has(dep)) {
        throw new TodoInputError('plan/phase-unknown-dependency', `阶段 ${phase.pid} 依赖了不存在的阶段 ${dep}`)
      }
    }
    if (phase.parentPid !== undefined) {
      if (phase.parentPid === phase.pid) {
        throw new TodoInputError('plan/phase-self-parent', `阶段 ${phase.pid} 不能以自己为父阶段`)
      }
      if (!byPid.has(phase.parentPid)) {
        throw new TodoInputError('plan/phase-unknown-parent', `阶段 ${phase.pid} 的父阶段 ${phase.parentPid} 不存在`)
      }
    }
  }
  detectPhaseCycle(phases, (phase) => phase.dependsOn ?? [], 'plan/phase-dependency-cycle', '依赖')
  detectPhaseCycle(
    phases,
    (phase) => (phase.parentPid === undefined ? [] : [phase.parentPid]),
    'plan/phase-parent-cycle',
    '父子关系',
  )
  if (project.currentPhaseId !== undefined && !byPid.has(project.currentPhaseId)) {
    throw new TodoInputError('plan/current-phase-missing', `currentPhaseId ${project.currentPhaseId} 不在项目阶段里`)
  }
  return project
}

/** Trim one phase reference; an empty value rejects. */
function phaseRef(value) {
  const pid = cleanLine(value, 64)
  if (pid === '') throw new TodoInputError('plan/phase-id-required', 'phaseId 不能为空')
  return pid
}

/** One stored phase of a project, or a `plan/phase-not-found` rejection. */
function findPhase(project, pid) {
  const phases = project.phases ?? []
  const phase = phases.find((entry) => entry.pid === pid)
  if (phase === undefined) {
    const known = phases.map((entry) => `${entry.number || '?'}:${entry.pid}`).join(', ')
    throw new TodoInputError('plan/phase-not-found', `阶段 ${pid} 不存在${known === '' ? '' : `（现有：${known}）`}`)
  }
  return phase
}

/** Child display number for a split: a numeric parent gets letters (4 → 4a), a letter parent digits (A → A1). */
function splitChildNumber(parentNumber, index) {
  return /^[A-Za-z]+$/u.test(parentNumber) ? `${parentNumber}${index + 1}` : `${parentNumber}${splitLetter(index)}`
}

/** Split display suffix: a, b, …, z, aa, ab, … */
function splitLetter(index) {
  let value = ''
  let current = index
  do {
    value = String.fromCharCode(97 + (current % 26)) + value
    current = Math.floor(current / 26) - 1
  } while (current >= 0)
  return value
}

/**
 * Depth-first cycle detection over one edge function. The error names the cycle
 * so a rejected write is actionable.
 */
function detectPhaseCycle(phases, edgesOf, code, label) {
  const state = new Map()
  const path = []
  for (const root of phases) {
    if ((state.get(root.pid) ?? 0) === 2) continue
    state.set(root.pid, 1)
    path.push(root.pid)
    const stack = [{ edges: edgesOf(root), next: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.next >= frame.edges.length) {
        state.set(path[path.length - 1], 2)
        path.pop()
        stack.pop()
        continue
      }
      const target = frame.edges[frame.next]
      frame.next += 1
      if (typeof target !== 'string' || target === '') continue
      const status = state.get(target) ?? 0
      if (status === 1) {
        const from = path.indexOf(target)
        throw new TodoInputError(code, `${label}成环：${[...path.slice(from), target].join(' → ')}`)
      }
      if (status === 2) continue
      state.set(target, 1)
      path.push(target)
      stack.push({ edges: edgesOf(phases.find((entry) => entry.pid === target) ?? { pid: target }), next: 0 })
    }
  }
}

/** Fields `plan.phase.update` may change. Status/result/pid have their own ops. */
const PHASE_UPDATE_FIELDS = [
  'title',
  'goal',
  'number',
  'parentPid',
  'dependsOn',
  'acceptance',
  'mustKeep',
  'decisions',
  'sources',
  'nextStep',
  'notes',
]

/** Statuses a newly added phase may start in; done/split need their own op. */
const PHASE_ADD_STATUSES = ['pending', 'active', 'blocked', 'dropped']

/**
 * Append one phase. The display `number` is required here (the caller decides
 * where the new phase sits); `plan.create` keeps defaulting numbers by position.
 */
export function addPhaseToProject(project, input, at, { phaseId, limits = PLAN_LIMITS } = {}) {
  const phases = project.phases ?? []
  const number = cleanLine(input?.number, 32)
  if (number === '') {
    throw new TodoInputError('plan/phase-number-required', '新增阶段必须给 number（展示号，如 4a）')
  }
  const explicitPid = cleanLine(input?.pid, 64)
  const taken = new Set(phases.map((entry) => entry.pid))
  const phase = normalizePhase(
    { ...input, number, ...(explicitPid === '' ? {} : { pid: explicitPid }) },
    phases.length,
    at,
    { phaseId, taken, limits },
  )
  if (!PHASE_ADD_STATUSES.includes(phase.status)) {
    throw new TodoInputError(
      'plan/phase-status-on-add',
      `新增阶段只能处于 ${PHASE_ADD_STATUSES.join('/')}；完成用 plan.phase.status，拆分用 plan.phase.split`,
    )
  }
  return { patch: { phases: [...phases, phase] }, affectedPhaseIds: [phase.pid] }
}

/** Edit one phase's fields. `pid`, `status`, and `result` are not patchable here. */
export function updatePhaseInProject(project, phaseId, patch, at, { limits = PLAN_LIMITS } = {}) {
  const pid = phaseRef(phaseId)
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TodoInputError('plan/invalid-patch', 'patch 必须是对象')
  }
  const unknown = Object.keys(patch).filter((key) => !PHASE_UPDATE_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new TodoInputError(
      'plan/unknown-field',
      `阶段 patch 不接受字段：${unknown.join(', ')}（status/result/pid 请用对应端点；可改 ${PHASE_UPDATE_FIELDS.join('/')}）`,
    )
  }
  const phases = project.phases ?? []
  const index = phases.findIndex((entry) => entry.pid === pid)
  const phase = findPhase(project, pid)
  if (patch.number !== undefined && cleanLine(patch.number, 32) === '') {
    throw new TodoInputError('plan/phase-number-required', 'number 不能为空')
  }
  const merged = { ...phase }
  for (const field of PHASE_UPDATE_FIELDS) {
    if (patch[field] !== undefined) merged[field] = patch[field]
  }
  merged.updatedAt = at
  // The phase being edited is not "taken" for its own re-normalization.
  const taken = new Set(phases.filter((entry) => entry.pid !== pid).map((entry) => entry.pid))
  const previous = new Map(phases.map((entry) => [entry.pid, entry]))
  const replaced = normalizePhase(merged, index, at, {
    phaseId: () => {
      throw new TodoInputError('plan/phase-pid-required', '已有阶段必须保留稳定 pid')
    },
    taken,
    previous,
    requirePid: true,
    limits,
  })
  const nextPhases = phases.map((entry) => (entry.pid === pid ? replaced : entry))
  return { patch: { phases: nextPhases }, affectedPhaseIds: [pid] }
}

/**
 * Remove one phase. A phase other phases depend on, or one with children, is
 * rejected so a dependency never silently dangles; removing the current phase
 * clears `currentPhaseId`.
 */
export function removePhaseFromProject(project, phaseId, at, { limits = PLAN_LIMITS } = {}) {
  const pid = phaseRef(phaseId)
  const phases = project.phases ?? []
  const phase = findPhase(project, pid)
  const children = phases.filter((entry) => entry.parentPid === pid)
  if (children.length > 0) {
    throw new TodoInputError(
      'plan/phase-has-children',
      `阶段 ${phase.number} 有子阶段 ${children.map((entry) => entry.number).join(', ')}；先删除子阶段`,
    )
  }
  const dependents = phases.filter((entry) => (entry.dependsOn ?? []).includes(pid))
  if (dependents.length > 0) {
    throw new TodoInputError(
      'plan/phase-has-dependents',
      `阶段 ${phase.number} 仍被 ${dependents.map((entry) => entry.number).join(', ')} 依赖；先改它们的 dependsOn`,
    )
  }
  const patch = { phases: phases.filter((entry) => entry.pid !== pid) }
  if (project.currentPhaseId === pid) patch.currentPhaseId = null
  return { patch, affectedPhaseIds: [pid] }
}

/**
 * Split one phase into children (`4` → `4a/4b/4c`).
 *
 * Children inherit the parent's acceptance/mustKeep/decisions/sources, get
 * `parentPid` plus the parent in `dependsOn`, start `pending` without a result,
 * and auto-number as `<parent.number><letter>` unless they bring a number. The
 * parent becomes `split` and keeps its own fields.
 */
export function splitPhaseInProject(project, phaseId, children, at, { phaseId: mintPhaseId, limits = PLAN_LIMITS } = {}) {
  const pid = phaseRef(phaseId)
  const phases = project.phases ?? []
  const parent = findPhase(project, pid)
  if (parent.status === 'split') {
    throw new TodoInputError('plan/phase-not-splittable', `阶段 ${parent.number} 已经是 split，不能再拆`)
  }
  if (parent.status === 'done' || parent.status === 'dropped') {
    throw new TodoInputError('plan/phase-not-splittable', `阶段 ${parent.number} 状态是 ${parent.status}，不能拆分`)
  }
  if (phases.some((entry) => entry.parentPid === pid)) {
    throw new TodoInputError('plan/phase-has-children', `阶段 ${parent.number} 已有子阶段；先删除或调整它们`)
  }
  const items = arrayWithin(children, limits.phases, 'plan/split-children-limit', `一次拆分最多 ${limits.phases} 个子阶段`)
  if (items.length === 0) {
    throw new TodoInputError('plan/split-children-required', 'split 至少需要一个子阶段')
  }
  const taken = new Set(phases.map((entry) => entry.pid))
  const created = items.map((child, index) => {
    const source = child === null || typeof child !== 'object' || Array.isArray(child) ? {} : child
    const number = cleanLine(source.number, 32) || splitChildNumber(parent.number, index)
    const dependsOn = [
      parent.pid,
      ...(Array.isArray(source.dependsOn) ? source.dependsOn : []),
    ].filter((value, position, list) => typeof value === 'string' && value !== '' && list.indexOf(value) === position)
    return normalizePhase(
      {
        ...source,
        parentPid: parent.pid,
        number,
        dependsOn,
        acceptance: source.acceptance ?? parent.acceptance,
        mustKeep: source.mustKeep ?? parent.mustKeep,
        decisions: source.decisions ?? parent.decisions,
        sources: source.sources ?? parent.sources,
        status: 'pending',
      },
      phases.length + index,
      at,
      { phaseId: mintPhaseId, taken, limits }
    )
  })
  const parentNext = { ...parent, status: 'split', updatedAt: at }
  const index = phases.findIndex((entry) => entry.pid === pid)
  const nextPhases = [
    ...phases.slice(0, index),
    parentNext,
    ...created,
    ...phases.slice(index + 1),
  ]
  return { patch: { phases: nextPhases }, affectedPhaseIds: [pid, ...created.map((entry) => entry.pid)] }
}

/** Reorder one phase within its own parent group; display numbers never change. */
export function movePhaseInProject(project, phaseId, input, at, { limits = PLAN_LIMITS } = {}) {
  const pid = phaseRef(phaseId)
  const phases = project.phases ?? []
  const phase = findPhase(project, pid)
  const beforePid = cleanLine(input?.beforePid, 64)
  const afterPid = cleanLine(input?.afterPid, 64)
  if ((beforePid === '') === (afterPid === '')) {
    throw new TodoInputError('plan/phase-move-target-required', 'move 必须给 beforePid 或 afterPid 之一')
  }
  const targetPid = beforePid !== '' ? beforePid : afterPid
  if (targetPid === pid) {
    throw new TodoInputError('plan/phase-move-target-self', '不能把阶段移动到自己前后')
  }
  const target = findPhase(project, targetPid)
  if ((phase.parentPid ?? null) !== (target.parentPid ?? null)) {
    throw new TodoInputError(
      'plan/phase-move-cross-parent',
      `阶段 ${phase.number} 与 ${target.number} 不在同一父级；改父级请用 plan.phase.update 的 parentPid`,
    )
  }
  const rest = phases.filter((entry) => entry.pid !== pid)
  const targetIndex = rest.findIndex((entry) => entry.pid === targetPid)
  const insertAt = beforePid !== '' ? targetIndex : targetIndex + 1
  const nextPhases = [...rest.slice(0, insertAt), phase, ...rest.slice(insertAt)]
  return { patch: { phases: nextPhases }, affectedPhaseIds: [pid] }
}

/**
 * Change one phase's status. `split` is reached only through
 * `splitPhaseInProject`, and a `split` parent cannot be moved by hand. B2 has no
 * transition matrix: any other target is allowed (and `done` does not require a
 * recorded result — the developer decides; C1 adds the proposal-side check).
 */
export function setPhaseStatusInProject(project, phaseId, status, at, { limits = PLAN_LIMITS } = {}) {
  const pid = phaseRef(phaseId)
  const phases = project.phases ?? []
  const phase = findPhase(project, pid)
  if (!PHASE_STATUSES.includes(status)) {
    throw new TodoInputError('plan/invalid-phase-status', `status 必须是 ${PHASE_STATUSES.join(' / ')}`)
  }
  if (status === 'split') {
    throw new TodoInputError('plan/phase-status-split', 'split 只能通过 plan.phase.split 产生')
  }
  if (phase.status === 'split') {
    throw new TodoInputError('plan/phase-is-split', `阶段 ${phase.number} 已拆分；状态由子阶段体现`)
  }
  if (phase.status === status) {
    return { patch: { phases }, affectedPhaseIds: [pid] }
  }
  const nextPhases = phases.map((entry) => (entry.pid === pid ? { ...entry, status, updatedAt: at } : entry))
  return { patch: { phases: nextPhases }, affectedPhaseIds: [pid] }
}

/**
 * Record (or replace) one phase's actual result. The report defaults to
 * `verification:'claimed'`; recording a result never changes the status.
 */
export function recordPhaseResultInProject(project, phaseId, result, at, { limits = PLAN_LIMITS } = {}) {
  const pid = phaseRef(phaseId)
  const phases = project.phases ?? []
  const phase = findPhase(project, pid)
  const normalized = normalizePhaseResult(result, at, limits)
  const nextPhases = phases.map((entry) => (entry.pid === pid ? { ...entry, result: normalized, updatedAt: at } : entry))
  return { patch: { phases: nextPhases }, affectedPhaseIds: [pid] }
}

// ── Phase context pack (B4, PLAN.md §B4) ───────────────────────────────────
// The structured pack is the single source of fields; the client renders the
// localized seed in B5 and the tool renders the text below. Neither carries
// history bodies: sources stay pointers.

/**
 * Build the handoff pack for one phase.
 *
 * @param project - a complete project record.
 * @param phaseId - phase pid; omitted uses `project.currentPhaseId`.
 * @param options - `limits` override.
 * @returns the structured pack (pending proposals and workspace rules are filled
 *   by the store, which can see the other tables).
 * @throws {TodoInputError} when no phase can be resolved.
 */
export function buildPhaseContextPack(project, phaseId) {
  const phases = Array.isArray(project.phases) ? project.phases : []
  const requested = phaseId === undefined || phaseId === null ? '' : cleanLine(phaseId, 64)
  const targetPid = requested === '' ? (project.currentPhaseId ?? '') : requested
  if (targetPid === '') {
    throw new TodoInputError('plan/phase-required', '项目没有当前阶段；请指定 phaseId')
  }
  const phase = phases.find((entry) => entry.pid === targetPid)
  if (phase === undefined) throw new TodoInputError('plan/phase-not-found', `阶段 ${targetPid} 不存在`)
  const current =
    project.currentPhaseId === undefined ? undefined : phases.find((entry) => entry.pid === project.currentPhaseId)
  const prerequisites = (phase.dependsOn ?? [])
    .map((pid) => phases.find((entry) => entry.pid === pid))
    .filter((entry) => entry !== undefined)
    .map((entry) => ({
      pid: entry.pid,
      number: entry.number,
      title: entry.title,
      status: entry.status,
      result: entry.result ?? null,
    }))
  const sources = []
  const seen = new Set()
  const addSources = (list) => {
    for (const source of list ?? []) {
      if (sources.length >= CONTEXT_SOURCE_LIMIT) return
      const key = JSON.stringify([source.sid, source.kind, source.where ?? null])
      if (seen.has(key)) continue
      seen.add(key)
      sources.push(source)
    }
  }
  addSources(project.sources)
  addSources(phase.sources)
  for (const prerequisite of prerequisites) {
    addSources(phases.find((entry) => entry.pid === prerequisite.pid)?.sources)
  }
  return {
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal,
      status: project.status,
      version: project.version,
      workspace: project.workspace,
      currentPhase:
        current === undefined ? null : { pid: current.pid, number: current.number, title: current.title },
    },
    phase: {
      pid: phase.pid,
      number: phase.number,
      title: phase.title,
      goal: phase.goal ?? '',
      status: phase.status,
      nextStep: phase.nextStep ?? '',
      ...(phase.parentPid === undefined ? {} : { parentPid: phase.parentPid }),
    },
    isCurrent: project.currentPhaseId === phase.pid,
    prerequisites,
    decisions: [
      ...(project.decisions ?? []).map((item) => ({ scope: 'project', label: item.label, text: item.text })),
      ...(phase.decisions ?? []).map((item) => ({ scope: 'phase', label: item.label, text: item.text })),
    ],
    mustKeep: (phase.mustKeep ?? []).map((item) => ({ label: item.label, text: item.text })),
    acceptance: (phase.acceptance ?? []).map((item) => ({
      label: item.label,
      text: item.text,
      ...(item.basis === undefined ? {} : { basis: item.basis }),
    })),
    risks: (project.risks ?? []).map((item) => ({ label: item.label, text: item.text })),
    unresolved: (phase.notes ?? []).filter((note) => note.kind === 'no-result').map((note) => note.text),
    sources,
    pendingProposalCount: 0,
    rules: '',
  }
}

/**
 * Render a pack as the text a fresh session opens with. Sections are added in
 * priority order and the result is guaranteed at most `limit` code points; when
 * something is dropped, the text says so and points at the read tools.
 *
 * @param pack - the pack from {@link buildPhaseContextPack}.
 * @param options - `limit` (default 4000).
 * @returns the handoff text.
 */
export function renderPhaseContextText(pack, { limit = CONTEXT_TEXT_LIMIT } = {}) {
  const budget = Math.max(40, limit - 160)
  const lines = []
  let used = 0
  let truncated = false
  const push = (text) => {
    if (typeof text !== 'string' || text === '') return true
    const chars = [...text]
    const remaining = budget - used - 1
    if (remaining <= 0) {
      truncated = true
      return false
    }
    if (chars.length > remaining) {
      lines.push(`${chars.slice(0, Math.max(0, remaining - 1)).join('')}…`)
      used += remaining
      truncated = true
      return false
    }
    lines.push(text)
    used += chars.length + 1
    return true
  }
  const list = (title, items) => {
    if (items.length === 0) return
    if (!push(title)) return
    for (const item of items) if (!push(item)) return
  }
  const project = pack?.project ?? {}
  const phase = pack?.phase ?? {}
  push(`Plan handoff: ${project.name} — phase ${phase.number} ${phase.title} [${phase.status}] (project ${project.status}, v${project.version})`)
  if (pack?.isCurrent !== true && project.currentPhase !== null && project.currentPhase !== undefined) {
    push(`Project current phase: ${project.currentPhase.number} ${project.currentPhase.title}`)
  }
  push(`Overall goal: ${project.goal ?? ''}`)
  push(`This phase goal: ${phase.goal === '' ? '(not recorded)' : phase.goal}`)
  push(`Next step: ${phase.nextStep === '' ? '(not recorded)' : phase.nextStep}`)
  list('Before you start:', [
    '- Verify the referenced files/documents before relying on them; paths are leads, not facts.',
    '- Do not read history bodies on your own; ask the developer first.',
    '- If a source conflicts with this plan, report it to the developer.',
    '- Read the full plan with todo_plan_read when this handoff is not enough.',
  ])
  if ((pack?.prerequisites ?? []).length > 0 && push('Prerequisite phases (direct dependencies):')) {
    for (const prerequisite of pack.prerequisites) {
      const result =
        prerequisite.result === null || prerequisite.result === undefined
          ? 'result not recorded'
          : prerequisite.result.summary
      if (!push(`- ${prerequisite.number} ${prerequisite.title} [${prerequisite.status}] — result: ${result}`)) break
    }
  }
  list('Decisions:', (pack?.decisions ?? []).map((item) => `- [${item.scope}] ${item.text}`))
  list('Must keep:', (pack?.mustKeep ?? []).map((item) => `- ${item.text}`))
  list('Acceptance:', (pack?.acceptance ?? []).map((item) => `- ${item.text}`))
  list('Risks:', (pack?.risks ?? []).map((item) => `- ${item.text}`))
  list('Unresolved:', (pack?.unresolved ?? []).map((item) => `- ${item}`))
  const rules = typeof pack?.rules === 'string' ? pack.rules.trim() : ''
  if (rules !== '') list('Workspace rules:', rules.split('\n'))
  list(
    'Sources (pointers only):',
    (pack?.sources ?? []).map((source) => {
      const where =
        source.where?.file ?? (source.where?.sessionId === undefined ? '' : `session ${source.where.sessionId}`)
      return `- ${source.sid} [${source.kind}] ${source.label}${where === '' ? '' : ` — ${where}`}`
    }),
  )
  if (Number.isInteger(pack?.pendingProposalCount) && pack.pendingProposalCount > 0) {
    push(`Pending plan proposals: ${pack.pendingProposalCount}`)
  }
  if (truncated) {
    const hint = `(truncated at ~${budget} characters; open the full plan with todo_plan_read or todo_read before relying on missing details)`
    const room = limit - used - 1
    if (room > 20) {
      const chars = [...hint]
      lines.push(chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join('')}…` : hint)
    }
  }
  return lines.join('\n')
}

/** Trim and collapse whitespace so a title stays one scannable line. */
function cleanLine(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  return limit === undefined ? text : text.slice(0, limit)
}

/** Length in code points, so a Chinese character counts once. */
function textLength(value) {
  return [...value].length
}

/**
 * Normalize one evidence pointer, keeping only well-formed fields.
 *
 * @param where - untrusted wire value.
 * @returns the pointer, or `undefined` when nothing usable remains.
 */
function normalizeWhere(where) {
  if (where === null || typeof where !== 'object') return undefined
  const next = {}
  if (typeof where.file === 'string' && where.file.trim() !== '') next.file = cleanLine(where.file, 1024)
  if (typeof where.sessionId === 'string' && where.sessionId.trim() !== '') next.sessionId = cleanLine(where.sessionId, 256)
  if (
    Array.isArray(where.seqRange) &&
    where.seqRange.length === 2 &&
    where.seqRange.every((value) => Number.isInteger(value) && value >= 0)
  ) {
    next.seqRange = [where.seqRange[0], where.seqRange[1]]
  }
  if (Number.isInteger(where.offset) && where.offset >= 0) next.offset = where.offset
  return Object.keys(next).length === 0 ? undefined : next
}

/** Normalize a free-text field; an empty string becomes `undefined`. */
function optionalText(value, limit) {
  const text = cleanLine(value, limit)
  return text === '' ? undefined : text
}

/** Title rules shared by manual create and inline edit. */
export const TITLE_LIMIT = 80
/** One-line next-step limit for the card body. */
export const NEXT_STEP_LIMIT = 280

/**
 * Capture-form limits (DESIGN.md §5.1). These are the tool's hard constraints:
 * a field over its limit is rejected so the model rewrites instead of writing a
 * summary. They are deliberately tighter than the manual-editing limits above.
 */
export const CAPTURE_LIMITS = {
  title: 40,
  nextStep: 280,
  mustReadItems: 3,
  mustReadText: 200,
  mustReadLabel: 60,
  parkItems: 10,
  parkLabel: 30,
  parkWhy: 60,
  touchedFiles: 32,
  symbols: 16,
  optionalText: 280,
}

/**
 * Build the record payload from a create request, validating as it goes.
 *
 * @param input - untrusted wire payload.
 * @param context - clock and id allocation.
 * @returns the complete record.
 * @throws {TodoInputError} when a field is unusable.
 */
export function buildRecord(input, { now, nextId, label }) {
  const title = cleanLine(input?.title, TITLE_LIMIT)
  if (title === '') {
    throw new TodoInputError('todo/title-required', 'title 不能为空')
  }
  const kind = input?.kind
  if (!KINDS.includes(kind)) {
    throw new TodoInputError('todo/invalid-kind', `kind 必须是 ${KINDS.join(' / ')}`)
  }
  const workspace = cleanLine(input?.workspace, 4096)
  if (workspace === '') {
    throw new TodoInputError('todo/workspace-required', 'workspace 不能为空')
  }

  const at = now()
  const sessionId = cleanLine(input?.sessionId, 256)
  const rootSessionId = cleanLine(input?.rootSessionId, 256)
  const briefResult = normalizeBrief(input?.brief)
  if (briefResult.errors.length > 0) {
    const first = briefResult.errors[0]
    throw new TodoInputError(first.code, first.message)
  }
  const core = {
    nextStep: cleanLine(input?.nextStep, NEXT_STEP_LIMIT),
  }
  if (briefResult.brief !== undefined) core.nextStep = briefResult.brief.nextAction
  const symptom = optionalText(input?.symptom, NEXT_STEP_LIMIT)
  const cause = optionalText(input?.cause, NEXT_STEP_LIMIT)
  const intent = optionalText(input?.intent, NEXT_STEP_LIMIT)
  if (symptom !== undefined) core.symptom = symptom
  if (cause !== undefined) core.cause = cause
  if (intent !== undefined) core.intent = intent
  const touchedFiles = Array.isArray(input?.touchedFiles)
    ? [...new Set(input.touchedFiles.slice(0, 32).map((file) => normalizeTouchedPath(cleanLine(file, 1024), workspace)).filter(Boolean))]
    : []
  const projectId = optionalText(input?.projectId, 64)
  const phaseId = optionalText(input?.phaseId, 64)
  const substantive = core.symptom !== undefined || core.cause !== undefined || core.intent !== undefined
  if (briefResult.brief === undefined && !substantive && touchedFiles.length > 0) {
    throw new TodoInputError(
      'todo/brief-required',
      'file paths alone are not a task brief; add a brief or at least one substantive symptom/cause/intent, or leave touchedFiles empty for a simple legacy card',
    )
  }

  return {
    id: nextId(),
    ...(label === undefined ? {} : { major: label.major, minor: label.minor }),
    workspace,
    title,
    status: 'open',
    kind,
    createdAt: at,
    updatedAt: at,
    ...(sessionId === ''
      ? {}
      : {
          origin: {
            sessionId,
            ...(rootSessionId === '' ? {} : { rootSessionId }),
            turn: Math.max(0, Number.isInteger(input?.turn) ? input.turn : 0),
            seqRange: [0, 0],
            cwd: workspace,
            at,
          },
        }),
    ...(briefResult.brief === undefined ? {} : { brief: briefResult.brief }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(phaseId === undefined ? {} : { phaseId }),
    code: emptyCode(),
    touchedFiles,
    core,
    mustRead: [],
    park: [],
    notes: [],
  }
}

/**
 * Build the record a `todo_add` call stores, enforcing the capture-form limits
 * of DESIGN.md §5.1. Every rejection carries a stable code and a message the
 * model can act on by rewriting the call.
 *
 * @param input - untrusted tool arguments.
 * @param deps - clock, id allocator, resolved origin/code/workspace.
 * @returns the record plus the soft warnings shown back to the model.
 * @throws {TodoInputError} when a field is missing or over its limit.
 */
/** Normalize optional source ids shared by evidence/park/note fields. */
function normalizeSourceIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((sid) => typeof sid === 'string' && sid.trim() !== '').map((sid) => sid.trim()))].slice(0, 32)
}

/** Normalize an optional BriefBasis on legacy evidence/park fields. */
function normalizeBasis(value, field) {
  if (value === undefined) return undefined
  if (!BRIEF_BASES.includes(value)) {
    throw new TodoInputError('todo/invalid-basis', `${field}.basis must be one of: ${BRIEF_BASES.join(', ')}`)
  }
  return value
}

export function assembleCapture(input, { now, nextId, origin, code, workspace, label, request, observedFiles }) {
  const title = cleanLine(input?.title)
  if (title === '') throw new TodoInputError('todo/title-required', 'title is required')
  if (textLength(title) > CAPTURE_LIMITS.title) {
    throw new TodoInputError(
      'todo/title-too-long',
      `title must be at most ${CAPTURE_LIMITS.title} characters (got ${textLength(title)}); make it one scannable line`,
    )
  }
  const kind = input?.kind
  if (!KINDS.includes(kind)) {
    throw new TodoInputError('todo/invalid-kind', `kind must be one of: ${KINDS.join(', ')}`)
  }
  const warnings = []
  const briefResult = normalizeBrief(input?.brief)
  if (briefResult.errors.length > 0) {
    const first = briefResult.errors[0]
    throw new TodoInputError(first.code, first.message)
  }
  if (briefResult.brief !== undefined) {
    const briefWarnings = [
      ...briefResult.warnings,
      ...briefQuality(briefResult.brief, { source: 'stored' }),
    ]
    warnings.push(...new Set(briefWarnings))
  }
  let nextStep = cleanLine(input?.nextStep)
  if (briefResult.brief !== undefined && nextStep !== briefResult.brief.nextAction) {
    warnings.push(
      nextStep === ''
        ? 'nextStep was empty; using brief.nextAction'
        : 'nextStep differs from brief.nextAction; the brief value is canonical and core.nextStep was synchronized',
    )
    nextStep = briefResult.brief.nextAction
  }
  if (nextStep === '') {
    throw new TodoInputError('todo/next-step-required', 'nextStep is required: how to fix it (defect) or what to verify (idea)')
  }
  if (textLength(nextStep) > CAPTURE_LIMITS.nextStep) {
    throw new TodoInputError('todo/next-step-too-long', `nextStep must be at most ${CAPTURE_LIMITS.nextStep} characters`)
  }

  const mustReadRaw = input?.mustRead === undefined || input?.mustRead === null ? [] : input.mustRead
  if (!Array.isArray(mustReadRaw)) throw new TodoInputError('todo/invalid-must-read', 'mustRead must be an array')
  if (mustReadRaw.length > CAPTURE_LIMITS.mustReadItems) {
    throw new TodoInputError(
      'todo/too-many-must-read',
      `mustRead accepts at most ${CAPTURE_LIMITS.mustReadItems} items; keep only what a later session cannot rediscover`,
    )
  }
  const mustRead = mustReadRaw.map((item, index) => {
    const text = cleanLine(item?.text)
    if (text === '') throw new TodoInputError('todo/invalid-must-read', `mustRead[${index}].text is required`)
    if (textLength(text) > CAPTURE_LIMITS.mustReadText) {
      throw new TodoInputError(
        'todo/must-read-too-long',
        `mustRead[${index}].text must be at most ${CAPTURE_LIMITS.mustReadText} characters; this is selection, not a summary`,
      )
    }
    const label = cleanLine(item?.label, CAPTURE_LIMITS.mustReadLabel)
    if (label === '') throw new TodoInputError('todo/invalid-must-read', `mustRead[${index}].label is required`)
    const where = normalizeWhere(item?.where)
    const sourceIds = normalizeSourceIds(item?.sourceIds)
    const basis = normalizeBasis(item?.basis, 'mustRead')
    const observed = where?.file !== undefined && observedFiles instanceof Set ? { observed: observedFiles.has(where.file) } : {}
    return {
      label,
      text,
      ...(where === undefined ? {} : { where }),
      ...(basis === undefined ? {} : { basis }),
      ...observed,
      ...(sourceIds.length === 0 ? {} : { sourceIds }),
    }
  })

  const parkRaw = input?.park === undefined || input?.park === null ? [] : input.park
  if (!Array.isArray(parkRaw)) throw new TodoInputError('todo/invalid-park', 'park must be an array')
  if (parkRaw.length > CAPTURE_LIMITS.parkItems) {
    throw new TodoInputError('todo/too-many-park', `park accepts at most ${CAPTURE_LIMITS.parkItems} items`)
  }
  const park = parkRaw.map((item, index) => {
    const label = cleanLine(item?.label)
    if (label === '') throw new TodoInputError('todo/invalid-park', `park[${index}].label is required`)
    if (textLength(label) > CAPTURE_LIMITS.parkLabel) {
      throw new TodoInputError(
        'todo/park-label-too-long',
        `park[${index}].label must be at most ${CAPTURE_LIMITS.parkLabel} characters: say what it is, not why`,
      )
    }
    const why = cleanLine(item?.why)
    if (why === '') throw new TodoInputError('todo/invalid-park', `park[${index}].why is required`)
    if (textLength(why) > CAPTURE_LIMITS.parkWhy) {
      throw new TodoInputError('todo/park-why-too-long', `park[${index}].why must be at most ${CAPTURE_LIMITS.parkWhy} characters`)
    }
    const where = normalizeWhere(item?.where)
    const sourceIds = normalizeSourceIds(item?.sourceIds)
    const basis = normalizeBasis(item?.basis, 'park')
    const observed = where?.file !== undefined && observedFiles instanceof Set ? { observed: observedFiles.has(where.file) } : {}
    return {
      id: `p${index + 1}`,
      label,
      why,
      ...(where === undefined ? {} : { where }),
      ...(basis === undefined ? {} : { basis }),
      ...observed,
      ...(sourceIds.length === 0 ? {} : { sourceIds }),
    }
  })

  const symbolsRaw = input?.symbols === undefined || input?.symbols === null ? [] : input.symbols
  if (!Array.isArray(symbolsRaw)) throw new TodoInputError('todo/invalid-symbols', 'symbols must be an array')
  if (symbolsRaw.length > CAPTURE_LIMITS.symbols) {
    throw new TodoInputError('todo/too-many-symbols', `symbols accepts at most ${CAPTURE_LIMITS.symbols} items`)
  }
  const symbols = symbolsRaw.map((item, index) => {
    const file = normalizeTouchedPath(cleanLine(item?.file, 1024), workspace)
    if (file === '') throw new TodoInputError('todo/invalid-symbols', `symbols[${index}].file is required`)
    const symbol = optionalText(item?.symbol, 256)
    const entry = symbol === undefined ? { file } : { file, symbol }
    if (Number.isInteger(item?.line) && item.line > 0) entry.line = item.line
    return entry
  })

  const touchedFilesRaw = input?.touchedFiles === undefined || input?.touchedFiles === null ? [] : input.touchedFiles
  if (!Array.isArray(touchedFilesRaw)) throw new TodoInputError('todo/invalid-touched-files', 'touchedFiles must be an array')
  const touchedFiles = []
  const seenFiles = new Set()
  for (const file of touchedFilesRaw) {
    const path = normalizeTouchedPath(cleanLine(file, 1024), workspace)
    if (path === '' || seenFiles.has(path)) continue
    seenFiles.add(path)
    touchedFiles.push(path)
    if (touchedFiles.length >= CAPTURE_LIMITS.touchedFiles) break
  }
  if (touchedFiles.length === 0) {
    warnings.push('touchedFiles is empty: the card cannot be matched to later work by file, so recording it is weaker')
  } else if (briefResult.brief === undefined && mustRead.length === 0) {
    warnings.push('no task brief and no must-read facts: the card has file paths but no task intelligence; add a brief instead of relying on paths')
  }

  const core = { nextStep }
  const symptom = optionalText(input?.symptom, CAPTURE_LIMITS.optionalText)
  const cause = optionalText(input?.cause, CAPTURE_LIMITS.optionalText)
  const intent = optionalText(input?.intent, CAPTURE_LIMITS.optionalText)
  if (symptom !== undefined) core.symptom = symptom
  if (cause !== undefined) core.cause = cause
  if (intent !== undefined) core.intent = intent

  const substantive = mustRead.length > 0 || core.symptom !== undefined || core.cause !== undefined || core.intent !== undefined
  if (briefResult.brief === undefined && !substantive && (touchedFiles.length > 0 || park.length > 0 || symbols.length > 0)) {
    throw new TodoInputError(
      'todo/brief-required',
      'source pointers alone are not a task brief; add a brief or at least one mustRead fact (simple legacy cards without paths remain compatible)',
    )
  }

  const at = now()
  const projectId = optionalText(input?.projectId, 64)
  const phaseId = optionalText(input?.phaseId, 64)
  const record = {
    id: nextId(),
    ...(label === undefined ? {} : { major: label.major, minor: label.minor }),
    workspace,
    title,
    status: 'open',
    kind,
    createdAt: at,
    updatedAt: at,
    ...(origin === undefined ? {} : { origin }),
    ...(request === undefined ? {} : { request }),
    ...(briefResult.brief === undefined ? {} : { brief: briefResult.brief }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(phaseId === undefined ? {} : { phaseId }),
    code: code === undefined ? emptyCode() : { ...code, symbols },
    touchedFiles,
    core,
    mustRead,
    park,
    notes: [],
  }
  return { record, warnings }
}

/**
 * Apply a manual edit to a stored record. Only the fields the M1 UI can change
 * are accepted here; capture-time fields are owned by `todo_add` (M2).
 *
 * @param record - the stored record (not mutated).
 * @param patch - partial changes from the wire.
 * @param at - write timestamp.
 * @returns the updated record.
 * @throws {TodoInputError} when a provided field is unusable.
 */
export function applyPatch(record, patch, at) {
  const next = { ...record }
  if (patch?.title !== undefined) {
    const title = cleanLine(patch.title, TITLE_LIMIT)
    if (title === '') throw new TodoInputError('todo/title-required', 'title 不能为空')
    next.title = title
  }
  if (patch?.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      throw new TodoInputError('todo/invalid-status', `status 必须是 ${STATUSES.join(' / ')}`)
    }
    next.status = patch.status
  }
  if (patch?.nextStep !== undefined) {
    const nextStep = cleanLine(patch.nextStep, NEXT_STEP_LIMIT)
    next.core = { ...record.core, nextStep }
    if (next.brief !== undefined) next.brief = { ...next.brief, nextAction: nextStep }
  }
  if (patch?.brief !== undefined) {
    const result = normalizeBrief(patch.brief)
    if (result.errors.length > 0) {
      const first = result.errors[0]
      throw new TodoInputError(first.code, first.message)
    }
    if (result.brief === undefined) {
      delete next.brief
    } else {
      next.brief = result.brief
      next.core = { ...next.core, nextStep: result.brief.nextAction }
    }
  }
  // The verbatim request is normally host-captured; this path repairs a card
  // whose capture predates the block-aware rule.
  if (patch?.request?.text !== undefined) {
    const text = typeof patch.request.text === 'string' ? patch.request.text.trim() : ''
    if (text === '') throw new TodoInputError('todo/request-required', 'request.text 不能为空')
    const chars = [...text]
    const capped = chars.length > 8000 ? { text: chars.slice(0, 8000).join(''), truncated: true } : { text }
    next.request = { ...(record.request ?? {}), ...capped, turn: record.request?.turn ?? 0, at: record.request?.at ?? at }
  }
  // Weak project link (B1): `null`/empty clears it; no existence check.
  if (patch?.projectId !== undefined) {
    const projectId = patch.projectId === null ? undefined : optionalText(patch.projectId, 64)
    if (projectId === undefined) delete next.projectId
    else next.projectId = projectId
  }
  if (patch?.phaseId !== undefined) {
    const phaseId = patch.phaseId === null ? undefined : optionalText(patch.phaseId, 64)
    if (phaseId === undefined) delete next.phaseId
    else next.phaseId = phaseId
  }
  next.updatedAt = at
  return next
}

/**
 * Sources for a card. Stored sources win; a legacy card without `sources`
 * projects a read-only `s0` origin plus file pointers, never writing them back.
 *
 * @param record - stored record.
 * @returns source pointers without any body.
 */
/** Whether a mentioned file reads as documentation rather than code. */
function filePurpose(file) {
  return /\.(md|mdx|txt|rst|adoc)$/iu.test(file) || /(^|\/)docs?\//iu.test(file) ? 'doc' : 'code'
}

/** Allocate a file-source id that does not collide with stored source ids. */
function fileSid(sources) {
  let index = 1
  while (sources.some((source) => source.sid === `f${index}`)) index += 1
  return `f${index}`
}

function sourcesForRecord(record) {
  const stored = Array.isArray(record.sources) ? record.sources : []
  const sources = [...stored]
  const fileSeen = new Set(
    sources
      .filter((source) => source.kind === 'file')
      .map((source) => source.where?.file)
      .filter((file) => typeof file === 'string'),
  )
  const observed = new Map()
  const files = []
  for (const item of record.mustRead ?? []) {
    if (typeof item?.where?.file !== 'string') continue
    files.push(item.where.file)
    observed.set(item.where.file, item.observed === true)
  }
  for (const item of record.park ?? []) {
    if (typeof item?.where?.file !== 'string') continue
    files.push(item.where.file)
    observed.set(item.where.file, item.observed === true)
  }
  for (const file of record.touchedFiles ?? []) if (typeof file === 'string') files.push(file)

  if (sources.length === 0 && record.origin !== undefined && record.origin !== null) {
    sources.push({
      sid: 's0',
      kind: 'session',
      label: 'origin session',
      where: { sessionId: record.origin.sessionId, seqRange: record.origin.seqRange },
      turnRange: [record.origin.turn, record.origin.turn],
      origin: 'stated',
      verified: false,
      at: record.origin.at,
    })
  }

  for (const file of files) {
    if (file === '' || fileSeen.has(file) || sources.length >= SOURCE_LIMIT) continue
    fileSeen.add(file)
    const isObserved = observed.get(file) === true
    sources.push({
      sid: fileSid(sources),
      kind: 'file',
      label: file,
      purpose: filePurpose(file),
      where: { file },
      origin: isObserved ? 'observed' : 'stated',
      verified: isObserved,
      at: record.updatedAt,
    })
  }
  return sources.slice(0, SOURCE_LIMIT)
}

/**
 * Project the list-row shape (L0, DESIGN.md §3.2) sent to the browser. Reading a
 * card into context is a separate, cheaper-tier concern; the L0 keeps a row small.
 *
 * @param record - stored record.
 * @returns the list projection.
 */
export function projectL0(record) {
  const files = record.touchedFiles ?? []
  const sources = Array.isArray(record.sources) ? record.sources : []
  return {
    id: record.id,
    ...labelOf(record),
    title: record.title,
    status: record.status,
    kind: record.kind,
    workspace: record.workspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextStep: record.brief?.nextAction ?? record.core?.nextStep ?? '',
    symptom: record.core?.symptom ?? '',
    touchedFiles: files.slice(0, 3),
    touchedFileCount: files.length,
    sourceCount: sources.length,
    sessionSourceCount: sources.filter((source) => source.kind === 'session').length,
    fileSourceCount: sources.filter((source) => source.kind === 'file').length,
    notesCount: (record.notes ?? []).length,
    parkCount: (record.park ?? []).length,
    mustReadCount: (record.mustRead ?? []).length,
    hasBrief: record.brief !== undefined,
    briefGoal: (record.brief?.goal ?? record.core?.symptom ?? record.core?.intent ?? record.title ?? '').slice(0, 120),
    origin: record.origin === undefined ? null : { sessionId: record.origin.sessionId, turn: record.origin.turn, at: record.origin.at },
    handlingSession: record.handling === undefined ? null : record.handling.sessionId,
    hasRequest: record.request !== undefined,
    // Weak project link: both are `null` on an ordinary card.
    projectId: record.projectId ?? null,
    phaseId: record.phaseId ?? null,
  }
}

/**
 * Project one card for the detail view / `todo_read`: everything a later
 * session may need, with the parked pointers intact but their bodies not read.
 *
 * @param record - stored record.
 * @returns the full projection.
 */
export function projectFull(record) {
  const briefView = briefForRecord(record)
  let core = { nextStep: record.core?.nextStep ?? '' }
  if (record.core?.symptom !== undefined) core.symptom = record.core.symptom
  if (record.core?.cause !== undefined) core.cause = record.core.cause
  if (record.core?.intent !== undefined) core.intent = record.core.intent
  let briefWarnings = briefQuality(briefView.brief, { source: briefView.source })
  if (briefView.source === 'derived') {
    briefWarnings = briefWarnings.filter((warning) => !warning.startsWith('brief was derived from legacy fields'))
  }
  if (briefView.source === 'stored' && briefView.brief?.nextAction !== core.nextStep) {
    briefWarnings = [...briefWarnings, 'core.nextStep differed from brief.nextAction; the brief value is canonical']
    core = { ...core, nextStep: briefView.brief.nextAction }
  }
  if (briefView.source === 'stored') {
    const unbacked = (briefView.brief?.confirmed ?? []).filter(
      (item) => (item.basis === 'verified' || item.basis === 'decided') && (item.sourceIds ?? []).length === 0,
    )
    if (unbacked.length > 0) {
      briefWarnings = [
        ...briefWarnings,
        `${unbacked.length} confirmed/decided item(s) have no sourceIds; attach an existing source or mark them inferred/unknown`,
      ]
    }
  }
  return {
    id: record.id,
    ...labelOf(record),
    title: record.title,
    status: record.status,
    kind: record.kind,
    workspace: record.workspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    brief: briefView.brief,
    briefSource: briefView.source,
    briefWarnings,
    core,
    mustRead: record.mustRead ?? [],
    park: record.park ?? [],
    sources: sourcesForRecord(record),
    code: record.code ?? emptyCode(),
    touchedFiles: record.touchedFiles ?? [],
    notes: record.notes ?? [],
    origin: record.origin ?? null,
    handling: record.handling ?? null,
    request: record.request ?? null,
    // Weak project link: both are `null` on an ordinary card.
    projectId: record.projectId ?? null,
    phaseId: record.phaseId ?? null,
  }
}

/**
 * Project one project into its list row (B1). The counts are passed in because
 * only the store can see the proposal table.
 *
 * @param record - stored project.
 * @param extras - `pendingProposalCount` from the store.
 * @returns the project list projection.
 */
export function projectPlanL0(record, { pendingProposalCount = 0 } = {}) {
  const phases = Array.isArray(record.phases) ? record.phases : []
  const current = record.currentPhaseId === undefined ? undefined : phases.find((phase) => phase.pid === record.currentPhaseId)
  return {
    id: record.id,
    name: record.name,
    goal: [...(record.goal ?? '')].slice(0, 120).join(''),
    status: record.status,
    workspace: record.workspace,
    currentPhaseId: record.currentPhaseId ?? null,
    currentPhaseNumber: current?.number ?? null,
    currentPhaseTitle: current?.title ?? null,
    phaseCount: phases.length,
    version: record.version ?? 1,
    pendingProposalCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    origin:
      record.origin === undefined || record.origin === null
        ? null
        : { sessionId: record.origin.sessionId, turn: record.origin.turn, at: record.origin.at },
  }
}

/**
 * Project one project in full for `plan.detail` / `plan.export`. Phases and
 * their recorded results are included; nothing here reads history bodies.
 *
 * @param record - stored project.
 * @param extras - `pendingProposalCount` from the store.
 * @returns the full project projection.
 */
export function projectPlanFull(record, { pendingProposalCount = 0 } = {}) {
  const phases = Array.isArray(record.phases) ? record.phases : []
  const currentPhase =
    record.currentPhaseId === undefined ? null : (phases.find((phase) => phase.pid === record.currentPhaseId) ?? null)
  return {
    ...record,
    phases,
    currentPhase,
    phaseCount: phases.length,
    pendingProposalCount,
    origin: record.origin ?? null,
  }
}

/** Input rejection carrying a stable wire code. */
export class TodoInputError extends Error {
  /**
   * @param code - stable error code for the client.
   * @param message - human-readable, already user-facing.
   */
  constructor(code, message) {
    super(message)
    this.name = 'TodoInputError'
    this.code = code
  }
}
