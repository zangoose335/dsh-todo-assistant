/**
 * todo-assistant — the `todo_add` capture tool (DESIGN.md §5.1, §3.6).
 *
 * The tool is a form, not a free-writing interface: its parameters and its
 * description carry the constraints that make the model *select* material
 * instead of summarizing it. The handler validates every limit again and
 * rejects with a code the model can act on.
 *
 * `defineTool` is injected so this module stays free of bare package imports and
 * the offline harness can build the same definition against a real store.
 */
import { findDuplicate } from './dedupe.js'
import { filesFromToolCall } from './detect.js'
import { BRIEF_BASES, BRIEF_IMPACTS, BRIEF_LIMITS } from './brief.js'
import { CAPTURE_LIMITS, STATUSES, TodoInputError, assembleCapture, labelOf, mintId, normalizeTouchedPath, projectFull } from './domain.js'
import { extractTodoBlocks } from './marker.js'

/** Wire name of the tool. */
export const TOOL_NAME = 'todo_add'

/**
 * The model-facing description. Three things must survive any edit here:
 * consent first, only this todo's material, and never read back on its own.
 */
export const TOOL_DESCRIPTION = [
  'Record one side task found while working on the main task, as a card the developer handles in a later session.',
  'Call it ONLY after the developer explicitly agreed to record this task. Report what you found and ask first; never add cards on your own initiative.',
  'Write only what belongs to this todo. Leave out everything about the main task; unrelated findings pollute later work.',
  'This is a form, not a summary: pick fields from what you already know. Do not restate the conversation.',
  'Use only content still visible in your context. If you believe earlier, compacted content matters, ask the developer whether to read it back first — never read it back on your own.',
  'Build a compact task brief from what is visible now: goal, why when it adds context, confirmed facts/decisions, constraints, leads, nextAction, and openQuestions. For a simple task, goal + nextAction are enough; omit why unless it adds real background, and leave confirmed, constraints, leads, and openQuestions empty unless they contain information beyond the goal itself.',
  'Do not copy goal or title into confirmed or mustRead. confirmed is only for facts/decisions beyond the goal; mustRead is only for material a later session must actually read, and an empty mustRead array is valid. Do not invent or restate content to make the brief look complete.',
  'Before adding a confirmed item, ask: if this item were removed, would a later reader lose information that is not already in goal, title, or another field? If not, omit it. A paraphrase of the goal is not a confirmed fact; statements such as "the todo is to buy milk tomorrow", "it is confirmed that we need to fix login", or "the task is X" must not be added. If the only known information is the requested todo, confirmed must be empty, even when the item would have basis requirement.',
  'nextAction may only describe the next action the request supports: turn the request into a concise action, but do not add reminders, suggestions, errands, or extra steps that were not asked for and are not necessary to complete the task.',
  'Every brief item must declare its basis: requirement (the developer asked for it), decided (the developer confirmed it), verified (a fact backed by evidence), inferred (your inference), unknown (not confirmed), or superseded (replaced by a later decision). Never write an inference or unknown as a confirmed fact/decision.',
  'Do not record only a title, next step, and file paths. If the task itself is unclear, ask the developer before capturing; if a missing answer blocks starting, put it in openQuestions with impact=blocking and ask the developer. Do not file a blocking gap as non-blocking or invent details; do not read history to complete the brief.',
  'Field semantics matter: put limits, rules, and decisions about what must or must not be done in brief.constraints, even when the developer already decided them; do not put constraints in confirmed. confirmed is only for task facts/decisions beyond the goal; never put a rule, check, or meta-constraint there.',
  'leads are file/symbol/doc pointers; give them basis verified or unknown, not requirement. requirement is for an ask or constraint, not for a file reference.',
  'If two confirmed decisions conflict and no resolution exists, keep both options visible in openQuestions with impact=blocking (or record both options as decided constraints plus a blocking question); never silently choose and never mark a blocking conflict non-blocking.',
  'Do not add extra verified items that merely restate a caution, rule, or "do not treat this as a fact" instruction. If a caveat is not an independently verifiable fact, omit it or use unknown/inferred with the correct basis.',
  'For an unmarked user message, set requestExcerpt to the exact sentence(s) that belong to this todo (never paraphrase), or to an empty string when the message is only a capture instruction or also contains unrelated tasks. If you omit it, the host keeps a single paragraph in full, but for multiple paragraphs it saves only the first paragraph (or nothing if that is only a capture instruction). For #DB/#MEMO messages leave requestExcerpt out; the host records the marked block in full.',
  'Determine intent before writing: if the developer explicitly asks to add/update an existing card, use todo_note on that card instead of todo_add; if they explicitly ask for a new card, use todo_add; if the intent is unclear, ask. If you recognize an existing card that may be the same, or todo_add reports a similar card, stop before todo_note or forceCreate: tell the developer which card it is and ask whether to append or create a new one. Knowing the card id is not permission to merge. A similarity signal is never permission to merge or cancel the request. Only after explicit confirmation may you retry todo_add with forceCreate=true; never set forceCreate on your own initiative.',
].join(' ')

/**
 * The number of the turn the caller is inside, or 0 when the log has no
 * `turn/start` yet (a capture that happened outside a turn).
 *
 * @param session - live session, when the caller has one.
 * @returns the turn number.
 */
export function currentTurn(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/start') return event.data.turn
    }
  } catch {
    // Fall through to the unknown-turn answer.
  }
  return 0
}

/**
 * Files this turn actually read/wrote/edited/searched. Only used to mark
 * already-mentioned paths as observed; never auto-added to a card.
 */
function observedFilesFor(session, cwd, turn) {
  const files = new Set()
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    let current = 0
    for (const event of events) {
      if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) current = event.data.turn
      if (event?.type !== 'tool/call') continue
      const eventTurn = Number.isInteger(event.data?.turn) ? event.data.turn : current
      if (Number.isInteger(turn) && turn > 0 && eventTurn !== turn) continue
      for (const file of filesFromToolCall(event.data?.name, event.data?.arguments, cwd)) files.add(file)
    }
  } catch {
    // A missing snapshot only means nothing is observed.
  }
  return files
}

