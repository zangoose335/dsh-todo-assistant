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

/** Workspace bucket for cards that belong to no repository. */
export const INBOX = 'inbox'

/** Card status values, in the order the UI cycles/writes them. */
export const STATUSES = ['open', 'doing', 'done', 'dropped']
/** Card kinds; only `defect` requires `nextStep` to read as a fix plan. */
export const KINDS = ['defect', 'idea']

/** Note kinds accepted by the append-only note list. */
export const NOTE_KINDS = ['supplement', 'evidence', 'status']

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

  const evidenceRef = z.object({
    label: z.string(),
    text: z.string(),
    where: where.optional(),
  })

  const parkedRef = z.object({
    id: z.string(),
    label: z.string(),
    why: z.string(),
    where: where.extend({ offset: z.number().optional() }).optional(),
  })

  const note = z.object({
    at: z.number(),
    fromSession: z.string(),
    turn: z.number().int(),
    kind: z.enum(NOTE_KINDS),
    text: z.string(),
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

    mustRead: z.array(evidenceRef).default([]),
    park: z.array(parkedRef).default([]),
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
    tables: { todos: domainTable(todoRecord), rules: domainTable(rulesRecord) },
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
export function assembleCapture(input, { now, nextId, origin, code, workspace, label, request }) {
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
    return where === undefined ? { label, text } : { label, text, where }
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
    return where === undefined ? { id: `p${index + 1}`, label, why } : { id: `p${index + 1}`, label, why, where }
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
  next.updatedAt = at
  return next
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
    notesCount: (record.notes ?? []).length,
    parkCount: (record.park ?? []).length,
    mustReadCount: (record.mustRead ?? []).length,
    hasBrief: record.brief !== undefined,
    briefGoal: (record.brief?.goal ?? record.core?.symptom ?? record.core?.intent ?? record.title ?? '').slice(0, 120),
    origin: record.origin === undefined ? null : { sessionId: record.origin.sessionId, turn: record.origin.turn, at: record.origin.at },
    handlingSession: record.handling === undefined ? null : record.handling.sessionId,
    hasRequest: record.request !== undefined,
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
    code: record.code ?? emptyCode(),
    touchedFiles: record.touchedFiles ?? [],
    notes: record.notes ?? [],
    origin: record.origin ?? null,
    handling: record.handling ?? null,
    request: record.request ?? null,
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
