/**
 * todo-assistant — task brief (TaskBrief) model and quality rules.
 *
 * A card is first a *task brief*: what to solve, why, what is already
 * confirmed, what must not be violated, where to start, and what is still
 * unknown. File paths and source pointers are fallback leads, never a
 * substitute for the brief.
 *
 * This module is import-free on purpose: `domain.js`, `tool.js`, `api.js` and
 * the offline harness can all share the same rules without pulling the profile
 * runtime in. It returns structured errors instead of throwing so `domain.js`
 * can translate them into its own `TodoInputError`.
 */

/** Epistemic basis of one brief item. */
export const BRIEF_BASES = ['requirement', 'decided', 'verified', 'inferred', 'unknown', 'superseded']

/** Whether an open question blocks starting work. */
export const BRIEF_IMPACTS = ['blocking', 'non-blocking']

/**
 * Capture limits. These are deliberately small: a brief is selection, not a
 * transcript. `totalSoft` is a warning threshold; `totalHard` rejects so a
 * model cannot silently store an essay. All counts are code points.
 */
export const BRIEF_LIMITS = {
  goal: 200,
  why: 200,
  nextAction: 280,
  itemText: 200,
  confirmedItems: 6,
  constraintsItems: 4,
  leadsItems: 4,
  openQuestionsItems: 4,
  sourceIdsPerItem: 8,
  totalSoft: 1200,
  totalHard: 1600,
}

/** Collapse whitespace and trim; a brief item is one line. */
function cleanLine(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  return limit === undefined ? text : [...text].slice(0, limit).join('')
}

/** Length in code points, so a CJK character counts once. */
function textLength(value) {
  return typeof value === 'string' ? [...value].length : 0
}

/** Build one structured error object. */
function error(code, message) {
  return { code, message }
}

/**
 * Normalize one brief item. Missing/invalid `basis` is an error: the model must
 * say whether it is a requirement, decision, verified fact, inference, unknown,
 * or superseded old plan.
 */
function normalizeItem(raw, name, index, errors, warnings) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(error('todo/brief-invalid-item', `${name}[${index}] must be an object with text and basis`))
    return undefined
  }
  const text = cleanLine(raw.text)
  if (text === '') {
    errors.push(error('todo/brief-item-text-required', `${name}[${index}].text is required`))
    return undefined
  }
  if (textLength(text) > BRIEF_LIMITS.itemText) {
    errors.push(
      error(
        'todo/brief-item-too-long',
        `${name}[${index}].text must be at most ${BRIEF_LIMITS.itemText} characters; keep one fact, not a summary`,
      ),
    )
    return undefined
  }
  const basis = raw.basis
  if (!BRIEF_BASES.includes(basis)) {
    errors.push(
      error(
        'todo/brief-invalid-basis',
        `${name}[${index}].basis must be one of: ${BRIEF_BASES.join(', ')}`,
      ),
    )
    return undefined
  }

  const item = { text, basis }
  if (raw.sourceIds !== undefined) {
    if (!Array.isArray(raw.sourceIds)) {
      errors.push(error('todo/brief-invalid-source-ids', `${name}[${index}].sourceIds must be an array`))
      return undefined
    }
    const sourceIds = [...new Set(raw.sourceIds.map((value) => cleanLine(value)).filter(Boolean))]
    if (sourceIds.length > BRIEF_LIMITS.sourceIdsPerItem) {
      errors.push(
        error(
          'todo/brief-too-many-source-ids',
          `${name}[${index}].sourceIds accepts at most ${BRIEF_LIMITS.sourceIdsPerItem} items`,
        ),
      )
      return undefined
    }
    if (sourceIds.length > 0) item.sourceIds = sourceIds
  }
  if (raw.impact !== undefined) {
    if (!BRIEF_IMPACTS.includes(raw.impact)) {
      errors.push(error('todo/brief-invalid-impact', `${name}[${index}].impact must be blocking or non-blocking`))
      return undefined
    }
    item.impact = raw.impact
  }
  if (item.basis === 'superseded') {
    warnings.push(`${name}[${index}] is marked superseded; keep it out of current constraints`)
  }
  return item
}

/** Normalize one item array, deduplicate by text, and enforce the item cap. */
function normalizeItems(raw, name, limit, errors, warnings) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push(error('todo/brief-invalid-list', `${name} must be an array`))
    return []
  }
  if (raw.length > limit) {
    errors.push(error('todo/brief-too-many-items', `${name} accepts at most ${limit} items`))
    return []
  }
  const items = []
  const seen = new Set()
  for (const [index, value] of raw.entries()) {
    const item = normalizeItem(value, name, index, errors, warnings)
    if (item === undefined) continue
    const key = item.text
    if (seen.has(key)) {
      warnings.push(`${name}[${index}] repeats an earlier item; dropped the duplicate`)
      continue
    }
    seen.add(key)
    items.push(item)
  }
  return items
}