/**
 * The developer's own words for this capture. A marked `#DB … #/db` message is
 * always recorded as its full extracted block. For an unmarked message the
 * model may pass an exact excerpt; `requestExcerpt: ''` means "this message has
 * nothing todo-specific to keep". Omitting it keeps the legacy full-message
 * fallback.
 *
 * @param session - the calling agent's live session.
 * @param now - clock.
 * @param store - optional card store, for multi-block turn assignment.
 * @param requestExcerpt - exact untagged-message excerpt, `''` for none.
 * @returns `{ request, warning? }`; request is undefined when nothing applies.
 */
function requestOf(session, now, store, requestExcerpt) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    let turn = 0
    let latest
    for (const event of events) {
      if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn
      if (event?.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'user') continue
      const parts = []
      for (const block of event.data?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      const text = parts.join('\n').trim()
      if (text !== '') latest = { text, turn, at: now(), messageId: typeof event.data?.id === 'string' ? event.data.id : undefined }
    }
    if (latest === undefined) return { request: undefined }
    const LIMIT = 8000
    const cap = (value) => {
      const chars = [...value]
      return chars.length > LIMIT ? { text: chars.slice(0, LIMIT).join(''), truncated: true } : { text: value }
    }

    // A `#DB … #/db` message: the request is that block alone (markers already
    // stripped by the extraction), one block per capture in message order.
    const blocks = extractTodoBlocks(latest.text)
    if (blocks.length > 0) {
      const used = new Set()
      if (store !== undefined) {
        for (const card of store.all()) {
          const request = card.request
          if (request === undefined || !Number.isInteger(request.block)) continue
          if (request.turn === latest.turn && request.messageId === latest.messageId) used.add(request.block)
        }
      }
      let block = 0
      for (let index = 0; index < blocks.length; index += 1) {
        if (!used.has(index)) {
          block = index
          break
        }
      }
      return { request: { ...latest, ...cap(blocks[block]), block } }
    }

    // Untagged: the model may select the exact todo-related excerpt. Empty means
    // explicitly no request (e.g. the user only said "record this" or put
    // unrelated tasks in the same message). A non-matching excerpt is not
    // quietly replaced with the whole message.
    if (typeof requestExcerpt === 'string') {
      const selected = requestExcerpt.trim()
      if (selected === '') return { request: undefined }
      const index = latest.text.indexOf(selected)
      if (index < 0) {
        return {
          request: undefined,
          warning: 'requestExcerpt did not exactly match the latest user message; no request text was stored',
        }
      }
      return { request: { ...latest, ...cap(latest.text.slice(index, index + selected.length)) } }
    }

    const fallback = fallbackRequestText(latest.text)
    return {
      request: fallback.text === undefined ? undefined : { ...latest, ...cap(fallback.text) },
      ...(fallback.warning === undefined ? {} : { warning: fallback.warning }),
    }
  } catch {
    return { request: undefined }
  }
}

/** Whether one paragraph is only a "create a todo" instruction, with no task content. */
function isOnlyCaptureInstruction(text) {
  const value = String(text ?? '').replace(/[\s。.!！?？]+$/gu, '').trim()
  if (value === '' || value.length > 80) return false
  if (/[,，;；:：]/u.test(value)) return false
  return /(?:创建|新建|建立|加|添加|记|记录|写入|放到|放进|存到).{0,40}(?:待办|卡片|todo)|(?:create|add|record|save|make).{0,40}(?:todo|card)/iu.test(value)
}

/**
 * Conservative fallback when the model did not pass requestExcerpt.
 * Single-paragraph messages keep the old full-text behavior. A multi-paragraph
 * message saves only its first paragraph, and omits the request entirely when
 * that paragraph is only a capture instruction. Precision belongs in
 * requestExcerpt; this fallback only prevents unrelated later tasks from being
 * silently attached.
 */
function fallbackRequestText(text) {
  const paragraphs = String(text ?? '')
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (paragraphs.length <= 1) return { text: String(text ?? '').trim() }
  if (isOnlyCaptureInstruction(paragraphs[0])) {
    return {
      text: undefined,
      warning: 'the user message has multiple paragraphs and its first paragraph is only a capture instruction; no request text was stored (pass requestExcerpt to keep a specific excerpt)',
    }
  }
  return {
    text: paragraphs[0],
    warning: 'the user message has multiple paragraphs; only the first paragraph was stored as request (pass requestExcerpt to choose a specific excerpt)',
  }
}

/** One task-brief item accepted from the model. */
function briefItemSchema(name) {
  return {
    type: 'object',
    additionalProperties: false,
    description: `One ${name} item. Say whether it is a requirement, decided, verified fact, inference, unknown, or superseded.`,
    properties: {
      text: { type: 'string', required: true, description: `One item, at most ${BRIEF_LIMITS.itemText} characters; not a summary of the conversation.` },
      basis: { type: 'string', required: true, enum: BRIEF_BASES, description: 'requirement | decided | verified | inferred | unknown | superseded' },
      sourceIds: { type: 'array', items: { type: 'string' }, description: 'Optional source refs when they already exist; do not read history to create them.' },
      impact: { type: 'string', enum: BRIEF_IMPACTS, description: 'blocking only for openQuestions that prevent starting work.' },
    },
  }
}

/** One evidence pointer accepted from the model. */
function whereSchema(includeOffset) {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Where this came from: a file you saw, and/or the session range.',
    properties: {
      file: { type: 'string', description: 'Repo-relative path.' },
      sessionId: { type: 'string', description: 'Session id when it is not the current one.' },
      seqRange: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Inclusive [from, to] session sequence numbers.',
      },
      ...(includeOffset ? { offset: { type: 'integer', description: 'Character offset inside the file.' } } : {}),
    },
  }
}

/**
 * Build the tool definition over one store.
 *
 * @param options - injected dependencies.
 * @param options.defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param options.store - the `todo-assistant` store.
 * @param options.now - clock override (tests).
 * @param options.readGit - resolves `{commit, branch, symbols}` for a cwd.
 * @param options.resolveWorkspace - maps a session cwd to a workspace key.
 * @returns the `ToolDefinition` to register on `ctx.tools`.
 */
