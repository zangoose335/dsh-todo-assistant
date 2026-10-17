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
  'If an open card in this workspace looks like the same thing (shared touched file plus a similar title), this tool does NOT create a second card: it returns that card instead. Ask the developer whether to merge; on agreement, append the new facts with todo_note.',
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
 * The developer's own words for this capture: the latest human (`source.kind ===
 * 'user'`) message in the current turn, verbatim. Synthetic injections carry a
 * different producer kind and are skipped.
 *
 * @param session - the calling agent's live session.
 * @param now - clock.
 * @returns the request record, or undefined when nobody typed anything.
 */
function requestOf(session, now, store) {
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
    if (latest === undefined) return undefined
    const LIMIT = 8000
    const cap = (value) => {
      const chars = [...value]
      return chars.length > LIMIT ? { text: chars.slice(0, LIMIT).join(''), truncated: true } : { text: value }
    }

    // A `#DB … #/db` message: the request is that block alone (markers already
    // stripped by the extraction), one block per capture in message order.
    const blocks = extractTodoBlocks(latest.text)
    if (blocks.length === 0) return { ...latest, ...cap(latest.text) }
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
    return { ...latest, ...cap(blocks[block]), block }
  } catch {
    return undefined
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
        required: true,
        description: 'How to start: the fix to try (defect), or what to verify first (idea).',
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
        description: `At most ${CAPTURE_LIMITS.mustReadItems} items, each at most ${CAPTURE_LIMITS.mustReadText} characters: the few facts a later session must not have to rediscover.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'One line naming the fact.' },
            text: { type: 'string', required: true, description: 'The fact itself, not a summary of the discussion.' },
            where: whereSchema(false),
          },
        },
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
          warnings: { type: 'array', items: { type: 'string' } },
          label: { type: 'string' },
          candidateId: { type: 'string' },
          candidateTitle: { type: 'string' },
          candidateLabel: { type: 'string' },
          candidateStatus: { type: 'string' },
          similarity: { type: 'number' },
          sharedFiles: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.status === 'duplicate') {
          return [
            {
              type: 'text',
              text: [
                `Not recorded: #${value.candidateLabel ?? value.candidateId}「${value.candidateTitle}」 looks like the same card (title similarity ${value.similarity}; shared file ${value.sharedFiles.join(', ')}).`,
                'Ask the developer whether to merge into that card; if they agree, append the new facts with todo_note and do not add a second card.',
              ].join('\n'),
            },
          ]
        }
        const place = value.workspace === 'inbox' ? 'the inbox' : value.workspace.split('/').filter(Boolean).pop() ?? value.workspace
        const lines = [
          `Recorded #${value.label ?? value.id}「${value.title}」 as a ${value.kind} card in ${place} (${value.mustRead} must-read, ${value.park} parked).`,
        ]
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
      const duplicate = findDuplicate(store.all(), {
        workspace,
        title: args?.title,
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
      const request = requestOf(session, now, store)
      const { record, warnings } = assembleCapture(args, {
        now,
        nextId: () => mintId((id) => store.has(id)),
        origin,
        code,
        workspace,
        request,
      })
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

  return defineTool({
    name: 'todo_read',
    description: [
      'Read one card: what it is, what to do next, the few must-read facts, the parked references, and the code coordinates it was captured at.',
      'Call it when the developer names a card (a short label like #3.2, or the td_ id) or asks you to work on one. Reading costs context, so read the card before the parked references, and only open a parked pointer when its label plus why suggests it is needed.',
      'Parked references are pointers, not content: their bodies are only reachable later through a read-back the developer approves.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Card label like 3.2 or #3.2, or the td_ id.' },
      part: {
        type: 'string',
        description: "Omit for the card itself. 'notes' for the appended notes; 'park:<n>' (1-based) for one parked pointer including where it points.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shape: { type: 'string', required: true, enum: ['card', 'notes', 'park'] },
          id: { type: 'string', required: true },
          label: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          kind: { type: 'string' },
          workspace: { type: 'string' },
          core: { type: 'json' },
          mustRead: { type: 'json' },
          park: { type: 'json' },
          code: { type: 'json' },
          touchedFiles: { type: 'json' },
          notesCount: { type: 'integer' },
          notes: { type: 'json' },
          origin: { type: 'json' },
          request: { type: 'json' },
          index: { type: 'integer' },
          pointer: { type: 'json' },
        },
      },
      render: (_args, value) => {
        if (value.shape === 'notes') {
          const lines = [`#${value.label ?? value.id}「${value.title}」 notes (${value.notesCount}):`]
          for (const [index, note] of (value.notes ?? []).entries()) {
            lines.push(`${index + 1}. [${note.kind}] ${note.text}`)
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
        const lines = [`#${value.label ?? value.id}「${value.title}」 ${value.status}/${value.kind} in ${value.workspace}`]
        if (value.request !== null && value.request !== undefined) {
          lines.push(`developer request (verbatim):`, value.request.text)
        }
        const core = value.core ?? {}
        if (core.symptom !== undefined) lines.push(`symptom: ${core.symptom}`)
        if (core.cause !== undefined) lines.push(`cause: ${core.cause}`)
        if (core.intent !== undefined) lines.push(`intent: ${core.intent}`)
        lines.push(`next: ${core.nextStep ?? ''}`)
        for (const [index, item] of (value.mustRead ?? []).entries()) {
          lines.push(`must-read ${index + 1}. ${item.label}: ${item.text}`)
        }
        for (const item of value.park ?? []) lines.push(`parked: ${item.label} — ${item.why}`)
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
          mustRead: full.mustRead,
          park: full.park.map((item) => ({ label: item.label, why: item.why })),
          code: full.code,
          touchedFiles: full.touchedFiles,
          notesCount: full.notes.length,
          origin: full.origin,
          request: full.request,
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
      throw new TodoInputError('todo/invalid-part', "part must be 'notes' or 'park:<n>'")
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
      'Append one short note to an existing card: a new fact, a piece of evidence, or a status remark discovered later.',
      'Use it when working on the card and you learn something the card does not say. Do NOT rewrite the card and do NOT repeat what it already has; the note list is read in order.',
      'Appending is cheap and needs no confirmation when you are already working on that card.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Card label like 3.2 or #3.2, or the td_ id.' },
      text: { type: 'string', required: true, description: 'At most 300 characters. One fact, not a summary.' },
      kind: {
        type: 'string',
        enum: ['supplement', 'evidence', 'status'],
        description: 'supplement (default): new context; evidence: a concrete observation; status: a state change.',
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
        { text, kind: args?.kind, fromSession: sessionId, turn: currentTurn(session) },
        now,
      )
      return { id: updated.id, label: labelOf(updated).label, title: updated.title, notesCount: updated.notes.length, kind: args?.kind ?? 'supplement', text }
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
      'Call it WITHOUT slice first: it returns a cheap manifest (seq, turn, role, first line, token estimate) of the captured range. Then, with the developer, pick one slice and call it again WITH that slice to get the text.',
      'Prefer what the card and its notes already say; recall is the fallback for content lost to compaction.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Card label like 3.2 or #3.2, or the td_ id.' },
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
          shape: { type: 'string', required: true, enum: ['manifest', 'body', 'unavailable'] },
          id: { type: 'string', required: true },
          label: { type: 'string' },
          available: { type: 'boolean', required: true },
          reason: { type: 'string' },
          sessionId: { type: 'string' },
          range: { type: 'json' },
          total: { type: 'integer' },
          tokens: { type: 'integer' },
          entries: { type: 'json' },
          slice: { type: 'json' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.shape === 'unavailable') {
          return [{ type: 'text', text: `#${value.label ?? value.id}: nothing to read back (${value.reason ?? 'unavailable'}).` }]
        }
        if (value.shape === 'manifest') {
          const lines = [
            `#${value.label ?? value.id} captures ${value.total} message(s) in seq ${value.range[0]}..${value.range[1]} (~${value.tokens} tokens):`,
          ]
          for (const entry of value.entries ?? []) {
            lines.push(`${entry.seq}\t[${entry.role}] turn ${entry.turn}\t~${entry.tokens}t\t${entry.preview}`)
          }
          lines.push('Ask the developer which slice to read, then call again with slice=[from, to].')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`#${value.label ?? value.id} seq ${value.slice[0]}..${value.slice[1]}:`]
        for (const entry of value.entries ?? []) {
          lines.push(`\n[seq ${entry.seq} · ${entry.role} · turn ${entry.turn}]\n${entry.text}`)
        }
        if (value.truncated === true) lines.push('\n(body truncated at the size cap)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const record = store.findRef(id)
      if (record === undefined) throw new TodoInputError('todo/not-found', `no card #${id}`)
      const origin = record.origin
      if (Array.isArray(args?.slice)) {
        const result = await recall.body(origin, args.slice)
        if (result.available !== true) return { shape: 'unavailable', id, label: labelOf(record).label, available: false, reason: result.reason }
        return { shape: 'body', id, label: labelOf(record).label, available: true, ...result }
      }
      const result = await recall.manifest(origin)
      if (result.available !== true) return { shape: 'unavailable', id, label: labelOf(record).label, available: false, reason: result.reason, range: result.range, sessionId: result.sessionId }
      return { shape: 'manifest', id, label: labelOf(record).label, available: true, ...result }
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
