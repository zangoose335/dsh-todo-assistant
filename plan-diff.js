/**
 * todo-assistant — structured plan diff and affected-phase analysis (PLAN.md §C2).
 *
 * The AI may explain why a change is needed, but the host computes what changed
 * and which phases it touches. These functions are pure so the verification
 * harness can drive them without storage.
 */

/** Project fields compared directly (currentPhaseId is rendered as a number). */
const PROJECT_FIELDS = ['name', 'goal', 'status', 'currentPhaseId']

/** A phase field compared directly, in display order. */
const PHASE_FIELDS = ['number', 'title', 'goal', 'status', 'parentPid', 'nextStep']

/** Evidence sections compared by text. */
const EVIDENCE_FIELDS = ['acceptance', 'mustKeep', 'decisions']

/** Stable JSON comparison for values that may be objects. */
function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/** Unique, non-empty evidence texts in their stored order. */
function textsOf(list) {
  const seen = new Set()
  const values = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = typeof item?.text === 'string' ? item.text : ''
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    values.push(text)
  }
  return values
}

/** A stable key for one source pointer. */
function sourceKey(source) {
  return JSON.stringify([source?.sid ?? '', source?.kind ?? '', source?.where ?? null])
}

/** A compact source label for the diff. */
function sourceLabel(source) {
  const where = source?.where?.file ?? source?.where?.sessionId ?? ''
  return `${source?.sid ?? ''}${where === '' ? '' : ` ${where}`}`
}

/** Display number of one phase pid, or the pid when it is gone. */
function numberFor(project, pid) {
  const phase = (project?.phases ?? []).find((entry) => entry.pid === pid)
  return phase === undefined ? String(pid) : phase.number
}

/** Added and removed values of one text list. */
function textDelta(before, after) {
  const left = textsOf(before)
  const right = textsOf(after)
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return {
    added: right.filter((text) => !leftSet.has(text)),
    removed: left.filter((text) => !rightSet.has(text)),
  }
}

/** Diff two project snapshots. */
export function diffPlans(before, after) {
  const project = []
  for (const field of PROJECT_FIELDS) {
    const left = field === 'currentPhaseId' ? before?.currentPhaseId : before?.[field]
    const right = field === 'currentPhaseId' ? after?.currentPhaseId : after?.[field]
    if (same(left, right)) continue
    project.push({
      field,
      before: field === 'currentPhaseId' && left !== undefined ? numberFor(before, left) : (left ?? null),
      after: field === 'currentPhaseId' && right !== undefined ? numberFor(after, right) : (right ?? null),
    })
  }

  const beforePhases = new Map((before?.phases ?? []).map((phase) => [phase.pid, phase]))
  const afterPhases = new Map((after?.phases ?? []).map((phase) => [phase.pid, phase]))
  const added = []
  const removed = []
  const modified = []
  const dependencies = []
  const acceptance = []

  for (const phase of after?.phases ?? []) {
    if (!beforePhases.has(phase.pid)) {
      added.push({
        pid: phase.pid,
        number: phase.number,
        title: phase.title,
        ...(phase.parentPid === undefined ? {} : { parent: numberFor(after, phase.parentPid) }),
      })
    }
  }
  for (const phase of before?.phases ?? []) {
    if (!afterPhases.has(phase.pid)) {
      removed.push({ pid: phase.pid, number: phase.number, title: phase.title })
    }
  }
  for (const phase of after?.phases ?? []) {
    const old = beforePhases.get(phase.pid)
    if (old === undefined) continue
    const fields = []
    for (const field of PHASE_FIELDS) {
      const left = field === 'parentPid' && old.parentPid !== undefined ? numberFor(before, old.parentPid) : old[field]
      const right =
        field === 'parentPid' && phase.parentPid !== undefined ? numberFor(after, phase.parentPid) : phase[field]
      if (same(left, right)) continue
      fields.push({ field, before: left ?? null, after: right ?? null })
    }
    if (!same(old.result?.summary, phase.result?.summary) || old.result?.verification !== phase.result?.verification) {
      fields.push({
        field: 'result',
        before: old.result?.summary ?? null,
        after: phase.result?.summary ?? null,
        beforeVerification: old.result?.verification ?? null,
        afterVerification: phase.result?.verification ?? null,
      })
    }
    if (fields.length > 0) {
      modified.push({ pid: phase.pid, number: phase.number, title: phase.title, fields })
    }

    const oldDeps = new Set((old.dependsOn ?? []).map((pid) => numberFor(before, pid)))
    const newDeps = new Set((phase.dependsOn ?? []).map((pid) => numberFor(after, pid)))
    const addedDeps = [...newDeps].filter((number) => !oldDeps.has(number))
    const removedDeps = [...oldDeps].filter((number) => !newDeps.has(number))
    if (addedDeps.length > 0 || removedDeps.length > 0) {
      dependencies.push({
        pid: phase.pid,
        number: phase.number,
        title: phase.title,
        added: addedDeps,
        removed: removedDeps,
      })
    }

    for (const field of EVIDENCE_FIELDS) {
      const delta = textDelta(old[field], phase[field])
      if (delta.added.length === 0 && delta.removed.length === 0) continue
      acceptance.push({ pid: phase.pid, number: phase.number, title: phase.title, field, ...delta })
    }
  }

  const decisions = textDelta(before?.decisions, after?.decisions)
  const risks = textDelta(before?.risks, after?.risks)
  const beforeSources = new Set((before?.sources ?? []).map(sourceKey))
  const afterSources = new Set((after?.sources ?? []).map(sourceKey))
  const sources = {
    added: (after?.sources ?? []).filter((source) => !beforeSources.has(sourceKey(source))).map(sourceLabel),
    removed: (before?.sources ?? []).filter((source) => !afterSources.has(sourceKey(source))).map(sourceLabel),
  }

  return {
    project,
    phases: { added, removed, modified },
    dependencies,
    acceptance,
    decisions,
    risks,
    sources,
  }
}