export function createTodoAddTool({ defineTool, store, now = Date.now, readGit, resolveWorkspace, resolveRootSession }) {
  /** Derive the origin pointer from the live session, without storing the log. */
  function originOf(session, sessionId, cwd, at, rootSessionId) {
    let turn = 0
    let start = 0
    const next = session !== undefined && Number.isInteger(session.seq) ? session.seq : 0
    const end = Math.max(0, next - 1)
    try {
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'turn/start') {
          turn = event.data.turn
          start = event.seq
          break
        }
      }
    } catch {
      // A session that refuses the snapshot still gets a usable, if coarse, pointer.
    }
    return {
      sessionId,
      ...(typeof rootSessionId === 'string' && rootSessionId !== '' ? { rootSessionId } : {}),
      turn,
      seqRange: [start, Math.max(start, end)],
      cwd,
      at,
    }
  }

  return defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: `At most ${CAPTURE_LIMITS.title} characters. One line the developer recognizes a week later.`,
      },
      kind: {
        type: 'string',
        required: true,
        enum: ['defect', 'idea'],
        description: 'defect: something is broken; idea: something new worth doing.',
      },
      nextStep: {
        type: 'string',
        description: 'How to start: the fix to try (defect), or what to verify first (idea). Optional when brief.nextAction is supplied; otherwise required. This is the legacy mirror of brief.nextAction.',
      },
      touchedFiles: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Paths you actually saw involved; absolute paths are normalized to workspace-relative on write. Empty is allowed but makes later matching weaker.',
      },
      mustRead: {
        type: 'array',
        required: true,
        description: `At most ${CAPTURE_LIMITS.mustReadItems} items, each at most ${CAPTURE_LIMITS.mustReadText} characters: material a later session must actually read. Empty is valid; do not copy the goal or title here.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'One line naming the fact.' },
            text: { type: 'string', required: true, description: 'The fact itself, not a summary of the discussion.' },
            where: whereSchema(false),
            basis: { type: 'string', enum: BRIEF_BASES, description: 'Optional BriefBasis for this fact.' },
            sourceIds: { type: 'array', items: { type: 'string' }, description: 'Optional existing source sids for this fact.' },
          },
        },
      },
      brief: {
        type: 'object',
        additionalProperties: false,
        description: 'The task brief: what to solve, why, confirmed facts/decisions, constraints, leads, nextAction, and open questions. Simple tasks may contain only goal and nextAction. Optional for backward compatibility; new captures should include it.',
        properties: {
          goal: { type: 'string', required: true, description: `What to solve or implement, at most ${BRIEF_LIMITS.goal} characters.` },
          why: { type: 'string', description: `Why it matters, at most ${BRIEF_LIMITS.why} characters; omit when it adds nothing.` },
          confirmed: { type: 'array', description: `At most ${BRIEF_LIMITS.confirmedItems} confirmed task facts/decisions beyond the goal. Empty is valid when the only information is the todo itself. Never put a constraint, rule, or check here; use constraints. Never restate goal, title, or the request; if removing an item loses no independent information, omit it.`, items: briefItemSchema('confirmed') },
          constraints: { type: 'array', description: `At most ${BRIEF_LIMITS.constraintsItems} constraints that must not be violated. Put limits/rules and already-decided constraints here, not in confirmed.`, items: briefItemSchema('constraint') },
          leads: { type: 'array', description: `At most ${BRIEF_LIMITS.leadsItems} technical leads (files/symbols/docs); use basis verified or unknown, not requirement; leads are not the task brief.`, items: briefItemSchema('lead') },
          nextAction: { type: 'string', required: true, description: `The first concrete action, at most ${BRIEF_LIMITS.nextAction} characters. Describe only the action the request supports; do not add unrequested reminders, suggestions, errands, or extra scope.` },
          openQuestions: { type: 'array', description: `At most ${BRIEF_LIMITS.openQuestionsItems} unresolved questions that may affect execution. Use impact=blocking when the answer blocks starting, and ask the developer; do not mark a blocking conflict/gap non-blocking.`, items: briefItemSchema('open question') },
        },
      },
      requestExcerpt: {
        type: 'string',
        description: 'Optional for an unmarked user message: copy the exact sentence(s) that belong to this todo. Use an empty string when the message is only a capture instruction or contains unrelated tasks, so they are not saved as the developer request. If omitted, a single-paragraph message keeps the full text; a multi-paragraph message keeps only the first paragraph (or nothing if that is only a capture instruction). Ignored when the message has #DB/#MEMO blocks.',
      },
      forceCreate: {
        type: 'boolean',
        description: 'Set true only after the developer explicitly confirms creating a new card despite a reported similar card. Never set it on your own initiative.',
      },
      symptom: { type: 'string', description: 'What is observed (defect). One line.' },
      cause: { type: 'string', description: 'What you already know or suspect the cause is (defect).' },
      intent: { type: 'string', description: 'What the developer wants and why (idea).' },
      park: {
        type: 'array',
        description: 'References that exist but need not be read now. label ≤30, why ≤60 characters.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'What this is.' },
            why: { type: 'string', required: true, description: 'Why it might matter.' },
            where: whereSchema(true),
            basis: { type: 'string', enum: BRIEF_BASES, description: 'Optional BriefBasis for this pointer.' },
            sourceIds: { type: 'array', items: { type: 'string' }, description: 'Optional existing source sids for this pointer.' },
          },
        },
      },
      symbols: {
        type: 'array',
        description: 'Code coordinates you actually saw. The commit is added by the host.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string', required: true, description: 'Repo-relative path.' },
            symbol: { type: 'string', description: 'Function, class, or field name.' },
            line: { type: 'integer', description: 'Approximate line; a hint, never authority.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['created', 'duplicate'] },
          id: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['defect', 'idea'] },
          workspace: { type: 'string' },
          mustRead: { type: 'integer' },
          park: { type: 'integer' },
          brief: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
          label: { type: 'string' },
          candidateId: { type: 'string' },
          candidateTitle: { type: 'string' },
          candidateLabel: { type: 'string' },
          candidateStatus: { type: 'string' },
          similarity: { type: 'number' },
          titleSimilarity: { type: 'number' },
          goalSimilarity: { type: 'number' },
          whySimilarity: { type: 'number' },
          matchReason: { type: 'string' },
          sharedFiles: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.status === 'duplicate') {
          return [
            {
              type: 'text',
              text: [
                `Not recorded yet: #${value.candidateLabel ?? value.candidateId}「${value.candidateTitle}」 looks like the same card (${value.matchReason ?? 'shared file + similar title'}; similarity ${value.similarity}; shared file ${value.sharedFiles.join(', ')}).`,
                'This is a similarity signal, not a decision. Tell the developer which card it is and ask whether to (a) append with todo_note or (b) create a new card anyway. Only after they explicitly choose create, call todo_add again with forceCreate=true; append only after they choose merge.',
              ].join('\n'),
            },
          ]
        }
        const place = value.workspace === 'inbox' ? 'the inbox' : value.workspace.split('/').filter(Boolean).pop() ?? value.workspace
        const lines = [
          `Recorded #${value.label ?? value.id}「${value.title}」 as a ${value.kind} card in ${place} (${value.mustRead} must-read, ${value.park} parked).`,
        ]
        if (value.brief === false) lines.push('No task brief was stored; this card uses legacy fields only. New captures should include a brief with goal, nextAction, and the relevant confirmed facts/constraints.')
        for (const warning of value.warnings ?? []) lines.push(`Note: ${warning}`)
        lines.push('The developer can edit or delete it in the right sidebar; no further call is needed.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec !== undefined && exec !== null ? exec.agent : undefined
      const session = agent !== undefined && agent !== null ? agent.session : undefined
      if (agent === undefined || session === undefined) {
        throw new TodoInputError('todo/agent-required', 'todo_add needs an owning agent session')
      }
      const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : ''
      const workspace = await resolveWorkspace(cwd)

      // Dedupe on the normalized form the card will store, so a differently
      // written absolute path still matches.
      const duplicate = args?.forceCreate === true
        ? undefined
        : findDuplicate(store.all(), {
            workspace,
            title: args?.title,
            goal: args?.brief?.goal,
            why: args?.brief?.why,
            touchedFiles: Array.isArray(args?.touchedFiles)
              ? args.touchedFiles.map((file) => normalizeTouchedPath(file, workspace)).filter(Boolean)
              : [],
          })
      if (duplicate !== undefined) {
        return {
          status: 'duplicate',
          candidateId: duplicate.card.id,
          candidateTitle: duplicate.card.title,
          candidateLabel: labelOf(duplicate.card).label,
          candidateStatus: duplicate.card.status,
          similarity: duplicate.similarity,
          titleSimilarity: duplicate.titleSimilarity,
          goalSimilarity: duplicate.goalSimilarity,
          whySimilarity: duplicate.whySimilarity,
          matchReason: duplicate.matchReason,
          sharedFiles: duplicate.sharedFiles,
          workspace,
        }
      }

      const code = await readGit(cwd)
      const rootSessionId =
        typeof resolveRootSession === 'function'
          ? resolveRootSession(session)
          : typeof session.id === 'string'
            ? session.id
            : typeof agent.id === 'string'
              ? agent.id
              : ''
      const origin = originOf(session, agent.id, cwd, now(), rootSessionId)
      const requestResult = requestOf(session, now, store, args?.requestExcerpt)
      const observedFiles = observedFilesFor(session, cwd, origin.turn)
      const { record, warnings: captureWarnings } = assembleCapture(args, {
        now,
        nextId: () => mintId((id) => store.has(id)),
        origin,
        code,
        workspace,
        request: requestResult.request,
        observedFiles,
      })
      const warnings = requestResult.warning === undefined ? captureWarnings : [...captureWarnings, requestResult.warning]
      const stored = await store.put(record)
      return {
        status: 'created',
        id: stored.id,
        label: labelOf(stored).label,
        title: stored.title,
        kind: stored.kind,
        workspace: stored.workspace,
        mustRead: stored.mustRead.length,
        park: stored.park.length,
        brief: stored.brief !== undefined,
        warnings,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '记入待办',
      kind: 'other',
      rawInput: args,
    }),
  })
}

