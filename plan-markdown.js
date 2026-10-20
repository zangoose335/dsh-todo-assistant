/**
 * todo-assistant — deterministic Markdown plan import/export (PLAN.md §B3).
 *
 * Pure functions with no bare package imports: `parsePlanMarkdown` turns the
 * developer's own text into an editable preview (never storage), and
 * `renderPlanMarkdown` turns a stored project back into the same minimal
 * syntax. The API layer owns persistence and the confirmation gate.
 *
 * Minimal syntax (English and Chinese labels, half/full-width colon):
 *
 *   # Project name          → name
 *   first paragraph         → goal
 *   ## Phase 4: title       → root phase
 *   ### Phase 4a: title     → sub-phase
 *   Goal / 目标              inline text or bullets
 *   Acceptance / 验收        bullets
 *   Depends on / 依赖        bullets (phase number or title)
 *   Context / 上下文         bullets (must-keep)
 *   Decisions / 决策         bullets
 *   Risks / 风险             bullets (project level only)
 *   Next / 下一步            inline text or bullets
 *   Result / 结果            inline text (summary; export extension)
 *
 * Fenced code blocks are ignored. Lines that cannot be classified (tables,
 * stray paragraphs, unknown labels) are reported in `unclassified` and are
 * never stored: the developer sees them in the preview, and a commit drops
 * them instead of silently folding them into the plan.
 */
import { PLAN_LIMITS, TodoInputError } from './domain.js'

/** Section labels accepted in the Markdown (lower-cased English + Chinese). */
const LABEL_KEYS = new Map([
  ['goal', 'goal'],
  ['目标', 'goal'],
  ['acceptance', 'acceptance'],
  ['验收', 'acceptance'],
  ['depends on', 'depends'],
  ['depends', 'depends'],
  ['依赖', 'depends'],
  ['context', 'context'],
  ['上下文', 'context'],
  ['decisions', 'decisions'],
  ['决策', 'decisions'],
  ['risks', 'risks'],
  ['风险', 'risks'],
  ['next', 'next'],
  ['下一步', 'next'],
  ['result', 'result'],
  ['结果', 'result'],
])

/** Labels whose content is a list of items. */
const LIST_LABELS = new Set(['acceptance', 'depends', 'context', 'decisions', 'risks'])
/** Labels whose content is one text value. */
const SINGLE_LABELS = new Set(['goal', 'next', 'result'])
/** Labels a project-level section may carry (the project has no other fields). */
const PROJECT_LABELS = new Set(['goal', 'decisions', 'risks'])

/** `Phase 4: title`, `阶段 A1：title`, `4. title`, `B2 title`. */
const PHASE_HEADING = /^(?:(?:Phase|阶段)\s*)?(\d+[a-zA-Z]*|[A-Za-z]{1,3}[0-9]*)\s*(?:[:：.、-]\s*)?(.*)$/u
/** One section label line. */
const LABEL_LINE = /^([A-Za-z][A-Za-z ]{0,20}|[\u4e00-\u9fff]{1,10})\s*[:：]\s*(.*)$/u
/** One Markdown bullet. */
const BULLET_LINE = /^\s*[-*+]\s+(.*)$/u

/** Collapse whitespace so one value stays on one line. */
function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

/** Child display number: a numeric parent gets letters (2 → 2a), a letter parent digits (A → A1). */
function childNumberOf(parentNumber, index) {
  return /^[A-Za-z]+$/u.test(parentNumber) ? `${parentNumber}${index + 1}` : `${parentNumber}${splitLetter(index)}`
}

/** Split suffix for auto-numbered sub-phases: a, b, …, z, aa, ab, … */
function splitLetter(index) {
  let value = ''
  let current = index
  do {
    value = String.fromCharCode(97 + (current % 26)) + value
    current = Math.floor(current / 26) - 1
  } while (current >= 0)
  return value
}

/** Parse one phase heading; `undefined` when it carries no display number. */
function parsePhaseHeading(text) {
  const match = PHASE_HEADING.exec(text.trim())
  if (match === null) return undefined
  return { number: match[1], title: match[2].trim() }
}

/** Turn preview strings (or already-shaped items) into stored evidence refs. */
function toEvidence(value, label) {
  const items = Array.isArray(value) ? value : []
  return items
    .map((item) => oneLine(typeof item === 'string' ? item : item?.text))
    .filter((text) => text !== '')
    .map((text) => ({ label, text, basis: 'decided' }))
}