/** Whether one diff changes anything at all. */
export function diffIsEmpty(diff) {
  return (
    (diff?.project ?? []).length === 0 &&
    (diff?.phases?.added ?? []).length === 0 &&
    (diff?.phases?.removed ?? []).length === 0 &&
    (diff?.phases?.modified ?? []).length === 0 &&
    (diff?.dependencies ?? []).length === 0 &&
    (diff?.acceptance ?? []).length === 0 &&
    (diff?.decisions?.added ?? []).length === 0 &&
    (diff?.decisions?.removed ?? []).length === 0 &&
    (diff?.risks?.added ?? []).length === 0 &&
    (diff?.risks?.removed ?? []).length === 0 &&
    (diff?.sources?.added ?? []).length === 0 &&
    (diff?.sources?.removed ?? []).length === 0
  )
}

/** Pids whose own content changed (added, modified, dependency, acceptance). */
function changedPids(diff) {
  const pids = new Set()
  for (const phase of diff?.phases?.added ?? []) pids.add(phase.pid)
  for (const phase of diff?.phases?.modified ?? []) pids.add(phase.pid)
  for (const entry of diff?.dependencies ?? []) pids.add(entry.pid)
  for (const entry of diff?.acceptance ?? []) pids.add(entry.pid)
  return pids
}

/**
 * Phases touched by one change: the changed phases, every phase that
 * transitively depends on them, and phases sharing an acceptance / must-keep /
 * decision text with a changed phase. Removed phases are not returned.
 *
 * @param before - the project before the change.
 * @param after - the project after the change.
 * @param diff - the result of {@link diffPlans}.
 * @returns affected pids in the after-project's phase order.
 */
export function affectedPhaseIds(before, after, diff) {
  const seed = changedPids(diff)
  const phases = Array.isArray(after?.phases) ? after.phases : []
  const currentChanged = (diff?.project ?? []).some((entry) => entry.field === 'currentPhaseId')
  if (seed.size === 0 && !currentChanged) return []
  const dependents = new Map()
  for (const phase of phases) {
    for (const dependency of phase.dependsOn ?? []) {
      const bucket = dependents.get(dependency) ?? []
      bucket.push(phase.pid)
      dependents.set(dependency, bucket)
    }
  }
  const affected = new Set(seed)
  const queue = [...seed]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const dependent of dependents.get(pid) ?? []) {
      if (affected.has(dependent)) continue
      affected.add(dependent)
      queue.push(dependent)
    }
  }

  const shared = new Set()
  const changedTexts = new Set()
  for (const pid of seed) {
    const phase = phases.find((entry) => entry.pid === pid)
    if (phase === undefined) continue
    for (const field of EVIDENCE_FIELDS) for (const text of textsOf(phase[field])) changedTexts.add(text)
  }
  if (changedTexts.size > 0) {
    for (const phase of phases) {
      if (affected.has(phase.pid)) continue
      const texts = EVIDENCE_FIELDS.flatMap((field) => textsOf(phase[field]))
      if (texts.some((text) => changedTexts.has(text))) {
        shared.add(phase.pid)
        affected.add(phase.pid)
      }
    }
  }

  if (after?.currentPhaseId !== undefined && diff?.project?.some((entry) => entry.field === 'currentPhaseId')) {
    affected.add(after.currentPhaseId)
  }

  return phases.map((phase) => phase.pid).filter((pid) => affected.has(pid))
}