/**
 * `todo_read` — the L1/L2 reader. Its three shapes are the design's "先目录再正文":
 * the card itself, the appendix list, and one parked pointer.
 *
 * @param options - injected dependencies.
 * @returns the `todo_read` definition.
 */
export function createTodoReadTool({ defineTool, store }) {
  const find = (ref) => {
    const record = store.findRef(ref)
    if (record === undefined) throw new TodoInputError('todo/not-found', `no card #${ref} (pass the label like 3.2/#3.2, or the td_ id)`)
    return record
  }

  const sourceTag = (source) => {
    const tags = [source.kind]
    if (source.purpose !== undefined) tags.push(source.purpose)
    if (source.kind === 'file') tags.push(source.verified === true ? 'verified' : 'unverified')
    return tags.join(', ')
  }

  return defineTool({
    name: 'todo_read',
    description: [
      'Read one card: its task brief (goal, why, confirmed facts/decisions, constraints, leads, next action, open questions), then the few must-read facts, parked references, and code coordinates.',
      'Call it when the developer names a card (a short label like #3.2, or the td_ id) or asks you to work on one. Reading costs context, so read the card before the parked references, and only open a parked pointer when its label plus why suggests it is needed.',
      'Parked references are pointers, not content: their bodies are only reachable later through a read-back the developer approves.',
      "Sources are also pointers: read part='sources' for the list, or part='source:<sid>' for one pointer; never a body.",
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Card label like 3.2 or #3.2, or the td_ id.' },
      part: {
        type: 'string',
        description: "Omit for the card itself. 'notes' for notes; 'park:<n>' for one parked pointer; 'sources' for source pointers; 'source:<sid>' for one source.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shape: { type: 'string', required: true, enum: ['card', 'notes', 'park', 'sources', 'source'] },
          id: { type: 'string', required: true },
          label: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          kind: { type: 'string' },
          workspace: { type: 'string' },
          core: { type: 'json' },
          brief: { type: 'json' },
          briefSource: { type: 'string' },
          briefWarnings: { type: 'array', items: { type: 'string' } },
          mustRead: { type: 'json' },
          park: { type: 'json' },
          code: { type: 'json' },
          touchedFiles: { type: 'json' },
          notesCount: { type: 'integer' },
          notes: { type: 'json' },
          origin: { type: 'json' },
          request: { type: 'json' },
          sources: { type: 'json' },
          source: { type: 'json' },
          index: { type: 'integer' },
          pointer: { type: 'json' },
        },
      },
      render: (_args, value) => {
        if (value.shape === 'notes') {
          const lines = [`#${value.label ?? value.id}「${value.title}」 notes (${value.notesCount}):`]
          for (const [index, note] of (value.notes ?? []).entries()) {
            const tags = [note.basis, note.role, (note.sourceIds ?? []).length === 0 ? undefined : `sources ${note.sourceIds.join(', ')}`].filter(Boolean)
            lines.push(`${index + 1}. [${note.kind}] ${note.text}${tags.length === 0 ? '' : ` [${tags.join('; ')}]`}`)
          }
          if (lines.length === 1) lines.push('(none)')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.shape === 'park') {
          const pointer = value.pointer ?? {}
          const lines = [`#${value.label ?? value.id} parked ${value.index}: ${pointer.label ?? ''} — ${pointer.why ?? ''}`]
          if (pointer.where !== undefined) lines.push(`where: ${JSON.stringify(pointer.where)}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.shape === 'sources') {
          const sources = value.sources ?? []
          const lines = [`#${value.label ?? value.id}「${value.title}」 sources (${sources.length}):`]
          for (const source of sources) {
            lines.push(`${source.sid}\t[${sourceTag(source)}] ${source.label}${source.where === undefined ? '' : ` — ${JSON.stringify(source.where)}`}`)
          }
          if (lines.length === 1) lines.push('(none)')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.shape === 'source') {
          const source = value.source ?? {}
          const lines = [`#${value.label ?? value.id} source ${source.sid}: [${source.kind}] ${source.label}`]
          if (source.purpose !== undefined) lines.push(`purpose: ${source.purpose}`)
          if (source.where !== undefined) lines.push(`where: ${JSON.stringify(source.where)}`)
          if (source.turnRange !== undefined) lines.push(`turns: ${source.turnRange[0]}..${source.turnRange[1]}`)
          lines.push(`origin: ${source.origin}; verified: ${source.verified}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`#${value.label ?? value.id}「${value.title}」 ${value.status}/${value.kind} in ${value.workspace}`]
        if (value.request !== null && value.request !== undefined) {
          lines.push(`developer request (verbatim):`, value.request.text)
        }
        const brief = value.brief ?? null
        if (brief !== null) {
          lines.push('brief:')
          if (brief.goal !== undefined && brief.goal !== '') lines.push(`  goal: ${brief.goal}`)
          if (brief.why !== undefined && brief.why !== '') lines.push(`  why: ${brief.why}`)
          for (const key of ['confirmed', 'constraints', 'leads', 'openQuestions']) {
            for (const item of brief[key] ?? []) {
              const impact = item.impact === 'blocking' ? ' [blocking]' : ''
              lines.push(`  ${key}[${item.basis}]: ${item.text}${impact}`)
            }
          }
          if (brief.nextAction !== undefined && brief.nextAction !== '') lines.push(`  next action: ${brief.nextAction}`)
          if (value.briefSource === 'derived') lines.push('  (brief derived from legacy fields; add a stored brief when possible)')
          for (const warning of value.briefWarnings ?? []) lines.push(`  brief note: ${warning}`)
        }
        const core = value.core ?? {}
        if (brief === null) {
          if (core.symptom !== undefined) lines.push(`symptom: ${core.symptom}`)
          if (core.cause !== undefined) lines.push(`cause: ${core.cause}`)
          if (core.intent !== undefined) lines.push(`intent: ${core.intent}`)
          lines.push(`next: ${core.nextStep ?? ''}`)
        } else if (value.briefSource === 'derived') {
          if (core.cause !== undefined) lines.push(`cause (legacy): ${core.cause}`)
          if (core.intent !== undefined) lines.push(`intent (legacy): ${core.intent}`)
        }
        for (const [index, item] of (value.mustRead ?? []).entries()) {
          const observed = item.observed === true ? 'observed' : item.observed === false ? 'unverified' : undefined
          const tags = [item.basis, observed, (item.sourceIds ?? []).length === 0 ? undefined : `sources ${item.sourceIds.join(', ')}`].filter(Boolean)
          lines.push(`must-read ${index + 1}. ${item.label}: ${item.text}${tags.length === 0 ? '' : ` [${tags.join('; ')}]`}`)
        }
        for (const item of value.park ?? []) {
          const observed = item.observed === true ? 'observed' : item.observed === false ? 'unverified' : undefined
          const tags = [item.basis, observed, (item.sourceIds ?? []).length === 0 ? undefined : `sources ${item.sourceIds.join(', ')}`].filter(Boolean)
          lines.push(`parked: ${item.label} — ${item.why}${tags.length === 0 ? '' : ` [${tags.join('; ')}]`}`)
        }
        for (const source of value.sources ?? []) {
          lines.push(`source ${source.sid}: [${sourceTag(source)}] ${source.label}${source.where === undefined ? '' : ` — ${JSON.stringify(source.where)}`}`)
        }
        if ((value.touchedFiles ?? []).length > 0) lines.push(`files: ${value.touchedFiles.join(', ')}`)
        const code = value.code ?? {}
        if (code.commit !== undefined && code.commit !== '') lines.push(`commit: ${code.commit} (${code.branch || 'detached'})`)
        for (const symbol of code.symbols ?? []) lines.push(`symbol: ${symbol.file}${symbol.symbol ? `#${symbol.symbol}` : ''}`)
        lines.push(`notes: ${value.notesCount ?? 0} (read them with part='notes')`)
        if (value.origin !== null && value.origin !== undefined) {
          lines.push(
            `origin: session ${String(value.origin.sessionId).slice(0, 8)}, turn ${value.origin.turn}, seqs ${value.origin.seqRange[0]}..${value.origin.seqRange[1]} — ask the developer before reading it back with todo_recall`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const record = find(id)
      const full = projectFull(record)
      const part = typeof args?.part === 'string' ? args.part.trim() : ''
      if (part === '') {
        return {
          shape: 'card',
          id: full.id,
          label: full.label,
          title: full.title,
          status: full.status,
          kind: full.kind,
          workspace: full.workspace,
          core: full.core,
          brief: full.brief,
          briefSource: full.briefSource,
          briefWarnings: full.briefWarnings,
          mustRead: full.mustRead,
          park: full.park.map((item) => ({ label: item.label, why: item.why })),
          code: full.code,
          touchedFiles: full.touchedFiles,
          notesCount: full.notes.length,
          origin: full.origin,
          request: full.request,
          sources: full.sources,
        }
      }
      if (part === 'notes') {
        return { shape: 'notes', id: full.id, label: full.label, title: full.title, notesCount: full.notes.length, notes: full.notes }
      }
      const parked = /^park:(\d+)$/u.exec(part)
      if (parked !== null) {
        const index = Number(parked[1])
        if (!Number.isInteger(index) || index < 1 || index > full.park.length) {
          throw new TodoInputError('todo/park-missing', `park:${parked[1]} is out of range (1..${full.park.length})`)
        }
        const pointer = full.park[index - 1]
        return { shape: 'park', id: full.id, label: full.label, index, pointer }
      }
      if (part === 'sources') {
        return { shape: 'sources', id: full.id, label: full.label, title: full.title, sources: full.sources }
      }
      const sourcePart = /^source:(.+)$/u.exec(part)
      if (sourcePart !== null) {
        const source = full.sources.find((item) => item.sid === sourcePart[1])
        if (source === undefined) throw new TodoInputError('todo/source-missing', `no source ${sourcePart[1]} on card #${full.label ?? full.id}`)
        return { shape: 'source', id: full.id, label: full.label, title: full.title, source }
      }
      throw new TodoInputError('todo/invalid-part', "part must be 'notes', 'park:<n>', 'sources', or 'source:<sid>'")
    },
  })
}

/**
 * `todo_note` — append-only supplement (DESIGN.md §5.2). Never rewrites the card.
 *
 * @param options - injected dependencies.
 * @returns the `todo_note` definition.
 */
export function createTodoNoteTool({ defineTool, store, now = Date.now }) {
  return defineTool({
    name: 'todo_note',
    description: [
      'Append one short note to an existing card: a new fact, a piece of evidence, a status remark, or an explicit no-result.',
      'Use it when working on the card and you learn something the card does not say. Do NOT rewrite the card and do NOT repeat what it already has; the note list is read in order.',
      "Use kind='no-result' only when you explicitly looked for something in a named source/range and did not find it; put the question and range in the text and link sourceIds. A no-result is a check record, never evidence that the thing is absent from the whole session.",
      'Appending is cheap and needs no confirmation when you are already working on that card.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Card label like 3.2 or #3.2, or the td_ id.' },
      text: { type: 'string', required: true, description: 'At most 300 characters. One fact, not a summary.' },
      kind: {
        type: 'string',
        enum: ['supplement', 'evidence', 'status', 'no-result'],
        description: 'supplement (default): new context; evidence: a concrete observation; status: a state change; no-result: an explicit check found nothing in the named source/range.',
      },
      basis: { type: 'string', enum: BRIEF_BASES, description: 'Optional BriefBasis for this note.' },
      role: { type: 'string', description: 'Optional role, e.g. doc/code/decision.' },
      sourceIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional existing source sids this note cites; does not read history.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          label: { type: 'string' },
          title: { type: 'string', required: true },
          notesCount: { type: 'integer', required: true },
          kind: { type: 'string', required: true },
          text: { type: 'string', required: true },
          basis: { type: 'string' },
          role: { type: 'string' },
          sourceIds: { type: 'json' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Appended a ${value.kind} note to #${value.label ?? value.id}「${value.title}」 (${value.notesCount} total).` },
      ],
    },
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const record = store.findRef(id)
      if (record === undefined) throw new TodoInputError('todo/not-found', `no card #${id}`)
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      if (text === '') throw new TodoInputError('todo/note-empty', 'text is required')
      if ([...text].length > 300) {
        throw new TodoInputError('todo/note-too-long', 'text must be at most 300 characters: one fact, not a summary')
      }
      const session = exec?.agent?.session
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      const updated = await store.addNote(
        record.id,
        { text, kind: args?.kind, fromSession: sessionId, turn: currentTurn(session), basis: args?.basis, role: args?.role, sourceIds: args?.sourceIds },
        now,
      )
      const storedNote = updated.notes.at(-1)
      return {
        id: updated.id,
        label: labelOf(updated).label,
        title: updated.title,
        notesCount: updated.notes.length,
        kind: args?.kind ?? 'supplement',
        text,
        ...(storedNote?.basis === undefined ? {} : { basis: storedNote.basis }),
        ...(storedNote?.role === undefined ? {} : { role: storedNote.role }),
        ...(storedNote?.sourceIds === undefined ? {} : { sourceIds: storedNote.sourceIds }),
      }
    },
  })
}

/**
 * `todo_list` — the L0 index (DESIGN.md §5.4). One line per card, never the body.
 *
 * @param options - injected dependencies.
 * @returns the `todo_list` definition.
 */
export function createTodoListTool({ defineTool, store, resolveWorkspace }) {
  return defineTool({
    name: 'todo_list',
    description: [
      'List card ids with a one-line title, status, and kind. This is an index: it does not return what the card knows.',
      'Call it when you need to find which cards exist for a workspace, or when the developer refers to a card without giving its label. It prints one short label per card (#3.2); follow with todo_read for the one you need.',
      'Defaults to the current session workspace and to cards still open or in progress.',
    ].join(' '),
    parameters: {
      workspace: {
        type: 'string',
        description: "'*' for every workspace, 'inbox' for unowned cards; omitted uses this session's workspace.",
      },
      status: {
        type: 'string',
        description: 'open | doing | done | dropped | active (open+doing, the default) | all.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'json', required: true },
          total: { type: 'integer', required: true },
          workspace: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        if (value.total === 0) return [{ type: 'text', text: `No cards in ${value.workspace === '*' ? 'any workspace' : value.workspace}.` }]
        const lines = [`${value.total} card(s) in ${value.workspace === '*' ? 'all workspaces' : value.workspace}:`]
        for (const item of value.items) lines.push(`#${item.label ?? item.id} [${item.status}] ${item.kind} · ${item.title}`)
        lines.push("Read one with todo_read; this list omits what each card knows.")
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requested = typeof args?.workspace === 'string' ? args.workspace.trim() : ''
      let workspace = requested
      if (workspace === '') {
        const cwd = typeof exec?.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : ''
        workspace = await resolveWorkspace(cwd)
      }
      const status = typeof args?.status === 'string' ? args.status.trim() : 'active'
      const statuses =
        status === 'all' ? ['open', 'doing', 'done', 'dropped'] : status === 'active' ? ['open', 'doing'] : [status]
      const items = store
        .all()
        .filter((record) => (workspace === '*' ? true : record.workspace === workspace))
        .filter((record) => statuses.includes(record.status))
        .map((record) => ({ id: record.id, label: labelOf(record).label, title: record.title, status: record.status, kind: record.kind }))
      return { items, total: items.length, workspace }
    },
  })
}

/**
 * `todo_recall` — the expensive read-back (DESIGN.md §5.5, §3.7). Two stages, and
 * the second one only on the developer's word.
 *
 * @param options - injected dependencies.
 * @param options.defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param options.store - the todo store.
 * @param options.recall - the two-stage reader from `createRecall`.
 * @returns the `todo_recall` definition.
 */
export function createTodoRecallTool({ defineTool, store, recall }) {
  return defineTool({
    name: 'todo_recall',
    description: [
      'Read the original session content behind a card: the events it was captured from, which are not stored on the card itself.',
      'HARD RULE: never call this on your own initiative. The returned text stays in context and is paid for on every later step, so ask the developer first and name the card you want to read back.',
      'Call it WITHOUT slice first: it returns a cheap manifest (seq, turn, role, first line, token estimate) of the selected source. Then, with the developer, pick one slice and call it again WITH that slice to get the text.',
      'The default source is the card origin; use sourceId to read another source pointer returned by todo_read.',
      "Before a card exists, call with target: 'session:current' and no id to read from this session; it never writes a card.",
      'First check what is already visible; pass gap (what is missing) and reason (why it must be read now). mode="first-batch" reads the earliest effective human turns, not the most recent messages. Stop as soon as the gap is resolved.',
      'Prefer what the card and its notes already say; recall is the fallback for content lost to compaction.',
    ].join(' '),
    parameters: {
      id: { type: 'string', description: 'Card label like 3.2 or #3.2, or the td_ id. Omit when target is session:current.' },
      target: { type: 'string', description: "Optional 'session:current' for a pre-card read; it never writes a card." },
      sourceId: { type: 'string', description: "Optional source sid from todo_read (e.g. s0). Omit for the card's origin." },
      gap: { type: 'string', description: 'What information is missing and why the current visible context is insufficient.' },
      reason: { type: 'string', description: 'Why this read is needed now; used in the approval prompt.' },
      mode: {
        type: 'string',
        enum: ['manifest', 'body', 'first-batch'],
        description: 'manifest (default) / body (requires slice) / first-batch (earliest effective human turns).',
      },
      slice: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Inclusive [from, to] sequence numbers taken from the manifest. Omit for the manifest itself.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shape: { type: 'string', required: true, enum: ['manifest', 'body', 'first-batch', 'unavailable'] },
          id: { type: 'string', required: true },
          label: { type: 'string' },
          available: { type: 'boolean', required: true },
          reason: { type: 'string' },
          sourceId: { type: 'string' },
          sources: { type: 'json' },
          sessionId: { type: 'string' },
          range: { type: 'json' },
          total: { type: 'integer' },
          tokens: { type: 'integer' },
          entries: { type: 'json' },
          slice: { type: 'json' },
          turns: { type: 'json' },
          truncated: { type: 'boolean' },
          stop: { type: 'boolean' },
          stats: { type: 'json' },
        },
      },
      render: (_args, value) => {
        if (value.shape === 'unavailable') {
          return [{ type: 'text', text: `#${value.label ?? value.id}: nothing to read back (${value.reason ?? 'unavailable'}).` }]
        }
        if (value.shape === 'manifest' || value.shape === 'first-batch') {
          const lines = [
            `#${value.label ?? value.id} source ${value.sourceId ?? 'origin'} ${value.shape === 'first-batch' ? `first batch (turns ${(value.turns ?? []).join(', ')})` : `captures ${value.total} message(s)`} in seq ${value.range[0]}..${value.range[1]} (~${value.tokens} tokens):`,
          ]
          for (const entry of value.entries ?? []) {
            lines.push(`${entry.seq}\t[${entry.role}] turn ${entry.turn}\t~${entry.tokens}t${entry.visible === true ? '\t[visible]' : ''}\t${entry.preview}`)
          }
          if (value.truncated === true) lines.push(`Showing the first ${value.entries.length} of ${value.total} messages; request a narrower source/range for the rest.`)
          if (value.stop === true) lines.push('All requested messages are already in the current model surface; stop and use the visible context.')
          else lines.push('Ask the developer which slice to read, then call again with slice=[from, to].')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`#${value.label ?? value.id} source ${value.sourceId ?? 'origin'} seq ${value.slice[0]}..${value.slice[1]}:`]
        for (const entry of value.entries ?? []) {
          lines.push(`\n[seq ${entry.seq} · ${entry.role} · turn ${entry.turn}]\n${entry.text}`)
        }
        if (value.truncated === true) lines.push('\n(body truncated at the size cap)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requestedId = typeof args?.id === 'string' ? args.id.trim() : ''
      const wantsCurrent = typeof args?.target === 'string' && args.target.trim() === 'session:current'
      if (wantsCurrent && requestedId !== '') {
        throw new TodoInputError('todo/ambiguous-target', "target 'session:current' cannot be combined with a card id")
      }
      if (!wantsCurrent && requestedId === '') {
        throw new TodoInputError('todo/target-required', "pass a card id, or target: 'session:current'")
      }

      let id = requestedId
      let label = ''
      let target
      let sourceId = 'origin'
      let sources = []
      if (wantsCurrent) {
        const session = exec?.agent?.session
        const currentSessionId = typeof session?.id === 'string'
          ? session.id
          : typeof exec?.agent?.id === 'string'
            ? exec.agent.id
            : ''
        if (currentSessionId === '') {
          return { shape: 'unavailable', id: 'session:current', label: 'current session', available: false, reason: 'the current session id is unavailable' }
        }
        let end = Number.isInteger(session?.seq) ? session.seq - 1 : 0
        if (end < 1 && typeof session?.snapshotEvents === 'function') {
          try {
            end = session.snapshotEvents().reduce((max, event) => (Number.isInteger(event?.seq) && event.seq > max ? event.seq : max), 0)
          } catch {
            // Keep the unavailable answer below.
          }
        }
        if (end < 1) {
          return { shape: 'unavailable', id: 'session:current', label: 'current session', available: false, reason: 'this session has no history yet' }
        }
        id = 'session:current'
        label = 'current session'
        target = { sid: 'session:current', kind: 'session', label, where: { sessionId: currentSessionId, seqRange: [1, end] } }
        sourceId = 'session:current'
      } else {
        const record = store.findRef(id)
        if (record === undefined) throw new TodoInputError('todo/not-found', `no card #${id}`)
        const full = projectFull(record)
        sources = full.sources
        label = labelOf(record).label
        const requestedSourceId = typeof args?.sourceId === 'string' ? args.sourceId.trim() : ''
        if (requestedSourceId !== '') {
          target = sources.find((source) => source.sid === requestedSourceId)
          if (target === undefined) {
            return {
              shape: 'unavailable',
              id,
              label,
              available: false,
              reason: `source ${requestedSourceId} is not on this card`,
              sourceId: requestedSourceId,
              sources,
            }
          }
          sourceId = target.sid
        } else if (record.origin !== undefined) {
          target = record.origin
        } else {
          target = sources.find((source) => source.kind === 'session' && typeof source.where?.sessionId === 'string')
          if (target === undefined) {
            return {
              shape: 'unavailable',
              id,
              label,
              available: false,
              reason: 'this card has no origin session or session source',
              sources,
            }
          }
          sourceId = target.sid
        }
      }

      const currentSessionId = typeof exec?.agent?.session?.id === 'string'
        ? exec.agent.session.id
        : typeof exec?.agent?.id === 'string'
          ? exec.agent.id
          : ''
      const targetSessionId = typeof target?.where?.sessionId === 'string'
        ? target.where.sessionId
        : typeof target?.sessionId === 'string'
          ? target.sessionId
          : ''
      const surface = currentSessionId !== '' && targetSessionId === currentSessionId
      const mode = typeof args?.mode === 'string' ? args.mode.trim() : ''
      const unavailable = (extra = {}) => {
        const value = { shape: 'unavailable', id, label, available: false, sourceId, sources }
        for (const [key, item] of Object.entries(extra)) {
          if (item !== undefined) value[key] = item
        }
        return value
      }

      if (mode === 'first-batch') {
        const result = await recall.firstBatch(target, { currentTurn: currentTurn(exec?.agent?.session), surface })
        if (result.available !== true) return unavailable({ reason: result.reason, range: result.range, sessionId: result.sessionId })
        return { shape: 'first-batch', id, label, available: true, sourceId, sources, ...result }
      }
      if (Array.isArray(args?.slice)) {
        const result = await recall.body(target, args.slice, { surface })
        if (result.available !== true) return unavailable({ reason: result.reason, stop: result.stop, stats: result.stats })
        return { shape: 'body', id, label, available: true, sourceId, sources, ...result }
      }
      const result = await recall.manifest(target, { surface })
      if (result.available !== true) {
        return unavailable({ reason: result.reason, range: result.range, sessionId: result.sessionId })
      }
      return { shape: 'manifest', id, label, available: true, sourceId, sources, ...result }
    },
  })
}

/**
 * `todo_status` — the one field the agent may change, and only on the
 * developer's word (DESIGN.md §5.2, §3.6). Facts go to `todo_note`; this is just
 * the status transition that closes the loop after a card was handled.
 *
 * @param options - injected dependencies.
 * @param options.defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param options.store - the todo store.
 * @param options.now - clock override (tests).
 * @returns the `todo_status` definition.
 */
export function createTodoStatusTool({ defineTool, store, now = Date.now }) {
  return defineTool({
    name: 'todo_status',
    description: [
      "Change one card's status: open, doing, done or dropped.",
      'Call it ONLY after the developer explicitly confirmed the change. When a todo you were handling is finished — the fix is verified, or the developer says so — ask whether to mark it done; never mark it done on your own, and do not ask again in the same session once answered.',
      'Use todo_note for facts discovered along the way; this tool only moves the status field.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Card label like 3.2/#3.2, or the td_ id.' },
      status: {
        type: 'string',
        required: true,
        enum: ['open', 'doing', 'done', 'dropped'],
        description: 'done closes it; dropped abandons it; open/doing reopen it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          label: { type: 'string' },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `#${value.label ?? value.id}「${value.title}」 is now ${value.status}.` },
      ],
    },
    async execute(args) {
      const record = store.findRef(typeof args?.id === 'string' ? args.id : '')
      if (record === undefined) {
        throw new TodoInputError('todo/not-found', `no card #${args?.id} (pass the label like 3.2/#3.2, or the td_ id)`)
      }
      if (!STATUSES.includes(args?.status)) {
        throw new TodoInputError('todo/invalid-status', `status must be one of: ${STATUSES.join(', ')}`)
      }
      const updated = await store.update(record.id, { status: args.status }, now)
      return { id: updated.id, label: labelOf(updated).label, title: updated.title, status: updated.status }
    },
  })
}