/**
 * Parse a Markdown plan into an editable preview. Nothing is stored; every
 * guess (a dependency binding, an auto-generated sub-phase number) is listed in
 * `preview.inferred` so the caller can require confirmation.
 *
 * @param text - the developer's Markdown/text plan.
 * @param options - `limits` override.
 * @returns the preview.
 * @throws {TodoInputError} with a `plan/import-*` code for unusable input.
 */
export function parsePlanMarkdown(text, { limits = PLAN_LIMITS } = {}) {
  if (typeof text !== 'string') throw new TodoInputError('plan/import-empty', '导入文本不能为空')
  const raw = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (raw.trim() === '') throw new TodoInputError('plan/import-empty', '导入文本不能为空')
  if ([...raw].length > limits.importText) {
    throw new TodoInputError('plan/import-text-too-long', `导入文本最多 ${limits.importText} 个字符（当前 ${[...raw].length}）`)
  }

  const lines = raw.split('\n')
  const warnings = []
  const unclassified = []
  const inferred = []
  const phases = []
  const byNumber = new Map()
  let name = ''
  let goalLines = []
  let goalSealed = false
  let collectingGoal = false
  let goalOverride = false
  let current = null
  let lastRoot = ''
  let section = null
  let inFence = false
  let fenceMarker = ''
  let unclassifiedTruncated = false

  const projectDecisions = []
  const projectRisks = []

  const addUnclassified = (line, text) => {
    if (unclassified.length >= limits.importUnclassified) {
      if (!unclassifiedTruncated) {
        unclassifiedTruncated = true
        warnings.push(`未归类内容超过 ${limits.importUnclassified} 条，其余未列出（保存时都不会写入）`)
      }
      return
    }
    unclassified.push({ line, text: text.trim() })
  }

  const pushPhase = (phase) => {
    if (byNumber.has(phase.number)) {
      const first = byNumber.get(phase.number)
      throw new TodoInputError(
        'plan/import-duplicate-number',
        `展示号 ${phase.number} 重复（第 ${first.line} 行与第 ${phase.line} 行）；计划内展示号必须唯一`,
      )
    }
    if (phases.length >= limits.phases) {
      throw new TodoInputError('plan/too-many-phases', `预览最多 ${limits.phases} 个阶段`)
    }
    byNumber.set(phase.number, phase)
    phases.push(phase)
  }

  const sectionHasValue = (target) => {
    if (target === null) return false
    if (target.scope === 'project') return target.key === 'goal' && goalLines.length > 0
    if (current === null) return false
    if (target.key === 'goal') return current.goal !== ''
    if (target.key === 'next') return current.nextStep !== ''
    if (target.key === 'result') return current.resultSummary !== ''
    return false
  }

  const applyValue = (scope, key, value, line) => {
    const text = value.trim()
    if (text === '') return
    if (scope === 'project') {
      if (key === 'goal') {
        if (!goalOverride && goalLines.length > 0) {
          warnings.push(`第 ${line} 行：Goal 段落覆盖了前面的首段`)
        }
        goalOverride = true
        goalLines.push(text)
        return
      }
      if (key === 'decisions') projectDecisions.push(text)
      if (key === 'risks') projectRisks.push(text)
      return
    }
    if (current === null) return
    if (key === 'goal') current.goal = oneLine([current.goal, text].filter(Boolean).join(' '))
    else if (key === 'next') current.nextStep = oneLine([current.nextStep, text].filter(Boolean).join(' '))
    else if (key === 'result') current.resultSummary = oneLine([current.resultSummary, text].filter(Boolean).join(' '))
    else if (key === 'acceptance') current.acceptance.push(text)
    else if (key === 'context') current.mustKeep.push(text)
    else if (key === 'decisions') current.decisions.push(text)
    else if (key === 'depends') current.dependsOnItems.push({ text, line })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    const line = lines[index]
    const fence = /^\s*(```|~~~)/u.exec(line)
    if (fence !== null) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
        section = null
      } else if (fence[1] === fenceMarker) {
        inFence = false
        fenceMarker = ''
      }
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (trimmed === '') {
      if (collectingGoal) {
        goalSealed = true
        collectingGoal = false
      }
      // A blank after a filled single-value section ends it, so a following
      // table/paragraph is unclassified instead of being swallowed. Lists and
      // empty sections survive a blank ("Acceptance:" then a blank then bullets).
      if (section !== null && SINGLE_LABELS.has(section.key) && sectionHasValue(section)) section = null
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      const title = heading[2].trim()
      collectingGoal = false
      section = null
      if (level === 1) {
        if (name === '') name = title
        else addUnclassified(lineNo, line)
        current = null
        lastRoot = ''
        continue
      }
      goalSealed = true
      if (level === 2 || level === 3) {
        const parsed = parsePhaseHeading(title)
        if (parsed === undefined) {
          addUnclassified(lineNo, line)
          warnings.push(`第 ${lineNo} 行：无法识别的标题「${title}」，已列为未归类`)
          continue
        }
        if (parsed.title === '') {
          throw new TodoInputError('plan/import-phase-title-required', `第 ${lineNo} 行：阶段 ${parsed.number} 缺少标题`)
        }
        if (level === 3) {
          if (lastRoot === '') {
            throw new TodoInputError('plan/import-orphan-subphase', `第 ${lineNo} 行：子阶段出现在任何根阶段之前`)
          }
          let number = parsed.number
          if (/^\d+$/u.test(number) || /^[A-Za-z]+$/u.test(number)) {
            const used = new Set(phases.map((phase) => phase.number))
            let index = 0
            let candidate = childNumberOf(lastRoot, index)
            while (used.has(candidate) && index < 1000) {
              index += 1
              candidate = childNumberOf(lastRoot, index)
            }
            number = candidate
            inferred.push({ kind: 'number', phase: number, line: lineNo, text: parsed.title, resolved: true })
          }
          const phase = {
            number,
            title: parsed.title,
            goal: '',
            nextStep: '',
            parentNumber: lastRoot,
            acceptance: [],
            mustKeep: [],
            decisions: [],
            dependsOnItems: [],
            resultSummary: '',
            line: lineNo,
          }
          pushPhase(phase)
          current = phase
        } else {
          const phase = {
            number: parsed.number,
            title: parsed.title,
            goal: '',
            nextStep: '',
            acceptance: [],
            mustKeep: [],
            decisions: [],
            dependsOnItems: [],
            resultSummary: '',
            line: lineNo,
          }
          pushPhase(phase)
          current = phase
          lastRoot = parsed.number
        }
        continue
      }
      addUnclassified(lineNo, line)
      continue
    }

    const label = LABEL_LINE.exec(trimmed)
    if (label !== null) {
      const key = LABEL_KEYS.get(label[1].trim().toLowerCase())
      if (key === undefined) {
        addUnclassified(lineNo, line)
        continue
      }
      const scope = current === null ? 'project' : 'phase'
      if (scope === 'project' && !PROJECT_LABELS.has(key)) {
        addUnclassified(lineNo, line)
        warnings.push(`第 ${lineNo} 行：项目级不支持 ${label[1].trim()}，已列为未归类`)
        continue
      }
      if (scope === 'phase' && key === 'risks') {
        addUnclassified(lineNo, line)
        warnings.push(`第 ${lineNo} 行：阶段级 Risks 没有存储字段，已列为未归类`)
        continue
      }
      collectingGoal = false
      goalSealed = true
      section = { scope, key }
      const rest = label[2].trim()
      if (rest !== '') applyValue(scope, key, rest, lineNo)
      continue
    }

    const bullet = BULLET_LINE.exec(line)
    if (bullet !== null) {
      if (section === null) {
        addUnclassified(lineNo, line)
        continue
      }
      const text = bullet[1].trim()
      if (text !== '') applyValue(section.scope, section.key, text, lineNo)
      continue
    }

    if (section !== null) {
      if (SINGLE_LABELS.has(section.key)) {
        applyValue(section.scope, section.key, trimmed, lineNo)
        continue
      }
      addUnclassified(lineNo, line)
      continue
    }

    if (current === null && !goalSealed) {
      goalLines.push(trimmed)
      collectingGoal = true
      continue
    }
    addUnclassified(lineNo, line)
  }

  if (oneLine(name) === '') throw new TodoInputError('plan/import-title-required', '导入文本缺少一级标题（# 项目名）')
  const resolvePhaseRef = (rawRef) => {
    const ref = oneLine(rawRef).replace(/^#/u, '').replace(/^(?:Phase|阶段)\s*/iu, '').trim()
    if (ref === '') return undefined
    if (byNumber.has(ref)) return ref
    const lower = ref.toLowerCase()
    const number = [...byNumber.keys()].find((candidate) => candidate.toLowerCase() === lower)
    if (number !== undefined) return number
    const byTitle = phases.find((phase) => {
      const title = oneLine(phase.title)
      return title === ref || title.toLowerCase() === lower
    })
    return byTitle?.number
  }
  for (const phase of phases) {
    for (const item of phase.dependsOnItems) {
      const target = resolvePhaseRef(item.text)
      inferred.push({
        kind: 'dependency',
        phase: phase.number,
        line: item.line,
        text: item.text,
        resolved: target !== undefined,
        ...(target === undefined ? {} : { target }),
      })
    }
  }
  const goal = oneLine(goalLines.join(' '))
  if (goal === '') warnings.push('没有找到项目目标段落：goal 为空，保存前请补上')
  if (phases.length === 0) warnings.push('没有识别到阶段：保存后将是一个没有阶段的空计划')

  return {
    name: oneLine(name),
    goal,
    decisions: projectDecisions,
    risks: projectRisks,
    phases: phases.map((phase) => ({
      number: phase.number,
      title: phase.title,
      goal: phase.goal,
      nextStep: phase.nextStep,
      ...(phase.parentNumber === undefined ? {} : { parentNumber: phase.parentNumber }),
      acceptance: phase.acceptance,
      mustKeep: phase.mustKeep,
      decisions: phase.decisions,
      dependsOn: phase.dependsOnItems.map((item) => item.text),
      resultSummary: phase.resultSummary,
      line: phase.line,
    })),
    inferred,
    unclassified,
    warnings,
    stats: {
      lines: lines.length,
      phases: phases.length,
      roots: phases.filter((phase) => phase.parentNumber === undefined).length,
      unclassified: unclassified.length,
      inferred: inferred.length,
    },
  }
}

/**
 * Validate an (editable) import preview and turn it into the project-create
 * input: stable pids, dependency refs bound to pids, evidence wrapped with its
 * section label, `unclassified` dropped. Inferred items are *not* gated here —
 * the API checks `confirmedInferred` first — but an unresolvable dependency or
 * parent always rejects, because silently dropping a stated edge is worse than
 * failing the import.
 *
 * @param preview - the preview returned by {@link parsePlanMarkdown}, possibly edited.
 * @param options - pid allocator, clock, limits.
 * @returns input for `store.createProject`.
 * @throws {TodoInputError} with a `plan/import-*` code.
 */
export function importPreviewToProjectInput(preview, { phaseId, at, limits = PLAN_LIMITS } = {}) {
  if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new TodoInputError('plan/import-preview-required', 'preview 必须是 plan.import.preview 的结果')
  }
  if (typeof phaseId !== 'function') throw new Error('phaseId allocator is required')
  const name = oneLine(preview.name)
  if (name === '') throw new TodoInputError('plan/import-title-required', 'preview.name 不能为空')
  const goal = oneLine(preview.goal)
  const phases = Array.isArray(preview.phases) ? preview.phases : []
  if (phases.length > limits.phases) {
    throw new TodoInputError('plan/too-many-phases', `预览最多 ${limits.phases} 个阶段（当前 ${phases.length}）`)
  }

  const byNumber = new Map()
  for (const phase of phases) {
    if (phase === null || typeof phase !== 'object' || Array.isArray(phase)) {
      throw new TodoInputError('plan/import-invalid-preview', 'preview.phases 的每一项都必须是对象')
    }
    const number = oneLine(phase.number)
    if (number === '' || oneLine(phase.title) === '') {
      throw new TodoInputError('plan/import-invalid-preview', '每个阶段都需要 number 和 title')
    }
    if (byNumber.has(number)) {
      throw new TodoInputError('plan/import-duplicate-number', `展示号 ${number} 重复；计划内展示号必须唯一`)
    }
    byNumber.set(number, phase)
  }

  // First pass: assign one pid per phase, so dependency refs can bind to them.
  const assigned = phases.map((phase) => ({ phase, number: oneLine(phase.number), pid: phaseId() }))
  const pidByNumber = new Map(assigned.map((entry) => [entry.number, entry.pid]))

  const resolveTarget = (rawRef) => {
    const ref = oneLine(rawRef).replace(/^#/u, '').replace(/^(?:Phase|阶段)\s*/iu, '').trim()
    if (ref === '') return undefined
    if (pidByNumber.has(ref)) return ref
    const lower = ref.toLowerCase()
    const number = [...pidByNumber.keys()].find((candidate) => candidate.toLowerCase() === lower)
    if (number !== undefined) return number
    const byTitle = [...byNumber.entries()].find(([, phase]) => {
      const title = oneLine(phase.title)
      return title === ref || title.toLowerCase() === lower
    })
    return byTitle?.[0]
  }

  const built = assigned.map(({ phase, number, pid }) => {
    const dependsOn = []
    for (const rawRef of Array.isArray(phase.dependsOn) ? phase.dependsOn : []) {
      const target = resolveTarget(rawRef)
      if (target === undefined) {
        throw new TodoInputError(
          'plan/import-unresolved-dependency',
          `阶段 ${number} 的依赖「${oneLine(rawRef)}」找不到对应阶段；请改成阶段编号或标题`,
        )
      }
      const targetPid = pidByNumber.get(target)
      if (!dependsOn.includes(targetPid)) dependsOn.push(targetPid)
    }
    let parentPid
    if (phase.parentNumber !== undefined && phase.parentNumber !== null && oneLine(phase.parentNumber) !== '') {
      const parentNumber = oneLine(phase.parentNumber)
      const parent = pidByNumber.has(parentNumber)
        ? parentNumber
        : [...pidByNumber.keys()].find((candidate) => candidate.toLowerCase() === parentNumber.toLowerCase())
      if (parent === undefined) {
        throw new TodoInputError('plan/import-unresolved-parent', `阶段 ${number} 的父阶段 ${parentNumber} 找不到`)
      }
      parentPid = pidByNumber.get(parent)
    }
    const resultSummary = oneLine(phase.resultSummary)
    return {
      pid,
      number,
      title: oneLine(phase.title),
      goal: oneLine(phase.goal),
      nextStep: oneLine(phase.nextStep),
      status: 'pending',
      ...(parentPid === undefined ? {} : { parentPid }),
      dependsOn,
      acceptance: toEvidence(phase.acceptance, 'acceptance'),
      mustKeep: toEvidence(phase.mustKeep, 'context'),
      decisions: toEvidence(phase.decisions, 'decision'),
      sources: [],
      notes: [],
      ...(resultSummary === ''
        ? {}
        : { result: { summary: resultSummary, verification: 'claimed', recordedAt: at, recordedBySession: '' } }),
      createdAt: at,
      updatedAt: at,
    }
  })

  return {
    name,
    goal,
    status: 'active',
    phases: built,
    decisions: toEvidence(preview.decisions, 'decision'),
    risks: toEvidence(preview.risks, 'risk'),
    sources: [],
  }
}

/**
 * Render a stored project back into the minimal syntax. Phases are emitted
 * parent-first (children directly after their parent) so the output parses
 * again; result summaries are included, test evidence and notes are not
 * representable in this syntax.
 *
 * @param project - a full project projection (`projectPlanFull`).
 * @returns the Markdown text.
 */
export function renderPlanMarkdown(project) {
  const phases = Array.isArray(project?.phases) ? project.phases : []
  const children = new Map()
  const roots = []
  for (const phase of phases) {
    if (phase.parentPid === undefined || phase.parentPid === null) {
      roots.push(phase)
    } else {
      const list = children.get(phase.parentPid) ?? []
      list.push(phase)
      children.set(phase.parentPid, list)
    }
  }
  const ordered = []
  const visit = (phase, level) => {
    ordered.push({ phase, level })
    for (const child of children.get(phase.pid) ?? []) visit(child, Math.min(level + 1, 6))
  }
  for (const root of roots) visit(root, 2)

  const lines = [`# ${oneLine(project?.name)}`, '']
  const goal = oneLine(project?.goal)
  if (goal !== '') lines.push(goal, '')

  const projectDecisions = (project?.decisions ?? []).map((item) => oneLine(item.text)).filter(Boolean)
  if (projectDecisions.length > 0) {
    lines.push('Decisions:', ...projectDecisions.map((text) => `- ${text}`), '')
  }
  const projectRisks = (project?.risks ?? []).map((item) => oneLine(item.text)).filter(Boolean)
  if (projectRisks.length > 0) {
    lines.push('Risks:', ...projectRisks.map((text) => `- ${text}`), '')
  }

  const byPid = new Map(phases.map((phase) => [phase.pid, phase]))
  for (const { phase, level } of ordered) {
    lines.push(`${'#'.repeat(level)} Phase ${phase.number}: ${oneLine(phase.title)}`, '')
    const phaseGoal = oneLine(phase.goal)
    if (phaseGoal !== '') lines.push(`Goal: ${phaseGoal}`)
    const nextStep = oneLine(phase.nextStep)
    if (nextStep !== '') lines.push(`Next: ${nextStep}`)
    const deps = (phase.dependsOn ?? [])
      .map((pid) => oneLine(byPid.get(pid)?.number ?? ''))
      .filter((number) => number !== '')
    if (deps.length > 0) lines.push('Depends on:', ...deps.map((number) => `- ${number}`))
    const sections = [
      ['Acceptance', phase.acceptance],
      ['Context', phase.mustKeep],
      ['Decisions', phase.decisions],
    ]
    for (const [label, items] of sections) {
      const texts = (items ?? []).map((item) => oneLine(item.text)).filter(Boolean)
      if (texts.length > 0) lines.push(`${label}:`, ...texts.map((text) => `- ${text}`))
    }
    const result = oneLine(phase.result?.summary)
    if (result !== '') lines.push(`Result: ${result}`)
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`
}