/** Total character count of a normalized brief. */
function totalLength(brief) {
  let total = textLength(brief.goal) + textLength(brief.why ?? '') + textLength(brief.nextAction)
  for (const key of ['confirmed', 'constraints', 'leads', 'openQuestions']) {
    for (const item of brief[key] ?? []) total += textLength(item.text)
  }
  return total
}

/**
 * Normalize one untrusted `brief` object.
 *
 * @param raw - the tool/API payload.
 * @returns `{ brief, errors, warnings }`; `brief` is undefined when errors exist.
 */
export function normalizeBrief(raw) {
  const errors = []
  const warnings = []
  if (raw === undefined || raw === null) return { brief: undefined, errors, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { brief: undefined, errors: [error('todo/brief-invalid', 'brief must be an object')], warnings }
  }

  const goal = cleanLine(raw.goal)
  if (goal === '') errors.push(error('todo/brief-goal-required', 'brief.goal is required: what needs to be solved'))
  else if (textLength(goal) > BRIEF_LIMITS.goal) {
    errors.push(error('todo/brief-goal-too-long', `brief.goal must be at most ${BRIEF_LIMITS.goal} characters`))
  }

  const nextAction = cleanLine(raw.nextAction)
  if (nextAction === '') {
    errors.push(error('todo/brief-next-required', 'brief.nextAction is required: the first concrete action'))
  } else if (textLength(nextAction) > BRIEF_LIMITS.nextAction) {
    errors.push(
      error('todo/brief-next-too-long', `brief.nextAction must be at most ${BRIEF_LIMITS.nextAction} characters`),
    )
  }

  const why = cleanLine(raw.why)
  if (why !== '' && textLength(why) > BRIEF_LIMITS.why) {
    errors.push(error('todo/brief-why-too-long', `brief.why must be at most ${BRIEF_LIMITS.why} characters`))
  }

  const confirmed = normalizeItems(raw.confirmed, 'confirmed', BRIEF_LIMITS.confirmedItems, errors, warnings)
  const constraints = normalizeItems(raw.constraints, 'constraints', BRIEF_LIMITS.constraintsItems, errors, warnings)
  const leads = normalizeItems(raw.leads, 'leads', BRIEF_LIMITS.leadsItems, errors, warnings)
  const openQuestions = normalizeItems(raw.openQuestions, 'openQuestions', BRIEF_LIMITS.openQuestionsItems, errors, warnings)

  if (constraints.some((item) => item.basis === 'superseded')) {
    errors.push(
      error(
        'todo/brief-superseded-constraint',
        'constraints cannot contain a superseded item; record the replacement decision or move the old decision out of current constraints',
      ),
    )
  }
  if (errors.length > 0) return { brief: undefined, errors, warnings }

  const brief = {
    goal,
    ...(why === '' ? {} : { why }),
    confirmed,
    constraints,
    leads,
    nextAction,
    openQuestions,
  }
  if (confirmed.length === 0 && constraints.length === 0 && leads.length > 0 && openQuestions.length === 0) {
    return {
      brief: undefined,
      errors: [
        error(
          'todo/brief-source-only',
          'brief contains only leads/sources and no confirmed facts, constraints, or open question; add the task intelligence instead of a file/path list',
        ),
      ],
      warnings,
    }
  }
  const total = totalLength(brief)
  if (total > BRIEF_LIMITS.totalHard) {
    return {
      brief: undefined,
      errors: [
        error(
          'todo/brief-too-long',
          `brief is ${total} characters (hard limit ${BRIEF_LIMITS.totalHard}); keep only what a later session cannot rediscover`,
        ),
      ],
      warnings,
    }
  }
  if (total > BRIEF_LIMITS.totalSoft) {
    warnings.push(`brief is ${total} characters (soft limit ${BRIEF_LIMITS.totalSoft}); consider trimming non-essential detail`)
  }
  if (why !== '' && why === goal) warnings.push('brief.why repeats brief.goal; either drop why or make it add context')
  return { brief, errors: [], warnings }
}

/** Map a legacy `mustRead[].basis` value onto a `BriefBasis`. */
function legacyBasis(value) {
  switch (value) {
    case 'confirmed':
      return 'verified'
    case 'decided':
      return 'decided'
    case 'inferred':
      return 'inferred'
    case 'unverified':
      return 'unknown'
    default:
      return 'unknown'
  }
}

/**
 * Derive a read-only brief for a card that predates `brief`.
 *
 * This never invents a confirmed fact: legacy must-read items with no basis
 * become `unknown`, and touched files become `unknown` leads. It is a migration
 * view, not a stored record.
 */
function deriveBrief(record) {
  const core = record?.core ?? {}
  const goal = cleanLine(core.symptom) || cleanLine(core.intent) || cleanLine(record?.title) || ''
  const why = cleanLine(core.symptom) !== '' && cleanLine(core.intent) !== '' ? cleanLine(core.intent) : ''
  const confirmed = []
  for (const item of Array.isArray(record?.mustRead) ? record.mustRead : []) {
    const label = cleanLine(item?.label)
    const text = cleanLine(item?.text)
    if (text === '') continue
    const itemText = label === '' ? text : `${label}: ${text}`
    const briefItem = { text: itemText, basis: legacyBasis(item?.basis) }
    if (Array.isArray(item?.sourceIds) && item.sourceIds.length > 0) {
      briefItem.sourceIds = [...new Set(item.sourceIds.map((value) => cleanLine(value)).filter(Boolean))].slice(
        0,
        BRIEF_LIMITS.sourceIdsPerItem,
      )
    }
    confirmed.push(briefItem)
  }
  const cause = cleanLine(core.cause)
  if (cause !== '' && !confirmed.some((item) => item.text === cause)) {
    confirmed.push({ text: cause, basis: 'unknown' })
  }
  const leads = []
  for (const item of Array.isArray(record?.park) ? record.park : []) {
    const label = cleanLine(item?.label)
    const why = cleanLine(item?.why)
    const text = label === '' ? why : why === '' ? label : `${label} — ${why}`
    if (text !== '' && !leads.some((lead) => lead.text === text)) leads.push({ text, basis: 'unknown' })
  }
  for (const file of Array.isArray(record?.touchedFiles) ? record.touchedFiles : []) {
    const text = cleanLine(file)
    if (text === '') continue
    leads.push({ text, basis: 'unknown' })
    if (leads.length >= BRIEF_LIMITS.leadsItems) break
  }
  for (const symbol of Array.isArray(record?.code?.symbols) ? record.code.symbols : []) {
    if (leads.length >= BRIEF_LIMITS.leadsItems) break
    const text = `${cleanLine(symbol?.file)}${symbol?.symbol === undefined ? '' : `#${cleanLine(symbol.symbol)}`}`
    if (text !== '' && !leads.some((item) => item.text === text)) leads.push({ text, basis: 'unknown' })
  }
  return {
    goal,
    ...(why === '' ? {} : { why }),
    confirmed,
    constraints: [],
    leads,
    nextAction: cleanLine(core.nextStep),
    openQuestions: [],
  }
}

/**
 * The brief a projection should show: the stored brief when present, otherwise a
 * read-only derivation from legacy fields.
 *
 * @param record - stored card.
 * @returns `{ brief, source: 'stored'|'derived' }`.
 */
export function briefForRecord(record) {
  if (record?.brief !== undefined && record?.brief !== null) {
    return { brief: record.brief, source: 'stored' }
  }
  return { brief: deriveBrief(record), source: 'derived' }
}

/** Total length of a brief for quality checks. */
export function briefLength(brief) {
  return brief === undefined || brief === null ? 0 : totalLength(brief)
}

/**
 * Quality warnings for one brief. These are guidance for the model/developer,
 * not hard rejections: a simple task may legitimately have no confirmed facts
 * or constraints, but a brief made only of leads/sources is not a brief.
 *
 * @param brief - normalized or derived brief.
 * @param options - `source` is `stored` or `derived`.
 * @returns warning strings (possibly empty).
 */
export function briefQuality(brief, { source = 'stored' } = {}) {
  if (brief === undefined || brief === null) return ['no task brief: state the goal and the first action']
  const warnings = []
  if (source === 'derived') {
    warnings.push('brief was derived from legacy fields; add a stored brief when possible')
  }
  if (cleanLine(brief.goal) === '') warnings.push('brief has no goal: say what needs to be solved')
  if (cleanLine(brief.nextAction) === '') warnings.push('brief has no nextAction: say how to start')
  const confirmed = Array.isArray(brief.confirmed) ? brief.confirmed : []
  const constraints = Array.isArray(brief.constraints) ? brief.constraints : []
  const leads = Array.isArray(brief.leads) ? brief.leads : []
  if (confirmed.length === 0 && constraints.length === 0 && leads.length > 0) {
    warnings.push('brief contains only leads/sources and no confirmed facts or constraints; add the task intelligence or an open question')
  }
  if (confirmed.length > 0 && confirmed.every((item) => item?.basis === 'inferred' || item?.basis === 'unknown')) {
    warnings.push('brief has no confirmed/decided/verified item; do not present inferences or unknowns as facts')
  }
  const total = totalLength(brief)
  if (total > BRIEF_LIMITS.totalSoft) {
    warnings.push(`brief is ${total} characters (soft limit ${BRIEF_LIMITS.totalSoft}); consider trimming non-essential detail`)
  }
  if (cleanLine(brief.why) !== '' && cleanLine(brief.why) === cleanLine(brief.goal)) {
    warnings.push('brief.why repeats brief.goal; either drop why or make it add context')
  }
  return warnings
}
