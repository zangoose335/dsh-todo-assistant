/**
 * 待办助理 (todo-assistant) — browser half.
 *
 * Registers a page type on the right sidebar (`sidebar.right.pane.tab`), so it
 * sits beside files / terminal / plan instead of replacing the column. Data comes
 * from the host over the Connection RPC channel the host plugin registers
 * (`/todo-assistant`); the browser never touches storage.
 *
 * This is a plain browser bundle: it imports only the baseline `react` module and
 * talks to the host through Cordis services, so it needs no build step.
 */
window.__ModuleLoader__.load({
  id: 'todo-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ID = 'todo-assistant'
    const NS = 'todoAssistant'
    /** UI sentinels; the host only ever sees a workspace path or `inbox`. */
    const SCOPE_INBOX = '@inbox'
    const SCOPE_ALL = '@all'
    const INBOX = 'inbox'

    /** Document-relative, so a mounted deployment keeps its prefix. */
    const API = 'api/todo-assistant'

    // `ctx.remote.session` needs BOTH keys: the root proxy and the namespace.
    const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.session', 'uiWorkspace']

    const STATUSES = ['open', 'doing', 'done', 'dropped']
    const STATUS_LABEL = { open: 'status.open', doing: 'status.doing', done: 'status.done', dropped: 'status.dropped' }
    const KIND_LABEL = { defect: 'kind.defect', idea: 'kind.idea' }
    /** Form order; also the fallback when the active view names no kind. */
    const KINDS = ['defect', 'idea']

    /** Kind preselected for a new card: the active view wins when it names one. */
    function defaultKind(viewId) {
      return viewId === 'defect' || viewId === 'idea' ? viewId : KINDS[0]
    }
    const VIEWS = [
      { id: 'open', label: 'view.open' },
      { id: 'defect', label: 'view.defect' },
      { id: 'idea', label: 'view.idea' },
      { id: 'done', label: 'view.done' },
      { id: 'all', label: 'view.all' },
    ]

    /** Persisted view id; unknown or unreadable values fall back to "all". */
    function readStoredView() {
      try {
        const raw = window.localStorage.getItem('todo-assistant:view')
        if (raw !== null && VIEWS.some((item) => item.id === raw)) return raw
      } catch {
        // Private mode or a disabled store: keep the default.
      }
      return 'open'
    }

    /** Remember the last view so a restart lands where the developer left off. */
    function storeView(view) {
      try {
        window.localStorage.setItem('todo-assistant:view', view)
      } catch {
        // Not being able to remember is not an error.
      }
    }

    /** One manual/auto order per workspace bucket + view. */
    function orderStorageKey(scope, view) {
      return `todo-assistant:order:${scope ?? '@none'}:${view}`
    }

    /** Read a saved sort mode and manual id order. */
    function readOrderState(scope, view) {
      try {
        const raw = window.localStorage.getItem(orderStorageKey(scope, view))
        if (raw === null) return { mode: 'time-desc', order: [] }
        const parsed = JSON.parse(raw)
        const legacy = parsed?.mode === 'time' ? 'time-desc' : parsed?.mode === 'number' ? 'number-desc' : parsed?.mode
        const valid = ['time-asc', 'time-desc', 'number-asc', 'number-desc', 'relevance', 'manual']
        const mode = valid.includes(legacy) ? legacy : 'time-desc'
        const order = Array.isArray(parsed?.order) ? parsed.order.filter((id) => typeof id === 'string' && id !== '') : []
        return { mode, order: mode === 'manual' ? order : [] }
      } catch {
        return { mode: 'time-desc', order: [] }
      }
    }

    /** Persist one order state; a failed write leaves the in-memory order valid. */
    function storeOrderState(scope, view, mode, order) {
      try {
        window.localStorage.setItem(orderStorageKey(scope, view), JSON.stringify({ mode, order }))
      } catch {
        // Persistence is best effort; do not break the list.
      }
    }

    const ZH = {
      'tab.title': '待办助理',
      'tab.description': '旁支任务的现场快照：先记下来，之后单独会话处理',
      'scope.label': '范围',
      'scope.inbox': '收件箱',
      'scope.all': '全部工作区',
      'sort.label': '排序',
      'sort.time': '时间',
      'sort.number': '编号',
      'sort.manual': '手动',
      'sort.tip': '选择排序方式',
      'sort.timeAsc': '时间 ↑',
      'sort.timeDesc': '时间 ↓',
      'sort.numberAsc': '编号 ↑',
      'sort.numberDesc': '编号 ↓',
      'sort.relevance': '相关性',
      'view.open': '未完成',
      'view.all': '全部',
      'view.defect': '待修复',
      'view.idea': '待添加',
      'view.done': '已完成',
      'status.open': '待处理',
      'status.doing': '处理中',
      'status.done': '已完成',
      'status.dropped': '已放弃',
      'kind.defect': '待修复',
      'kind.idea': '待添加',
      'action.new': '新建待办',
      'action.delete': '删除',
      'action.archive': '归档',
      'action.toggleDone': '标记完成 / 取消完成',
      'action.edit': '编辑标题',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.confirm': '确认',
      'form.titlePlaceholder': '一句话说清要做什么',
      'form.nextStepPlaceholder': '下一步怎么做（可留空）',
      'empty.title': '这里还没有待办',
      'empty.hint': '点右上角 + 手动新建，或在会话里让 AI 记下来',
      'state.loading': '加载中…',
      'state.error': '读取失败',
      'state.retry': '重试',
      'state.busy': '写入中…',
      'meta.files': '{n} 个文件',
      'meta.notes': '{n} 条补充',
      'untitled': '（未命名）',
      'capture.action': '记录待办',
      'pick.title': '插入待办引用',
      'pick.empty': '没有匹配的待办',
      'pick.unfinished': '未完成',
      'pick.finished': '已完成',
      'capture.tipTitle': '待办助理',
      'capture.tipSelect': '选中文本后点击：可自定义记录范围',
      'capture.tipWhole': '按住shift点击：勾选整个回复',
      'capture.title': '把这部分记为待办',
      'capture.lead': '选中后作为一条消息发回当前会话，由 AI 判断并调用 todo_add；不属于旁支时会先问你。',
      'capture.selection': '页面里选中的文字',
      'capture.note': '补一句（可选，例如：这其实是个 bug / 这是个想法）',
      'capture.confirm': '发送给 AI',
      'capture.insert': '插入到对话框',
      'capture.cancel': '取消',
      'capture.empty': '这条回复里没有可选的文字段落',
      'capture.whole': '整条回复',
      'capture.failed': '发送失败',
      'capture.sent': '已发给 AI，等它判断',
      'capture.messageHead': '请把下面这些记为待办（用 todo_add；如果判断不属于旁支，先问我）：',
      'capture.messageNote': '补充：',
      'card.handling': '处理中',
      'action.doing': '正在处理',
      'action.newSession': '新会话中立即执行',
      'action.insertHere': '引用此待办',
      'action.insertBrief': '插入任务简报',
      'tip.quote': '输入框中插入一段提示词，命令 AI 查看此任务。不会自动发送。',
      'tip.brief': '把目标、约束、背景等简报内容插入输入框。不会自动发送。',
      'tip.newSession': '新建一个干净会话，自动交接任务并立即执行。会先开始调查，不会马上执行修改。',
      'error.noWorkspace': '这张卡没有可用的工作区，先切换到一个工作区',
      'error.noComposer': '当前会话的输入框不可用，已复制开场内容，可手动粘贴',
      'error.createSession': '新开会话失败',
      'error.prompt': '会话已创建但开场消息发送失败',
      'seed.header': '接手待办 #{id}「{title}」（{kind}），工作区：{workspace}',
      'seed.mustRead': '必读',
      'seed.park': '备查',
      'seed.files': '触及文件',
      'seed.commit': '写卡时提交',
      'seed.notes': '已有 {n} 条补充（todo_read part=notes 可看）',
      'seed.fileSources': '参考文件/文档',
      'seed.verified': '已核实',
      'seed.unverified': '未核实',
      'seed.check': '参考文件/文档只是线索：先确认是否存在、是否仍适用，只读与任务相关的部分；卡片事实与文档冲突时，以实际核实为准并告知开发者。',
      'seed.briefMissing': '这张卡没有可用简报；请先补充目标、约束和下一步，或按授权回读来源。',
      'seed.briefTruncated': '简报超过 2000 字，已优先保留目标/约束/下一步；其余用 todo_read 补。',
      'seed.briefWarnings': '简报提示',
      'seed.noHistory': '不要自动读取历史；如确需回读，先说明缺口并按 Stage 2 审批。',
      'seed.ask': '接到任务后，遇到不明白、信息不足或暧昧不清的地方，主动向用户提问，不要自行猜测。',
      'seed.cardId': '提到某张卡时，先使用待办助理里显示的编号（如 #6.12）；如果需要内部 id，写成“#6.12（td_45rb）”，不要只写内部 id，否则用户不知道你在说哪张卡；不要编造卡片编号，不确定是否存在时先确认。',
      'handling.briefHeader': '这是已有卡片 #{id}「{title}」的任务简报，不要重复建卡。',
      'handling.briefNote': '如果其中有不明白或暧昧不清的地方，先向我提问；提到卡片时先用待办助理显示的编号，内部 id 放括号；需要更多细节用 todo_read #{id}。',
      'source.doc': '文档',
      'source.code': '代码',
      'seed.hint': '（需要更多细节用 todo_read #{id}；有新发现用 todo_note 追加，不要重写卡片；本轮先只读代码和现有资料并给出方案，不要修改任何文件；方案经开发者确认后再开始实现。处理过程中如果需要开发者做决定、确认方案或补充信息，使用 DSH 的 ask_user_question 工具在过程中提问并等待回答，不要自行决定，也不要把问题留到完成后的回复。完成后主动问开发者是否把 #{id} 标记为完成，确认后再调 todo_status。）',
      'seed.rules': '本工作区的通用规则：',
      'rules.title': '设置通用规则',
      'help.title': '待办助理使用说明',
      'help.close': '收起',
      'help.body': `待办助理 = 主线的"暂存区"：做正事时看到别的问题，先记成一张卡，不打断当前任务；之后再单独开会话处理。

为什么值得用
- 记卡时顺手带上现场：来源会话与轮次、当时的 git commit、触及的文件、你的原话都会存下来，之后不用再问"这是哪来的、当时什么情况"。
- 读卡是为了省 token：卡上先是任务简报（目标/已确认事实与决定/约束/下一步），再是必读与来源指针；需要更深的证据时才按需回读某几段原文。
- 主线不被打断：记下来就走；处理时另开一个干净会话，以卡片开场——上下文从零开始，但信息够用。
- 不会忘：你之后又改到这张卡涉及的文件，下一步会有一行提醒；建卡时还会和已有卡比对，疑似重复会先问你要不要合并。
- 规则只写一次：「设置通用规则」里的要求，之后从卡片开的新会话都会自动带上。

按场景怎么用
- 记下来：直接对 AI 说"把这个 bug 记到待办"或"记一下这个想法"，它会建卡，你继续集中处理主线。
- 事后接着做：每张卡有短编号，下次开会话直接说"接着做 #2.3"，AI 会读卡并从卡上的下一步继续。
- 一次记多条：在 AI 回复上点「记录待办」→ 勾选要记的段落 →「插入到对话框」，可以连着插几段，最后一次性发送。
- 输入即记录：在输入框打 #db，会自动补全成 #DB  #/DB，把内容写在两个标记之间发出去就记好了；
  英文写 #memo（#MEMO  #/MEMO）。标记本身就表示"我同意记"，AI 不会再问。
- 快速引用一张卡：输入框打 #；正常会话中候选按当前会话所属工作区筛选，缺少会话 ID 时退回查询全部工作区。选中一张会插入 #x.y「标题」，AI 看到就知道你指的是哪张。
- 让 AI 收尾：在卡片上点「开始任务」，新会话以这张卡开场；改完它会问你要不要标记完成。
- 固定要求写一次：在「设置通用规则」里写"一次只改一个文件""先解释影响面再动手"这类话，
  之后从卡片开的新会话都会自动带上。

要点
- 记录不花上下文，读卡才花——所以先记下来，之后单独读。
- 编号 #2.3：2 是第几个会话，3 是该会话里的第几张卡。`,

      'rules.hint': '只作用于当前工作区；新会话开始时自动添加此提示词。',
      'rules.placeholder': '例如：积极向我提问；一次只做一件事；改完先说明影响面……',
      'rules.save': '保存',
      'rules.saved': '已保存',
      'rules.empty': '这个工作区还没有规则',
      'handling.insert': '现在切到待办 #{id}「{title}」：先用 todo_read 读它，再按里面的「下一步」继续；提到卡片时先用待办助理显示的编号，需要内部 id 就写成“显示编号（内部 id）”；遇到不明白或暧昧不清的地方，主动用 DSH 的 ask_user_question 问我并等待回答，不要自行猜测，也不要把问题留到最后；改完后问我是否标记完成。',
      'handling.boundTo': '由会话 {id} 处理',
      'action.expand': '展开详情',
      'action.collapse': '收起详情',
      'action.deleteNote': '删除这条补充',
      'detail.brief': '任务简报',
      'detail.briefDerived': '由旧字段生成',
      'detail.briefGoal': '目标',
      'detail.briefWhy': '背景',
      'detail.briefConfirmed': '已确认',
      'detail.briefConstraints': '约束',
      'detail.briefLeads': '线索',
      'detail.briefNext': '下一步',
      'detail.briefOpen': '待确认',
      'detail.briefWarnings': '简报提示',
      'detail.symptom': '现象',
      'detail.cause': '原因',
      'detail.intent': '意图',
      'detail.mustRead': '必读',
      'detail.park': '备查',
      'detail.files': '触及文件',
      'detail.notes': '补充',
      'note.noResult': '查过无结果',
      'detail.origin': '来源',
      'detail.commit': '提交',
      'detail.nextStep': '下一步',
      'detail.request': '开发者需求文本',
      'meta.request': '原需求文本',
      'detail.empty': '（无）',
      'detail.loading': '读取中…',
    }

    const EN = {
      'tab.title': 'Todo Assistant',
      'tab.description': 'Field notes for side quests: capture now, handle in a later session',
      'scope.label': 'Scope',
      'scope.inbox': 'Inbox',
      'scope.all': 'All workspaces',
      'sort.label': 'Sort',
      'sort.time': 'Time',
      'sort.number': 'Number',
      'sort.manual': 'Manual',
      'sort.tip': 'Choose sorting',
      'sort.timeAsc': 'Time ↑',
      'sort.timeDesc': 'Time ↓',
      'sort.numberAsc': 'Number ↑',
      'sort.numberDesc': 'Number ↓',
      'sort.relevance': 'Relevance',
      'view.open': 'Unfinished',
      'view.all': 'All',
      'view.defect': 'To fix',
      'view.idea': 'To add',
      'view.done': 'Done',
      'status.open': 'Open',
      'status.doing': 'Doing',
      'status.done': 'Done',
      'status.dropped': 'Dropped',
      'kind.defect': 'Defect',
      'kind.idea': 'Idea',
      'action.new': 'New todo',
      'action.delete': 'Delete',
      'action.archive': 'Archive',
      'action.toggleDone': 'Mark done / reopen',
      'action.edit': 'Edit title',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.confirm': 'Delete',
      'form.titlePlaceholder': 'One line: what needs doing',
      'form.nextStepPlaceholder': 'How to start (optional)',
      'empty.title': 'No todos here yet',
      'empty.hint': 'Use + above, or ask the agent to capture one',
      'state.loading': 'Loading…',
      'state.error': 'Could not read',
      'state.retry': 'Retry',
      'state.busy': 'Saving…',
      'meta.files': '{n} files',
      'meta.notes': '{n} notes',
      'untitled': '(untitled)',
      'capture.action': 'Record todo',
      'pick.title': 'Insert a todo reference',
      'pick.empty': 'No matching todo',
      'pick.unfinished': 'Unfinished',
      'pick.finished': 'Finished',
      'capture.tipTitle': 'Todo Assistant',
      'capture.tipSelect': 'Click with text selected: choose the captured range',
      'capture.tipWhole': 'Shift+click: take the whole reply',
      'capture.title': 'Capture part of this reply as a todo',
      'capture.lead': 'The selection is sent back to this session as one message; the agent decides and calls todo_add, asking first when it is not a side task.',
      'capture.selection': 'Text selected on the page',
      'capture.note': 'One extra line (optional, e.g. "this is a bug" / "this is an idea")',
      'capture.confirm': 'Send to agent',
      'capture.insert': 'Insert into composer',
      'capture.cancel': 'Cancel',
      'capture.empty': 'This reply has no text paragraphs to pick',
      'capture.whole': 'Whole reply',
      'capture.failed': 'Could not send',
      'capture.sent': 'Sent; waiting for the agent',
      'capture.messageHead': 'Record the following as todos (use todo_add; if you judge they are not side tasks, ask me first):',
      'capture.messageNote': 'Note:',
      'card.handling': 'In progress',
      'action.doing': 'In progress',
      'action.newSession': 'Start in new session',
      'action.insertHere': 'Reference this todo',
      'action.insertBrief': 'Insert task brief',
      'tip.quote': 'Insert a prompt telling the AI to look at this task. It will not be sent automatically.',
      'tip.brief': 'Insert the goal, constraints, background and other brief content into the composer. It will not be sent automatically.',
      'tip.newSession': 'Create a clean session, hand off the task and start immediately. It investigates first and does not edit files right away.',
      'error.noWorkspace': 'This card has no usable workspace; pick one first',
      'error.noComposer': 'The composer is unavailable; the opening text is on its way, paste it manually',
      'error.createSession': 'Could not create the session',
      'error.prompt': 'The session was created but the opening message failed',
      'seed.header': 'Taking over todo #{id}「{title}」({kind}), workspace: {workspace}',
      'seed.mustRead': 'Must read',
      'seed.park': 'Parked',
      'seed.files': 'Files',
      'seed.commit': 'Captured at commit',
      'seed.notes': '{n} note(s) already exist (todo_read part=notes)',
      'seed.fileSources': 'Reference files/docs',
      'seed.verified': 'verified',
      'seed.unverified': 'not verified',
      'seed.check': 'Reference files/docs are clues: confirm they exist and still apply, read only the relevant parts, and if they conflict with card facts, trust the actual check and tell the developer.',
      'seed.briefMissing': 'This card has no usable brief; ask the developer to add the goal, constraints, and next action, or read the source with approval.',
      'seed.briefTruncated': 'The brief exceeds 2,000 characters; goal/constraints/next action were kept first. Use todo_read for the rest.',
      'seed.briefWarnings': 'Brief warnings',
      'seed.noHistory': 'Do not read history automatically; if a read-back is truly needed, state the gap and use the Stage 2 approval path.',
      'seed.ask': 'After receiving a task, proactively ask the user when something is unclear, missing, or ambiguous; do not guess.',
      'seed.cardId': 'When naming a card, use the label shown in the todo assistant first (e.g. #6.12); if an internal id is needed, write "#6.12 (td_45rb)", never the internal id alone; do not invent card numbers, and confirm when unsure whether a card exists.',
      'handling.briefHeader': 'This is the task brief for existing card #{id}「{title}」; do not create a duplicate card.',
      'handling.briefNote': 'If anything is unclear or ambiguous, ask me first; use the displayed card label first and put any internal id in parentheses; use todo_read #{id} for more detail.',
      'source.doc': 'doc',
      'source.code': 'code',
      'seed.hint': '(Read todo_read #{id} for more detail; append new findings with todo_note instead of rewriting the card; in this round, read code and existing materials and present a plan first — do not modify any files; start implementation only after the developer confirms the plan. If you need the developer to decide, confirm a plan, or supply missing information during the work, use the DSH ask_user_question tool while the task is running and wait for the answer; do not decide on your own and do not defer the question to the final reply. When the work is done, ask the developer whether to mark #{id} done, then call todo_status.)',
      'seed.rules': '本工作区的通用规则：',
      'rules.title': 'Workspace rules',
      'help.title': 'Todo Assistant guide',
      'help.close': 'Hide',
      'help.body': `Todo Assistant is a holding area for the main task: when you notice something else, record a card and keep working; handle it in its own session later.

Why it is worth using
- A card carries its own scene: the session and turn it came from, the git commit at the time, the files involved, and your own words — no "where did this come from?" later.
- Reading is cheaper than re-investigating: the card holds a compressed scene (symptom, cause, next step, a few must-reads), not the whole conversation; deeper evidence is re-read only when needed.
- The main task stays uninterrupted: record and move on; handle it in a clean session that opens with the card — fresh context, enough information.
- Nothing gets forgotten: touching a file that a card mentions puts one reminder line in the next step; new captures are compared with open cards and near-duplicates ask first.
- Standing rules are written once: whatever you put under "Workspace rules" travels into every new session started from a card.

How to use it
- Record: tell the agent "record this bug as a todo" or "note this idea"; it creates the card and you keep going.
- Continue later: every card has a short label; say "continue #2.3" in a later session and the agent reads that card and resumes from its next step.
- Several at once: on an assistant reply click "Record todo", pick paragraphs, then "Insert into composer"; repeat and send the batch together.
- Record by typing: type #db in the composer; it completes to #DB  #/DB. Put the content between the markers and send.
  The English form is #memo (#MEMO  #/MEMO). The marker itself is your consent, so nothing else is asked.
- Reference a card: type #; in a normal session the candidates are filtered to the current session's workspace, and when the session ID is missing it falls back to querying all workspaces. Picking one inserts #x.y with the title, so the agent knows which card you mean.
- Let the agent finish it: click "Start task" on a card; the new session opens with that card as its brief and asks whether to mark it done when finished.
- Standing rules: write them once under "Workspace rules" (e.g. "one file at a time"), and every new session started from a card carries them.

Keep in mind
- Recording is free; reading a card costs context, so record now and read later.
- In #2.3, 2 is the session and 3 is the card within it.`,

      'rules.hint': 'Only for this workspace; new sessions start with this prompt.',
      'rules.placeholder': '例如：积极向我提问；一次只做一件事；改完先说明影响面……',
      'rules.save': '保存',
      'rules.saved': '已保存',
      'rules.empty': '这个工作区还没有规则',
      'handling.insert': 'Switch to todo #{id}「{title}」now: read it with todo_read first, then continue from its next step; when naming a card, use the label shown in the todo assistant first, with any internal id in parentheses; when anything is unclear or ambiguous, proactively ask me with the DSH ask_user_question tool and wait for my answer — do not guess, and do not defer questions to the end; ask me whether to mark it done when finished.',
      'handling.boundTo': 'Handled by session {id}',
      'action.expand': 'Show details',
      'action.collapse': 'Hide details',
      'action.deleteNote': 'Delete this note',
      'detail.brief': 'Task brief',
      'detail.briefDerived': 'derived from legacy fields',
      'detail.briefGoal': 'Goal',
      'detail.briefWhy': 'Why',
      'detail.briefConfirmed': 'Confirmed',
      'detail.briefConstraints': 'Constraints',
      'detail.briefLeads': 'Leads',
      'detail.briefNext': 'Next action',
      'detail.briefOpen': 'Open questions',
      'detail.briefWarnings': 'Brief warnings',
      'detail.symptom': 'Symptom',
      'detail.cause': 'Cause',
      'detail.intent': 'Intent',
      'detail.mustRead': 'Must read',
      'detail.park': 'Parked',
      'detail.files': 'Files',
      'detail.notes': 'Notes',
      'note.noResult': 'checked, no result',
      'detail.origin': 'Origin',
      'detail.commit': 'Commit',
      'detail.nextStep': 'Next step',
      'detail.request': 'Developer request',
      'meta.request': 'Request',
      'detail.empty': '(none)',
      'detail.loading': 'Reading…',
    }

    /** Fill `{n}` in a localized line. */
    function fill(text, n) {
      return text.replace('{n}', String(n))
    }

    /** A short, recognizable form of a session id (`session-abc…` → `abc…`). */
    function shortSession(id) {
      return String(id).replace(/^session-/u, '').slice(0, 8)
    }

    /** Fill `{name}` placeholders from one object. */
    function fill2(text, values) {
      return text.replace(/\{([a-z]+)\}/gu, (match, key) => (key in values ? String(values[key]) : match))
    }

    const CSS = `
.tdash-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.45; }
.tdash-head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 6px; }
.tdash-scope { flex: 1 1 auto; min-width: 0; height: 24px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; }
.tdash-iconbtn { flex: 0 0 auto; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 15px; line-height: 1; cursor: pointer; }
.tdash-iconbtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.tdash-iconbtn[data-on="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l2); }
.tdash-views { display: flex; align-items: flex-start; gap: 6px; padding: 0 8px 6px; }
.tdash-views-tabs { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.tdash-views .tdash-iconbtn { align-self: flex-start; }
.tdash-view { border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
.tdash-view:hover { background: var(--dsw-alias-bg-layer-2); }
.tdash-view[data-on="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); box-shadow: 0 2px 6px rgba(0,0,0,.18), inset 0 0 0 1px var(--dsw-alias-border-l1); }
.tdash-view .tdash-n { margin-left: 4px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.tdash-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 8px 38px; display: flex; flex-direction: column; gap: 6px; }
.tdash-card { box-sizing: border-box; min-height: 86px; flex: 0 0 auto; position: relative; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 7px 8px; display: flex; flex-direction: column; gap: 4px; }
.tdash-card[data-status="done"], .tdash-card[data-status="dropped"] { opacity: .62; }
.tdash-row1 { display: flex; align-items: center; gap: 6px; min-height: 20px; padding-right: 24px; }
.tdash-row1 .tdash-radio { margin-top: 0; }
.tdash-titlerow { display: flex; align-items: flex-start; gap: 6px; }
.tdash-kindtag { flex: 0 0 auto; font-size: 11px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.tdash-card[data-kind="defect"] .tdash-kindtag { color: var(--dsw-alias-state-error-primary); }
.tdash-card[data-kind="idea"] .tdash-kindtag { color: var(--dsw-alias-state-business-primary); }
.tdash-radio { flex: none; box-sizing: border-box; width: 16px; height: 16px; margin-top: 2px; padding: 0; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l3); background: transparent; cursor: pointer; position: relative; transition: border-color .15s ease, transform .15s ease; }
.tdash-radio[data-done="true"] { animation: tdash-radio-pop .22s ease-out; }
@keyframes tdash-radio-pop { 0% { transform: scale(.8); } 60% { transform: scale(1.16); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .tdash-radio[data-done="true"] { animation: none; } }
.tdash-radio:hover { border-color: var(--dsw-alias-label-secondary); }
.tdash-card[data-kind="idea"] .tdash-radio:not([data-done="true"]) { border-color: var(--dsw-alias-state-business-primary); }
.tdash-card[data-kind="defect"] .tdash-radio:not([data-done="true"]) { border-color: var(--dsw-alias-state-error-primary); }
.tdash-radio[data-done="true"] { border-color: var(--dsw-alias-state-success-primary); }
.tdash-radio[data-done="true"]::after { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.tdash-radio[data-dropped="true"] { border-style: dashed; opacity: .55; }
.tdash-metainline { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.tdash-footrow { display: flex; align-items: center; gap: 6px; margin-top: auto; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 6px; }
.tdash-topx { position: absolute; top: 0; right: 0; width: 20px; height: 20px; margin: 0; z-index: 2; }
.tdash-expand { margin-left: -3px; }
.tdash-topx .tdash-x { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; line-height: 1; transform: translateY(-1px); }
.tdash-rules-btn { flex: 0 0 auto; box-sizing: border-box; height: 22px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; white-space: nowrap; }
.tdash-sort-btn { flex: 0 0 auto; box-sizing: border-box; height: 22px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; white-space: nowrap; }
.tdash-sort-btn:hover, .tdash-sort-btn[data-on="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.tdash-sort-btn:disabled { opacity: .55; cursor: default; }
.tdash-sort-wrap { position: relative; flex: 0 0 auto; }
.tdash-sort-pop { position: absolute; top: calc(100% + 4px); right: 0; z-index: 50; min-width: 108px; padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 24px rgba(0,0,0,.18); display: flex; flex-direction: column; gap: 2px; }
.tdash-sort-opt { border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; line-height: 18px; text-align: left; padding: 4px 8px; cursor: pointer; white-space: nowrap; }
.tdash-sort-opt:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tdash-sort-opt[data-on="true"] { background: var(--dsw-alias-bg-layer-2); }
.tdash-card[draggable="true"] { cursor: grab; }
.tdash-card[data-dragging="true"] { opacity: .35; cursor: grabbing; outline: 2px dashed var(--dsw-alias-brand-primary); outline-offset: 2px; }
.tdash-drop-line { position: absolute; left: 0; right: 0; z-index: 6; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); pointer-events: none; }
.tdash-drop-line[data-position="before"] { top: -4px; }
.tdash-drop-line[data-position="after"] { bottom: -4px; }
.tdash-rules-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tdash-info { flex: 0 0 auto; box-sizing: border-box; width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer; }
.tdash-info:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.tdash-info[data-on="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tdash-help { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.tdash-help-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tdash-help-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.tdash-help-body { white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.7; }
.tdash-rules-btn[data-on="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tdash-handle { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }
.tdash-handle-btn { position: relative; box-sizing: border-box; height: 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 10px; line-height: 1; cursor: pointer; white-space: nowrap; }
.tdash-handle-btn:hover, .tdash-handle-btn:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.tdash-handle-btn::after { content: attr(data-tip); position: absolute; top: calc(100% + 6px); right: 0; z-index: 100; box-sizing: border-box; width: max-content; max-width: 240px; padding: 3px 7px; border: 0; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 13px; line-height: 20px; white-space: normal; text-align: left; opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.tdash-handle-btn:hover::after, .tdash-handle-btn:focus-visible::after { opacity: 1; }
.tdash-doing { margin-left: auto; flex: 0 0 auto; font-size: 10px; line-height: 18px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-state-success-primary); color: #fff; background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 1px var(--dsw-alias-state-success-primary), 0 0 12px var(--dsw-alias-state-success-primary); }
.tdash-popover { position: absolute; top: 6px; right: 6px; z-index: 6; display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.tdash-popover .tdash-del { justify-content: flex-start; }
.tdash-popover .tdash-del:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tdash-popover .tdash-del[data-danger="true"]:hover { color: var(--dsw-alias-state-error-primary); }
.tdash-no { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tdash-title { flex: 1 1 auto; min-width: 0; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; padding: 0; cursor: text; word-break: break-word; }
.tdash-title:hover { color: var(--dsw-alias-brand-primary); }
.tdash-chip { flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.tdash-next { color: var(--dsw-alias-label-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.tdash-meta { display: flex; align-items: center; gap: 4px; min-height: 22px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.tdash-busy { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); opacity: 0; transition: opacity .12s linear; }
.tdash-busy[data-on="true"] { opacity: 1; }
.tdash-spacer { flex: 1 1 auto; }
.tdash-status { box-sizing: border-box; height: 22px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 0 4px; }
.tdash-del { box-sizing: border-box; height: 22px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; padding: 0 6px; border-radius: 6px; white-space: nowrap; }
.tdash-del:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.tdash-del[data-on="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.tdash-del[data-danger="true"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.tdash-edit { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; padding: 3px 6px; }
.tdash-rules { border-top: 1px solid var(--dsw-alias-border-l1); padding: 6px 0; }
.tdash-rules-head { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 2px; text-align: left; }
.tdash-rules-hint { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.tdash-rules-top { display: flex; align-items: center; gap: 8px; }
.tdash-rules-body { display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 4px; }
.tdash-rules-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 72px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 1.5; padding: 6px 8px; }
.tdash-rules-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.tdash-rules-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.tdash-form { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.tdash-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; padding: 4px 6px; }
.tdash-input:focus, .tdash-edit:focus, .tdash-scope:focus, .tdash-status:focus { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.tdash-kinds { display: flex; gap: 4px; }
.tdash-kind { flex: 0 0 auto; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
.tdash-kind[data-on="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.tdash-kind[data-on="true"][data-kind="defect"] { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: #fff; box-shadow: 0 0 0 1px var(--dsw-alias-state-error-primary), 0 0 12px var(--dsw-alias-state-error-primary); }
.tdash-kind[data-on="true"][data-kind="idea"] { background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); color: #fff; box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary), 0 0 12px var(--dsw-alias-state-business-primary); }
.tdash-kind[data-on="true"][data-kind="defect"]:hover, .tdash-kind[data-on="true"][data-kind="idea"]:hover { opacity: .92; }
.tdash-actions { display: flex; align-items: center; gap: 6px; }
.tdash-btn { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 6px; font-size: 11px; padding: 3px 10px; cursor: pointer; }
.tdash-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.tdash-btn[data-primary="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.tdash-btn[data-primary="true"]:disabled { opacity: .5; cursor: default; }
.tdash-state { padding: 16px 10px; text-align: center; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.tdash-state-title { color: var(--dsw-alias-label-primary); font-weight: 500; }
.tdash-icon { flex: 0 0 auto; box-sizing: border-box; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.tdash-icon:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.tdash-chevron { width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); margin-top: -3px; transition: transform .12s ease, margin-top .12s ease; }
.tdash-chevron[data-open="true"] { transform: rotate(-135deg); margin-top: 3px; }
.tdash-x { font-size: 18px; line-height: 1; }
.tpick { position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); z-index: 100; box-sizing: border-box; max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-menu-surface-fill); backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-prominent); }
.tpick-group { color: var(--dsw-alias-label-tertiary); padding: 6px 8px; font-size: 11px; line-height: 15px; }
.tpick-sep { height: 1px; margin: 4px 8px; background: var(--dsw-alias-border-l1); flex: none; }
.tpick-item { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; border: 0; border-radius: var(--dsw-radius-md); background: 0 0; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; text-align: left; padding: 6px 8px; cursor: pointer; }
.tpick-item[data-on="true"], .tpick-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tpick-no { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.tpick-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpick-meta { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.tpick-empty { color: var(--dsw-alias-label-tertiary); padding: 6px 8px; font-size: 12px; }
.tcap-action { width: calc(28px + var(--dsh-content-font-delta, 0px)); height: calc(28px + var(--dsh-content-font-delta, 0px)); display: inline-flex; align-items: center; justify-content: center; padding: 6px; border: none; border-radius: var(--dsw-radius-sm); background: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.tcap-action svg { width: calc(18px + var(--dsh-content-font-delta, 0px)); height: calc(18px + var(--dsh-content-font-delta, 0px)); }
.tcap-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.tcap-tip { position: fixed; z-index: 100; width: max-content; max-width: 50vw; padding: 3px 7px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 13px; line-height: 20px; white-space: pre-line; overflow-wrap: break-word; pointer-events: none; transform: translateX(-50%); animation: tcap-tip-in 150ms var(--ds-ease-in-out); }
@keyframes tcap-tip-in { from { opacity: 0; } }
.tcap-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); animation: tcap-fade var(--ds-transition-duration) var(--ds-ease-in-out); }
.tcap-panel { width: min(560px, 100%); max-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 0; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); font-size: 12px; animation: tcap-fade var(--ds-transition-duration) var(--ds-ease-in-out); }
@keyframes tcap-fade { from { opacity: 0; } to { opacity: 1; } }
.tcap-head { font-weight: 600; font-size: 13px; }
.tcap-lead { color: var(--dsw-alias-label-secondary); }
.tcap-list { flex: 1 1 auto; min-height: 60px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.tcap-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
.tcap-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tcap-item[data-on="true"] { border-color: var(--dsw-alias-brand-primary); }
.tcap-item input { margin-top: 2px; }
.tcap-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.tcap-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; padding: 6px 8px; }
.tcap-foot { display: flex; justify-content: flex-end; gap: 8px; }
.tcap-err { color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.tdash-menu { display: flex; flex-wrap: wrap; gap: 6px; padding: 5px 0 1px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.tdash-handling { font-size: 10px; color: var(--dsw-alias-brand-primary); }
.tdash-detail { border-top: 1px dashed var(--dsw-alias-border-l1); margin-top: 2px; padding-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.tdash-section { display: flex; flex-direction: column; gap: 3px; }
.tdash-section-title { color: var(--dsw-alias-label-secondary); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.tdash-fact { color: var(--dsw-alias-label-primary); word-break: break-word; }
.tdash-fact-label { color: var(--dsw-alias-label-secondary); margin-right: 4px; }
.tdash-request { white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); padding: 4px 8px; border-left: 2px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); border-radius: 0 6px 6px 0; }
.tdash-ref { display: flex; flex-direction: column; gap: 1px; padding: 3px 6px; border-left: 2px solid var(--dsw-alias-border-l2); }
.tdash-ref-label { color: var(--dsw-alias-label-primary); }
.tdash-ref-text { color: var(--dsw-alias-label-secondary); }
.tdash-note { display: flex; align-items: flex-start; gap: 4px; }
.tdash-note-text { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.tdash-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.tdash-err { padding: 6px 8px; border-radius: 6px; color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); font-size: 11px; word-break: break-word; }
`

    /**
     * True while a CJK input method owns the keystroke, including the Enter that
     * commits raw latin text without picking a candidate. Chrome reports it as
     * `nativeEvent.isComposing`, the Safari/older path as keyCode 229; both must
     * be ignored so composing never submits the form.
     */
    function imeComposing(event) {
      const native = event.nativeEvent
      return event.keyCode === 229 || (native !== undefined && native !== null && native.isComposing === true)
    }

    /** Whether two list payloads describe the same rows in the same order. */
    function sameRows(left, right) {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        if (left[index].id !== right[index].id || left[index].updatedAt !== right[index].updatedAt) return false
      }
      return true
    }

    /** Read a message out of an unknown rejection. */
    function errorTextOf(error) {
      if (error !== null && error !== undefined && typeof error.message === 'string') return error.message
      return String(error)
    }

    /**
     * Call one host endpoint on the authenticated `/api` channel and unwrap the
     * result. The browser cookie rides along same-origin; Connection applies the
     * Host/Origin fence before the route runs.
     *
     * @param endpoint - endpoint name below the channel.
     * @param payload - request payload.
     * @returns the endpoint value.
     */
    async function call(endpoint, payload) {
      const response = await fetch(`${API}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload === undefined ? {} : payload),
      })
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`)
      const result = await response.json()
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        const error = result !== null && typeof result === 'object' ? result.error : undefined
        throw new Error(error === undefined ? `${endpoint}: malformed result` : `${error.code}: ${error.message}`)
      }
      return result.value
    }

    /** A fresh request id for one prompt. */
    function newRequestId() {
      try {
        return crypto.randomUUID()
      } catch {
        return `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    }

    /** Split an assistant reply into selectable paragraphs (blank lines first, then lines). */
    function splitParagraphs(text) {
      const blocks = String(text)
        .split(/\n{2,}/u)
        .map((part) => part.trim())
        .filter((part) => part !== '')
      if (blocks.length > 1) return blocks
      const lines = String(text)
        .split(/\n/u)
        .map((part) => part.trim())
        .filter((part) => part !== '')
      return lines.length > 1 ? lines : blocks
    }

    /** Heuristic preselect: a path, a defect word, or a "by the way" marker. */
    function looksLikeSideFinding(text) {
      return (
        /(^|[\s(])([\w./-]+\.[a-z]{1,4})(?=[\s).,:;]|$)/iu.test(text) ||
        /(bug|error|fail|crash|issue|todo)/iu.test(text) ||
        /(问题|错误|异常|失败|崩溃|发现|建议|顺便)/u.test(text)
      )
    }

    /** One pending capture request, shared by the message action and the overlay panel. */
    function createCaptureStore() {
      let current = null
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        get() {
          return current
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        open(request) {
          current = request
          publish()
        },
        close() {
          current = null
          publish()
        },
      }
    }

    /** Subscribe a component to locale changes so `t()` re-renders. */
    function useLocaleSignal(ctx) {
      const [, tick] = React.useState(0)
      React.useEffect(
        () =>
          ctx.locale.subscribe(() => {
            tick((n) => n + 1)
          }),
        [ctx],
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const zh = ctx.locale.register(NS, 'zh', ZH)
        const en = ctx.locale.register(NS, 'en', EN)
        return () => {
          zh()
          en()
        }
      }, 'todo-assistant: locale')

      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'todo-assistant: styles')

      const captureStore = createCaptureStore()

      /** Button in one finalized assistant message: open the capture panel. */
      function CaptureAction(props) {
        useLocaleSignal(ctx)
        const [tip, setTip] = React.useState(null)
        const showTip = (event) => {
          try {
            const rect = event.currentTarget.getBoundingClientRect()
            setTip({ left: rect.left + rect.width / 2, top: rect.bottom + 6 })
          } catch {
            setTip(null)
          }
        }
        const hideTip = () => setTip(null)
        const messageId = props.messageId
        const useChat = props.useChat
        const sessionId = props.sessionId
        const data =
          typeof useChat === 'function'
            ? useChat((snapshot) => {
                for (const key of snapshot.order) {
                  const node = snapshot.nodes.get(key)
                  if (node === undefined || node === null) continue
                  const finalNode = node.data?.finalNode
                  if (finalNode !== undefined && finalNode !== null && finalNode.messageId !== undefined) {
                    if (String(finalNode.messageId) === String(messageId)) return node.data
                    continue
                  }
                  if (String(node.id) === String(messageId) && node.data?.blocks !== undefined) return node.data
                }
                return undefined
              })
            : undefined
        const blocks = data?.blocks ?? data?.finalNode?.blocks ?? []
        const text = blocks
          .filter((block) => block?.kind === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n\n')
        if (text.trim() === '') return null
        return h(
          React.Fragment,
          null,
          h(
          'button',
          {
            type: 'button',
            className: 'tcap-action',
            'aria-label': t('capture.action'),
            onMouseEnter: showTip,
            onMouseLeave: hideTip,
            onFocus: showTip,
            onBlur: hideTip,
            onClick: (event) => {
              hideTip()
              const whole = event.shiftKey === true
              let selection = ''
              if (!whole) {
                try {
                  selection = String(window.getSelection?.() ?? '').trim()
                } catch {
                  selection = ''
                }
              }
              captureStore.open({
                sessionId: String(sessionId),
                text,
                selection,
                whole,
                requestId: newRequestId(),
                actions: props.inputActions,
              })
            },
          },
          h(
            'svg',
            {
              viewBox: '0 0 16 16',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('circle', { cx: 3.2, cy: 4, r: 1.55 }),
            h('circle', { cx: 3.2, cy: 8, r: 1.55 }),
            h('circle', { cx: 3.2, cy: 12, r: 1.55 }),
            h('path', { d: 'M6.6 4h6.9M6.6 8h6.9M6.6 12h6.9' }),
          ),
          ),
          tip === null
            ? null
            : h(
                'div',
                { className: 'tcap-tip', style: { left: `${tip.left}px`, top: `${tip.top}px` }, role: 'tooltip' },
                `${t('capture.tipTitle')}\n${t('capture.tipSelect')}\n${t('capture.tipWhole')}`,
              ),
        )
      }

      /**
       * Composer helpers (cards 2.3 + 2.5), through the published input actions:
       *
       * - typing `#db` / `#memo` completes to `#DB  #/DB` / `#MEMO  #/MEMO`;
       *   deleting a character of the opening tag removes the whole pair;
       * - typing a bare `#` opens a card picker (`#idea` / `#bug` / `#defect`
       *   filter by kind); picking inserts `#x.y「title」`, and deleting one
       *   character of that title removes the title, keeping the label.
       */
      function MarkerCompletion(props) {
        const actions = props.inputActions
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
        const draft = props.useInput((state) => state.draft)
        const previous = React.useRef(null)
        const [picker, setPicker] = React.useState(null)
        const [items, setItems] = React.useState([])
        const [active, setActive] = React.useState(0)
        const insertedRef = React.useRef('')
        const dismissedRef = React.useRef(null)

        // Candidates come from the same list endpoint the panel uses.
        React.useEffect(() => {
          if (picker === null) {
            setItems([])
            return undefined
          }
          let cancelled = false
          void (async () => {
            try {
              const payload = sessionId === '' ? { all: true } : { bySession: true, sessionId }
              const value = await call('list', payload)
              if (!cancelled) setItems(Array.isArray(value.items) ? value.items : [])
            } catch {
              if (!cancelled) setItems([])
            }
          })()
          return () => {
            cancelled = true
          }
        }, [picker === null, sessionId])

        // This session's own major, and the major it is currently handling.
        const myMajor = items.find((item) => item.origin?.sessionId === sessionId && item.major !== null)?.major
        const rankOf = (item) => (myMajor !== undefined && item.major === myMajor ? 0 : 1)
        const byRecent = (a, b) => (b.major ?? 0) - (a.major ?? 0) || (b.minor ?? 0) - (a.minor ?? 0)

        const query = picker === null ? '' : picker.query.toLowerCase()
        // A prefix of a keyword filters by kind: `#i` → idea, `#b`/`#bu` → bug (defect).
        const kindFilter =
          query === ''
            ? null
            : 'idea'.startsWith(query)
              ? 'idea'
              : 'bug'.startsWith(query) || 'defect'.startsWith(query)
                ? 'defect'
                : null
        const matches = (item) => {
          if (kindFilter !== null) return item.kind === kindFilter
          if (query === '') return true
          return `${item.label ?? ''} ${item.title ?? ''}`.toLowerCase().includes(query)
        }

        const unfinished = items.filter((item) => item.status !== 'done' && item.status !== 'dropped' && matches(item))
        const finished = items.filter((item) => (item.status === 'done' || item.status === 'dropped') && matches(item))
        const sortSection = (list) => [...list].sort((a, b) => rankOf(a) - rankOf(b) || byRecent(a, b))
        const shownUnfinished = picker === null ? [] : sortSection(unfinished).slice(0, 8)
        const room = 8 - shownUnfinished.length
        const shownFinished = picker === null || room <= 0 ? [] : sortSection(finished).slice(0, room)
        const shown = [...shownUnfinished, ...shownFinished]

        /** Replace the typed `#query` token with one card's label and title. */
        function insertItem(item) {
          if (actions === undefined || actions === null || picker === null) return
          try {
            const span = actions.captureInsertion()
            if (span === undefined) return
            const text = `#${item.label ?? item.id}「${item.title}」 `
            if (actions.insertText(text, { start: picker.start, end: span.start, draftRev: span.draftRev }) !== true) return
            insertedRef.current = text
            setPicker(null)
          } catch {
            // A refused edit leaves the draft as typed.
          }
        }

        // Keyboard while open; capture phase so Enter never submits the draft.
        React.useEffect(() => {
          if (picker === null || shown.length === 0) return undefined
          const onKey = (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              event.stopPropagation()
              setActive((index) => (index + 1) % shown.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              event.stopPropagation()
              setActive((index) => (index - 1 + shown.length) % shown.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              event.stopPropagation()
              insertItem(shown[Math.min(active, shown.length - 1)])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              dismissedRef.current = { start: picker.start, query: picker.query }
              setPicker(null)
            }
          }
          window.addEventListener('keydown', onKey, true)
          return () => window.removeEventListener('keydown', onKey, true)
        }, [picker, shown, active])

        React.useEffect(() => {
          const before = previous.current
          previous.current = draft
          if (actions === undefined || actions === null || typeof draft !== 'string') return
          if (before === null || before === draft) return
          try {
            const span = actions.captureInsertion()
            if (span === undefined || span.start !== span.end) {
              setPicker(null)
              return
            }
            const head = draft.slice(0, span.start)

            if (draft.length > before.length) {
              const opened = /(^|\s)(#(db|memo))$/iu.exec(head)
              if (opened !== null) {
                const tag = opened[2]
                const upper = opened[3].toUpperCase()
                if (/^\s*#\/(?:db|memo)/iu.test(draft.slice(span.start))) return
                if (actions.insertText(` #/${upper}`, span) !== true) return
                const fresh = actions.captureInsertion()
                if (fresh === undefined) return
                actions.insertText(`#${upper} `, {
                  start: span.start - tag.length,
                  end: span.start,
                  draftRev: fresh.draftRev,
                })
                return
              }
            }

            if (draft.length < before.length) {
              // (a) A broken bracket pair drops the title and leaves the label.
              // A complete `「title」` stays fully editable, text included.
              const missingClose = /#[\p{L}\p{N}.\-]+「[^」\n]*/gu
              for (const match of draft.matchAll(missingClose)) {
                const open = match.index + match[0].indexOf('「')
                const end = match.index + match[0].length
                if (draft[end] === '」') continue
                const stop = match.index + match[0].replace(/\s+$/u, '').length
                if (span.start > open && span.start <= stop) {
                  const label = draft.slice(match.index, open)
                  if (actions.insertText('', { start: open, end: stop, draftRev: span.draftRev }) !== true) return
                  insertedRef.current = label
                  return
                }
              }
              const missingOpen = /#[\p{L}\p{N}.\-]+[^「」\n]*」/gu
              for (const match of draft.matchAll(missingOpen)) {
                const labelText = /^#[\p{L}\p{N}.\-]+/u.exec(match[0])
                if (labelText === null) continue
                const labelEnd = match.index + labelText[0].length
                if (draft[labelEnd] === '「') continue
                const close = match.index + match[0].length
                if (span.start > labelEnd && span.start <= close) {
                  if (actions.insertText('', { start: labelEnd, end: close, draftRev: span.draftRev }) !== true) return
                  insertedRef.current = labelText[0]
                  return
                }
              }
              // (b) A broken opening marker takes the closing marker with it,
              // wherever the caret sits (deleting from either end of the block).
              const pair = /(^|\s)#(?:d|m|me|mem)?(\s*)(#\/(?:db|memo))(?=\s|$)/iu.exec(draft)
              if (pair !== null) {
                actions.insertText('', {
                  start: pair.index + pair[1].length,
                  end: pair.index + pair[0].length,
                  draftRev: span.draftRev,
                })
                return
              }
            }

            // Picker: a bare `#` (or `#query`) right before the caret.
            const token = /(^|\s)#([\p{L}\p{N}._-]*)$/iu.exec(head)
            if (token === null) {
              setPicker(null)
              return
            }
            const text = token[2]
            const tag = text.toLowerCase()
            if (tag === 'db' || tag === 'memo') {
              setPicker(null)
              return
            }
            if (insertedRef.current !== '' && head.endsWith(insertedRef.current)) {
              insertedRef.current = ''
              setPicker(null)
              return
            }
            const start = span.start - text.length - 1
            const dismissed = dismissedRef.current
            if (dismissed !== null && dismissed.start === start && dismissed.query === text) {
              setPicker(null)
              return
            }
            dismissedRef.current = null
            setPicker({ start, end: span.start, query: text })
            setActive(0)
          } catch {
            // A refused edit leaves the draft as typed.
          }
        }, [actions, draft])

        if (picker === null) return null
        const row = (item, index) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'tpick-item',
              'data-on': index === active ? 'true' : 'false',
              onMouseDown: (event) => {
                event.preventDefault()
                insertItem(item)
              },
            },
            h('span', { className: 'tpick-no' }, `#${item.label ?? item.id}`),
            h('span', { className: 'tpick-title' }, item.title),
            h('span', { className: 'tpick-meta' }, `${item.status}/${item.kind === 'defect' ? 'bug' : item.kind}`),
          )
        return h(
          'div',
          { className: 'tpick', role: 'listbox', 'aria-label': t('pick.title') },
          shown.length === 0
            ? h('div', { className: 'tpick-empty' }, t('pick.empty'))
            : [
                shownUnfinished.length > 0
                  ? h('div', { key: 'g-open', className: 'tpick-group' }, t('pick.unfinished'))
                  : null,
                ...shownUnfinished.map((item, index) => row(item, index)),
                shownFinished.length > 0 && shownUnfinished.length > 0
                  ? h('div', { key: 'sep', className: 'tpick-sep' })
                  : null,
                shownFinished.length > 0
                  ? h('div', { key: 'g-done', className: 'tpick-group' }, t('pick.finished'))
                  : null,
                ...shownFinished.map((item, index) => row(item, shownUnfinished.length + index)),
              ],
        )
      }

      /** The modal panel: pick paragraphs, add one line, send back to the agent. */
      function CapturePanel({ request }) {
        useLocaleSignal(ctx)
        const paragraphs = React.useMemo(() => splitParagraphs(request.text), [request.text])
        const [checked, setChecked] = React.useState(() => {
          const map = {}
          if (request.whole === true) {
            // Shift+click: the whole reply, every paragraph taken.
            for (let index = 0; index < paragraphs.length; index += 1) map[`p${index}`] = true
            return map
          }
          if (request.selection !== '') map.sel = true
          for (const [index, paragraph] of paragraphs.entries()) {
            map[`p${index}`] = request.selection === '' && looksLikeSideFinding(paragraph)
          }
          return map
        })
        const [note, setNote] = React.useState('')
        const [error, setError] = React.useState('')
        const [sending, setSending] = React.useState(false)

        React.useEffect(() => {
          const onKey = (event) => {
            if (event.key === 'Escape') captureStore.close()
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [])

        const chosen = []
        if (request.selection !== '' && checked.sel === true) chosen.push(request.selection)
        for (const [index, paragraph] of paragraphs.entries()) if (checked[`p${index}`] === true) chosen.push(paragraph)

        /** The one message both actions hand over. */
        function composeMessage() {
          const lines = [t('capture.messageHead'), '', chosen.join('\n\n')]
          if (note.trim() !== '') lines.push('', `${t('capture.messageNote')}${note.trim()}`)
          return lines.join('\n')
        }

        /** Put the message into the composer instead of sending it. */
        function insertIntoComposer() {
          if (chosen.length === 0) return
          const actions = request.actions
          const text = composeMessage()
          try {
            if (actions !== undefined && actions !== null) {
              const span = actions.captureInsertion()
              if (actions.insertText(text, span) === true) {
                captureStore.close()
                return
              }
              actions.setDraft(text)
              captureStore.close()
              return
            }
          } catch {
            // Fall through to the visible error.
          }
          setError(t('error.noComposer'))
        }

        async function send() {
          if (chosen.length === 0 || sending) return
          setSending(true)
          setError('')
          try {
            const lines = [composeMessage()]
            const result = await ctx.remote.session.prompt({
              sessionId: request.sessionId,
              requestId: request.requestId,
              mode: 'queue',
              content: [{ type: 'text', text: lines.join('\n') }],
            })
            if (result.ok !== true) throw new Error(`${t('capture.failed')}: ${result.error.code}`)
            captureStore.close()
          } catch (failure) {
            setError(errorTextOf(failure))
          } finally {
            setSending(false)
          }
        }

        function item(key, text, label) {
          return h(
            'label',
            { key, className: 'tcap-item', 'data-on': checked[key] === true ? 'true' : 'false' },
            h('input', {
              type: 'checkbox',
              checked: checked[key] === true,
              onChange: () => setChecked((previous) => ({ ...previous, [key]: previous[key] !== true })),
            }),
            h('span', { className: 'tcap-text' }, label === undefined ? text : `${label}：${text}`),
          )
        }

        return h(
          'div',
          {
            className: 'tcap-backdrop',
            onClick: (event) => {
              if (event.target === event.currentTarget) captureStore.close()
            },
          },
          h(
            'div',
            { className: 'tcap-panel' },
            h('div', { className: 'tcap-head' }, t('capture.title')),
            h('div', { className: 'tcap-lead' }, t('capture.lead')),
            h(
              'div',
              { className: 'tcap-list' },
              request.selection === '' ? null : item('sel', request.selection, t('capture.selection')),
              paragraphs.length === 0
                ? h('div', { className: 'tcap-lead' }, t('capture.empty'))
                : paragraphs.map((paragraph, index) => item(`p${index}`, paragraph)),
            ),
            h('input', {
              className: 'tcap-input',
              placeholder: t('capture.note'),
              value: note,
              onChange: (event) => setNote(event.target.value),
              onKeyDown: (event) => {
                if (imeComposing(event)) return
                if (event.key === 'Enter') void send()
              },
            }),
            error === '' ? null : h('div', { className: 'tcap-err' }, error),
            h(
              'div',
              { className: 'tcap-foot' },
              h('button', { type: 'button', className: 'tdash-btn', onClick: () => captureStore.close() }, t('capture.cancel')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tdash-btn',
                  disabled: chosen.length === 0,
                  onClick: () => insertIntoComposer(),
                },
                t('capture.insert'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tdash-btn',
                  'data-primary': 'true',
                  disabled: chosen.length === 0 || sending,
                  onClick: () => void send(),
                },
                t('capture.confirm'),
              ),
            ),
          ),
        )
      }

      /** Root overlay entry: renders the panel only while a request is pending. */
      function CaptureOverlay() {
        const request = React.useSyncExternalStore(captureStore.subscribe, captureStore.get)
        if (request === null) return null
        return h(CapturePanel, { key: request.requestId, request })
      }

      function TodoPanel(props) {
        useLocaleSignal(ctx)
        // The slot framework names an injected hook `tabInfo` as the `useTabInfo`
        // prop; there is no `props.hooks` bag at render time.
        const useTabInfo = props.useTabInfo
        const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null
        const visible = tabInfo === null ? true : tabInfo.tab.visible
        const sessionId = props.sessionId
        const useWorkspaces = props.useWorkspaces
        const hasWorkspaces = typeof useWorkspaces === 'function'

        const currentPath = hasWorkspaces
          ? useWorkspaces((snapshot) => {
              const found = snapshot.items.find((workspace) => workspace.sessionIds.includes(sessionId))
              return found === undefined ? '' : found.path
            })
          : ''
        const workspacePhase = hasWorkspaces ? useWorkspaces((snapshot) => snapshot.phase) : 'ready'
        const workspaceRows = hasWorkspaces ? useWorkspaces((snapshot) => snapshot.items) : []

        // Follow the session's own workspace by default. A manual pick only holds
        // for the workspace it was made in, so switching workspace snaps back to
        // that workspace instead of showing another workspace's cards.
        const [scopePick, setScopePick] = React.useState(null)
        const autoScope = currentPath !== '' ? currentPath : workspacePhase === 'ready' ? SCOPE_ALL : null
        const scope = scopePick !== null && scopePick.key === currentPath ? scopePick.value : autoScope
        const [view, setView] = React.useState(readStoredView)
        const [rows, setRows] = React.useState([])
        const [phase, setPhase] = React.useState('loading')
        const [errorText, setErrorText] = React.useState('')
        // One write at a time per card, with no layout-visible busy row: the
        // header dot is the only progress affordance.
        const [pendingId, setPendingId] = React.useState(null)
        const [creating, setCreating] = React.useState(false)
        const pendingRef = React.useRef(null)
        const creatingRef = React.useRef(false)
        const [helpOpen, setHelpOpen] = React.useState(false)
        const [rulesOpen, setRulesOpen] = React.useState(false)
        const [rulesText, setRulesText] = React.useState('')
        const [rulesSaved, setRulesSaved] = React.useState('')
        const [rulesBusy, setRulesBusy] = React.useState(false)
        const [draft, setDraft] = React.useState(null)
        const [editingId, setEditingId] = React.useState(null)
        const [editingText, setEditingText] = React.useState('')
        const [pendingDelete, setPendingDelete] = React.useState(null)
        // One visual card flight at a time. The status write never waits for it.
        const animatingRef = React.useRef(false)
        const reflowRef = React.useRef(null)
        // Detail expansion: which cards are open, and the fetched full card by id.
        const [expanded, setExpanded] = React.useState({})
        const [details, setDetails] = React.useState({})
        // Manual order is per workspace bucket + view; a drag turns sorting off.
        const [sortMode, setSortMode] = React.useState('time-desc')
        const [sortOpen, setSortOpen] = React.useState(false)
        const [manualOrder, setManualOrder] = React.useState([])
        const [draggingId, setDraggingId] = React.useState(null)
        const [dropIndex, setDropIndex] = React.useState(null)
        const orderBeforeRef = React.useRef(null)
        const dragIdRef = React.useRef(null)
        const dropIndexRef = React.useRef(null)

        React.useEffect(() => {
          const saved = readOrderState(scope, view)
          setSortMode(saved.mode)
          setManualOrder(saved.order)
          setDraggingId(null)
          setDropIndex(null)
          setSortOpen(false)
          dropIndexRef.current = null
          dragIdRef.current = null
        }, [scope, view])

        React.useEffect(() => {
          if (!sortOpen) return undefined
          const onDown = (event) => {
            if (event.target instanceof Element && event.target.closest('.tdash-sort-wrap') !== null) return
            setSortOpen(false)
          }
          document.addEventListener('mousedown', onDown, true)
          return () => document.removeEventListener('mousedown', onDown, true)
        }, [sortOpen])

        // FLIP the cards when a drag changes their order.
        React.useLayoutEffect(() => {
          const before = orderBeforeRef.current
          if (before === null) return
          orderBeforeRef.current = null
          if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return
          for (const element of document.querySelectorAll('.tdash-card')) {
            const id = element.getAttribute('data-row-id')
            if (id === null || id === dragIdRef.current) continue
            const oldTop = before.get(id)
            if (oldTop === undefined) continue
            const newTop = element.getBoundingClientRect().top
            const delta = oldTop - newTop
            if (Math.abs(delta) <= 1) continue
            try {
              element.animate(
                [
                  { transform: `translateY(${delta}px)` },
                  { transform: 'translateY(0)' },
                ],
                { duration: 190, easing: 'cubic-bezier(.2,.8,.25,1)' },
              )
            } catch {
              // Animation is optional.
            }
          }
        }, [rows])

        const load = React.useCallback(async (silent) => {
          if (scope === null) {
            setPhase('loading')
            return
          }
          if (silent !== true) setPhase('loading')
          setErrorText('')
          try {
            const payload = scope === SCOPE_ALL ? { all: true } : { workspace: scope === SCOPE_INBOX ? INBOX : scope }
            if (sessionId !== undefined && sessionId !== null) payload.sessionId = String(sessionId)
            const value = await call('list', payload)
            setRows((previous) => (sameRows(previous, value.items) ? previous : value.items))
            setPhase('ready')
          } catch (error) {
            setErrorText(errorTextOf(error))
            setPhase('error')
          }
        }, [scope])

        React.useEffect(() => {
          void load()
        }, [load])

        const wasVisible = React.useRef(visible)
        React.useEffect(() => {
          if (visible && !wasVisible.current) void load()
          wasVisible.current = visible
        }, [visible, load])

        // The agent writes cards host-side, with no push channel of its own, so a
        // visible tab re-reads quietly. Local HTTP, no model tokens; skipped while
        // the developer is typing or a write is in flight.
        React.useEffect(() => {
          if (!visible) return undefined
          const timer = setInterval(() => {
            if (pendingRef.current !== null || creatingRef.current) return
            if (editingId !== null || draft !== null) return
            void load(true)
          }, 4000)
          return () => clearInterval(timer)
        }, [visible, load, editingId, draft])

        /** The opening message a new session starts from: the card's L1. */
        function buildSeed(detail, rulesText) {
          const lines = [
            fill2(t('seed.header'), {
              id: detail.label ?? detail.id,
              title: detail.title,
              kind: KIND_LABEL[detail.kind] === undefined ? detail.kind : t(KIND_LABEL[detail.kind]),
              workspace: detail.workspace === 'inbox' ? t('scope.inbox') : detail.workspace,
            }),
          ]
          if (typeof rulesText === 'string' && rulesText.trim() !== '') {
            lines.push('', `${t('seed.rules')}`, rulesText.trim(), '')
          }
          const brief = detail.brief !== null && typeof detail.brief === 'object' ? detail.brief : null
          const request = detail.request
          const addBriefItem = (target, label, text) => {
            if (typeof text === 'string' && text.trim() !== '') target.push(`${label}: ${text.trim()}`)
          }
          const addBriefList = (target, label, items) => {
            const values = (Array.isArray(items) ? items : [])
              .map((item) => `[${item.basis}] ${item.text}${item.impact === 'blocking' ? ' [blocking]' : ''}`)
            if (values.length > 0) target.push(`${label}: ${values.join('；')}`)
          }
          if (brief !== null && detail.briefSource === 'stored') {
            const essential = []
            const extra = []
            addBriefItem(essential, t('detail.briefGoal'), brief.goal)
            addBriefList(essential, t('detail.briefConstraints'), brief.constraints)
            addBriefItem(essential, t('detail.briefNext'), brief.nextAction)
            addBriefItem(extra, t('detail.briefWhy'), brief.why)
            addBriefList(extra, t('detail.briefConfirmed'), brief.confirmed)
            addBriefList(extra, t('detail.briefLeads'), brief.leads)
            addBriefList(extra, t('detail.briefOpen'), brief.openQuestions)
            // Goal/constraints/next-action are always kept, even if that exceeds
            // the 2,000-character target; extras are added only while they fit.
            const kept = [...essential]
            let size = essential.reduce((sum, line) => sum + line.length + 1, 0)
            let truncated = size > 2000
            if (!truncated) {
              for (const line of extra) {
                if (size + line.length + 1 > 2000) {
                  truncated = true
                  break
                }
                kept.push(line)
                size += line.length + 1
              }
            }
            lines.push(`- ${t('detail.brief')}:`)
            for (const line of kept) lines.push(`  ${line}`)
            if (truncated) lines.push(`  ${t('seed.briefTruncated')}`)
            if (!brief.goal || !brief.nextAction) lines.push(`- ${t('seed.briefMissing')}`)
            const warnings = detail.briefWarnings ?? []
            if (warnings.length > 0) {
              lines.push(`- ${t('seed.briefWarnings')}: ${warnings.slice(0, 3).join('；')}`)
            }
            if (request !== null && request !== undefined) {
              lines.push(`- ${t('detail.request')}:`)
              lines.push(request.text)
            }
          } else {
            if (request !== null && request !== undefined) {
              lines.push(`- ${t('detail.request')}:`)
              lines.push(request.text)
            }
            const core = detail.core ?? {}
            const labeled = [
              ['detail.symptom', core.symptom],
              ['detail.cause', core.cause],
              ['detail.intent', core.intent],
            ]
            for (const [key, value] of labeled) {
              if (value !== undefined && value !== '') lines.push(`- ${t(key)}: ${value}`)
            }
            if (core.nextStep !== undefined && core.nextStep !== '') lines.push(`- ${t('detail.nextStep')}: ${core.nextStep}`)
            if ((core.symptom === undefined || core.symptom === '') && (core.nextStep === undefined || core.nextStep === '')) {
              lines.push(`- ${t('seed.briefMissing')}`)
            }
          }
          const files = detail.touchedFiles ?? []
          if (files.length > 0) lines.push(`- ${t('seed.files')}: ${files.join(', ')}`)
          const mustRead = detail.mustRead ?? []
          if (mustRead.length > 0) {
            lines.push(`- ${t('seed.mustRead')}:`)
            for (const [index, item] of mustRead.entries()) lines.push(`  ${index + 1}. ${item.label}: ${item.text}`)
          }
          const park = detail.park ?? []
          if (park.length > 0) lines.push(`- ${t('seed.park')}: ${park.map((item) => `${item.label} — ${item.why}`).join('；')}`)
          const commit = detail.code?.commit
          if (commit !== undefined && commit !== '') lines.push(`- ${t('seed.commit')}: ${String(commit).slice(0, 7)}${detail.code.branch === '' ? '' : ` (${detail.code.branch})`}`)
          const notes = (detail.notes ?? []).length
          if (notes > 0) lines.push(`- ${fill(t('seed.notes'), notes)}`)
          const fileSources = (detail.sources ?? []).filter((source) => source.kind === 'file')
          if (fileSources.length > 0) {
            lines.push(`- ${t('seed.fileSources')}:`)
            for (const source of fileSources.slice(0, 8)) {
              const purpose = source.purpose === 'doc' ? t('source.doc') : source.purpose === 'code' ? t('source.code') : source.purpose
              const status = source.verified === true ? t('seed.verified') : t('seed.unverified')
              lines.push(`  - ${source.label}${purpose === undefined ? '' : ` (${purpose})`} — ${status}`)
            }
            if (fileSources.length > 8) lines.push(`  - …+${fileSources.length - 8}`)
          }
          lines.push(`- ${t('seed.check')}`)
          lines.push(`- ${t('seed.noHistory')}`)
          lines.push(`- ${t('seed.ask')}`)
          lines.push(`- ${t('seed.cardId')}`)
          lines.push(fill2(t('seed.hint'), { id: detail.id }))
          return lines.join('\n')
        }

        /** Mint a request id for one prompt. */
        function requestId() {
          try {
            return crypto.randomUUID()
          } catch {
            return `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`
          }
        }

        /** Open a new session seeded with the card, then navigate to it. */
        async function startSessionFor(row) {
          setErrorText('')
          const previousStatus = row.status
          if (previousStatus !== 'doing') patchRow(row.id, { status: 'doing' })
          try {
            let detail = details[row.id]
            if (detail === undefined) {
              const value = await call('detail', { id: row.id })
              detail = value.item
              setDetails((previous) => ({ ...previous, [row.id]: detail }))
            }
            const workspace = workspaceRows.find((item) => item.path === detail.workspace)
            let request
            if (workspace !== undefined) {
              request = { workspaceId: workspace.workspaceId }
            } else {
              const fallback = detail.workspace === 'inbox' ? currentPath : detail.workspace
              if (typeof fallback !== 'string' || fallback === '') throw new Error(t('error.noWorkspace'))
              request = { cwd: fallback }
            }
            let rulesText = ''
            try {
              const rules = await call('rules.get', { workspace: detail.workspace })
              if (typeof rules.text === 'string') rulesText = rules.text
            } catch {
              // Rules are an extra: a failed read must not block the handoff.
            }
            const sessionRemote = ctx.remote.session
            if (sessionRemote === undefined) throw new Error(t('error.createSession'))
            const created = await sessionRemote.create(request)
            if (created.ok !== true) throw new Error(`${t('error.createSession')}: ${created.error.code}`)
            const sessionId = created.value.sessionId
            try {
              await call('handle', { id: row.id, sessionId })
            } catch {
              // Binding is for automatic "doing" detection; a failed bind must not block the session.
            }
            const prompted = await sessionRemote.prompt({
              sessionId,
              requestId: requestId(),
              mode: 'queue',
              content: [{ type: 'text', text: buildSeed(detail, rulesText) }],
            })
            if (prompted.ok !== true) throw new Error(`${t('error.prompt')}: ${prompted.error.code}`)
            ctx.uiWorkspace.openSession(sessionId)
          } catch (error) {
            if (previousStatus !== 'doing') patchRow(row.id, { status: previousStatus })
            setErrorText(errorTextOf(error))
          }
        }

        /** Put text into the current composer without sending it. */
        function insertTextIntoComposer(text) {
          const actions = props.inputActions
          if (actions === undefined || actions === null) {
            setErrorText(t('error.noComposer'))
            return
          }
          try {
            const span = actions.captureInsertion()
            if (actions.insertText(text, span) !== true) actions.setDraft(text)
          } catch {
            try {
              actions.setDraft(text)
            } catch {
              setErrorText(t('error.noComposer'))
            }
          }
        }

        /** Put the one-line handoff into this session's composer (no auto-send). */
        function insertIntoCurrent(row) {
          insertTextIntoComposer(fill2(t('handling.insert'), { id: row.label ?? row.id, title: row.title }))
        }

        /** Build a compact brief for the current composer, with a 2,000-char cap. */
        function buildInsertBrief(detail) {
          const id = detail.label ?? detail.id
          const header = fill2(t('handling.briefHeader'), { id, title: detail.title })
          const brief = detail.brief !== null && typeof detail.brief === 'object' ? detail.brief : null
          const essential = []
          const extra = []
          const add = (target, label, text) => {
            if (typeof text === 'string' && text.trim() !== '') target.push(`${label}: ${text.trim()}`)
          }
          const addList = (target, label, items) => {
            const values = (Array.isArray(items) ? items : [])
              .map((item) => `[${item.basis}] ${item.text}${item.impact === 'blocking' ? ' [blocking]' : ''}`)
            if (values.length > 0) target.push(`${label}: ${values.join('；')}`)
          }
          if (brief !== null && detail.briefSource === 'stored') {
            add(essential, t('detail.briefGoal'), brief.goal)
            addList(essential, t('detail.briefConstraints'), brief.constraints)
            add(essential, t('detail.briefNext'), brief.nextAction)
            add(extra, t('detail.briefWhy'), brief.why)
            addList(extra, t('detail.briefConfirmed'), brief.confirmed)
            addList(extra, t('detail.briefLeads'), brief.leads)
            addList(extra, t('detail.briefOpen'), brief.openQuestions)
          } else {
            const core = detail.core ?? {}
            add(essential, t('detail.nextStep'), core.nextStep)
            add(extra, t('detail.symptom'), core.symptom)
            add(extra, t('detail.cause'), core.cause)
            add(extra, t('detail.intent'), core.intent)
          }
          // Essential lines are always kept; optional detail fills the remaining budget.
          const kept = [...essential]
          let size = header.length + 1 + essential.reduce((sum, line) => sum + line.length + 1, 0)
          if (size <= 2000) {
            for (const line of extra) {
              if (size + line.length + 1 > 2000) break
              kept.push(line)
              size += line.length + 1
            }
          }
          if (kept.length === 0) kept.push(t('seed.briefMissing'))
          const note = fill2(t('handling.briefNote'), { id })
          return [header, ...kept, note].join('\n')
        }

        /** Fetch the card if needed, then insert its brief into the composer. */
        async function insertBriefIntoCurrent(row) {
          setErrorText('')
          try {
            let detail = details[row.id]
            if (detail === undefined) {
              const value = await call('detail', { id: row.id })
              detail = value.item
              setDetails((previous) => ({ ...previous, [row.id]: detail }))
            }
            insertTextIntoComposer(buildInsertBrief(detail))
          } catch (error) {
            setErrorText(errorTextOf(error))
          }
        }

        // A click anywhere outside an open popover closes it.
        React.useEffect(() => {
          if (pendingDelete === null) return undefined
          const onDown = (event) => {
            const target = event.target
            if (target instanceof Element && target.closest('.tdash-popover') !== null) return
            setPendingDelete(null)
          }
          document.addEventListener('mousedown', onDown, true)
          return () => document.removeEventListener('mousedown', onDown, true)
        }, [pendingDelete])

        /** Load the current workspace's rules whenever the workspace changes. */
        React.useEffect(() => {
          if (typeof currentPath !== 'string' || currentPath === '') {
            setRulesText('')
            setRulesSaved('')
            return undefined
          }
          let cancelled = false
          void (async () => {
            try {
              const value = await call('rules.get', { workspace: currentPath })
              if (cancelled) return
              const text = typeof value.text === 'string' ? value.text : ''
              setRulesText(text)
              setRulesSaved(text)
            } catch {
              if (!cancelled) {
                setRulesText('')
                setRulesSaved('')
              }
            }
          })()
          return () => {
            cancelled = true
          }
        }, [currentPath])

        /** Persist the rules text (blank clears it). */
        async function saveRules() {
          if (rulesBusy || typeof currentPath !== 'string' || currentPath === '') return
          setRulesBusy(true)
          try {
            const value = await call('rules.set', { workspace: currentPath, text: rulesText })
            const text = typeof value.text === 'string' ? value.text : ''
            setRulesText(text)
            setRulesSaved(text)
          } catch (error) {
            setErrorText(errorTextOf(error))
          } finally {
            setRulesBusy(false)
          }
        }

        /** Fetch (or refetch) one card's full detail and remember it. */
        async function loadDetail(id) {
          try {
            const value = await call('detail', { id })
            setDetails((previous) => ({ ...previous, [id]: value.item }))
          } catch (error) {
            setErrorText(errorTextOf(error))
            setExpanded((previous) => {
              const next = { ...previous }
              delete next[id]
              return next
            })
          }
        }

        /** Open or close one card's detail, fetching it on first open. */
        function toggleDetail(id) {
          const open = expanded[id] === true
          setExpanded((previous) => {
            const next = { ...previous }
            if (open) delete next[id]
            else next[id] = true
            return next
          })
          if (!open) void loadDetail(id)
        }

        /** Delete one note and refresh that card's detail. */
        function deleteNote(id, index) {
          void writeRow(id, async () => {
            await call('note.remove', { id, index })
            await loadDetail(id)
            setRows((previous) =>
              previous.map((row) => (row.id === id ? { ...row, notesCount: Math.max(0, row.notesCount - 1) } : row)),
            )
          })
        }

        /**
         * Run one write against one card. The card keeps its height: the only
         * feedback is the header dot, and a row that is already writing ignores
         * another request instead of flickering a disabled control.
         */
        async function writeRow(id, operation) {
          if (pendingRef.current === id) return
          pendingRef.current = id
          setPendingId(id)
          setErrorText('')
          try {
            await operation()
          } catch (error) {
            setErrorText(errorTextOf(error))
          } finally {
            pendingRef.current = null
            setPendingId(null)
          }
        }

        /** The workspace a new card lands in for the current scope. */
        function createTarget() {
          if (scope === SCOPE_INBOX) return INBOX
          if (scope === SCOPE_ALL) return currentPath === '' ? INBOX : currentPath
          return scope
        }

        function createRow() {
          if (draft === null) return
          const title = draft.title.trim()
          if (title === '') return
          const kind = draft.kind
          const nextStep = draft.nextStep.trim()
          const workspace = createTarget()
          if (workspace === null || creatingRef.current) return
          creatingRef.current = true
          setCreating(true)
          setErrorText('')
          void (async () => {
            try {
              const payload = { workspace, title, kind }
              if (nextStep !== '') payload.nextStep = nextStep
              if (sessionId !== undefined && sessionId !== null) payload.sessionId = String(sessionId)
              const value = await call('create', payload)
              setRows((previous) => [value.item, ...previous])
              setDraft(null)
              if (scope !== null && scope !== SCOPE_ALL && scope !== SCOPE_INBOX) setScopePick({ key: currentPath, value: scope })
            } catch (error) {
              setErrorText(errorTextOf(error))
            } finally {
              creatingRef.current = false
              setCreating(false)
            }
          })()
        }

        /**
         * Let a frozen copy fly into one view tab. The real row changes
         * immediately; the copy is a short-lived visual and never controls
         * whether the status write happens.
         */
        function animateCardToTab(cardElement, viewId, done = undefined) {
          let copy = null
          try {
            const doc = cardElement?.ownerDocument
            const root = cardElement?.closest('.tdash-root')
            const target = root?.querySelector(`button[data-view="${viewId}"]`)
            if (!doc || !root || !target || typeof cardElement.animate !== 'function') return null
            if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return null
            const from = cardElement.getBoundingClientRect()
            const to = target.getBoundingClientRect()
            if (from.width === 0 || from.height === 0 || to.width === 0 || to.height === 0) return null
            copy = cardElement.cloneNode(true)
            if (typeof copy.animate !== 'function') return null
            if (done !== undefined) {
              const radio = copy.querySelector('.tdash-radio')
              if (radio !== null) {
                radio.setAttribute('aria-checked', done ? 'true' : 'false')
                radio.setAttribute('data-done', done ? 'true' : 'false')
              }
            }
            copy.removeAttribute('id')
            copy.setAttribute('aria-hidden', 'true')
            copy.style.position = 'fixed'
            copy.style.left = `${from.left}px`
            copy.style.top = `${from.top}px`
            copy.style.width = `${from.width}px`
            copy.style.height = `${from.height}px`
            copy.style.margin = '0'
            copy.style.pointerEvents = 'none'
            copy.style.zIndex = '10000'
            copy.style.transformOrigin = 'center'
            copy.style.willChange = 'transform, opacity'
            copy.style.boxShadow = '0 10px 28px rgba(0,0,0,.24)'
            doc.body.appendChild(copy)
            const dx = to.left + to.width / 2 - (from.left + from.width / 2)
            const dy = to.top + to.height / 2 - (from.top + from.height / 2)
            const flight = copy.animate(
              [
                { transform: 'translate(0, 0) scale(1)', opacity: 1, filter: 'blur(0)' },
                { transform: `translate(${dx * 0.72}px, ${dy * 0.72}px) scale(.38)`, opacity: 0.82, filter: 'blur(.4px)', offset: 0.68 },
                { transform: `translate(${dx}px, ${dy}px) scale(.04)`, opacity: 0, filter: 'blur(1.2px)' },
              ],
              { duration: 430, easing: 'cubic-bezier(.2,.75,.25,1)' },
            )
            if (typeof target.animate === 'function') {
              target.animate(
                [
                  { transform: 'scale(1)' },
                  { transform: 'scale(1.12)' },
                  { transform: 'scale(1)' },
                ],
                { duration: 360, easing: 'ease-out' },
              )
            }
            const cleanup = () => copy.remove()
            flight.finished.then(cleanup, cleanup)
            setTimeout(cleanup, 700)
            return flight
          } catch {
            // Animation is optional; the status write must always proceed.
            try {
              if (copy !== null && copy.isConnected) copy.remove()
            } catch {
              // Cleanup must never replace the original failure.
            }
            return null
          }
        }

        /** Capture card tops before a removal, so following cards can be animated. */
        function captureCardTops(body) {
          if (!body) return undefined
          const tops = new Map()
          for (const element of body.querySelectorAll('.tdash-card')) {
            const id = element.getAttribute('data-row-id')
            if (id !== null) tops.set(id, element.getBoundingClientRect().top)
          }
          return tops
        }

        /** Give cards below the removed one a short up-then-settle motion. */
        function animateFollowingCards(body, before, removedTop) {
          if (!body || body.isConnected === false || before === undefined) return
          if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return
          for (const element of body.querySelectorAll('.tdash-card')) {
            const id = element.getAttribute('data-row-id')
            if (id === null) continue
            const oldTop = before.get(id)
            if (oldTop === undefined || oldTop <= removedTop + 1) continue
            const newTop = element.getBoundingClientRect().top
            const delta = oldTop - newTop
            if (delta <= 1) continue
            try {
              element.animate(
                [
                  { transform: `translateY(${delta}px)` },
                  { transform: 'translateY(-4px)', offset: 0.72 },
                  { transform: 'translateY(0)' },
                ],
                { duration: 430, easing: 'cubic-bezier(.2,.85,.3,1.18)' },
              )
            } catch {
              // Reflow animation is optional.
            }
          }
        }

        /**
         * Start the status write immediately, then play the card flight as a
         * purely visual effect. The write must never depend on the animation.
         */
        function moveCardToView(cardElement, rowId, targetView) {
          if (pendingRef.current !== null) return
          const card = cardElement?.closest?.('.tdash-card')
          if (!card) return
          const body = card.parentElement
          const willLeave = view !== 'all'
          // Capture the card and the survivors before the optimistic update
          // removes this row from the current view. Visual feedback is
          // optional; the status write below must always run.
          let flight = null
          let reflow = null
          try {
            const before = willLeave ? captureCardTops(body) : undefined
            const removedTop = card.getBoundingClientRect().top
            flight = animatingRef.current ? null : animateCardToTab(card, targetView, targetView === 'done')
            if (willLeave) reflow = { body, before, removedTop }
          } catch {
            // A visual failure must never block the status write.
          }
          if (flight !== null) {
            animatingRef.current = true
            const release = () => {
              animatingRef.current = false
            }
            if (typeof flight.finished?.then === 'function') flight.finished.then(release, release)
            else release()
          }
          if (reflow !== null) reflowRef.current = reflow
          patchRow(rowId, { status: targetView === 'done' ? 'done' : 'open' })
        }

        // Measure the survivors after React has removed the flying card but
        // before the browser paints, so the reflow starts without a flash.
        React.useLayoutEffect(() => {
          const pending = reflowRef.current
          if (pending === null) return
          reflowRef.current = null
          animateFollowingCards(pending.body, pending.before, pending.removedTop)
        }, [rows])

        function patchRow(id, patch) {
          if (pendingRef.current === id) return
          const before = rows.find((row) => row.id === id)
          const revert = before === undefined
            ? undefined
            : Object.fromEntries(Object.keys(patch).map((key) => [key, before[key]]))
          setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row)))
          void writeRow(id, async () => {
            try {
              const value = await call('patch', { id, patch })
              setRows((previous) => previous.map((row) => (row.id === id ? value.item : row)))
            } catch (error) {
              if (revert !== undefined) {
                setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...revert } : row)))
              }
              throw error
            }
          })
        }

        /** Abandon a card: it moves to the finished view without being deleted. */
        function archiveRow(id) {
          setPendingDelete(null)
          patchRow(id, { status: 'dropped' })
        }

        function removeRow(id) {
          void writeRow(id, async () => {
            await call('remove', { id })
            setRows((previous) => previous.filter((row) => row.id !== id))
            setPendingDelete(null)
          })
        }

        function commitTitle(id) {
          const title = editingText.trim()
          setEditingId(null)
          if (title === '') return
          const row = rows.find((item) => item.id === id)
          if (row !== undefined && row.title === title) return
          patchRow(id, { title })
        }

        const counts = { all: rows.length, open: 0, defect: 0, idea: 0, done: 0 }
        for (const row of rows) {
          if (row.status === 'done' || row.status === 'dropped') {
            counts.done += 1
            continue
          }
          counts.open += 1
          if (row.kind === 'defect') counts.defect += 1
          else counts.idea += 1
        }

        const shown = rows.filter((row) => {
          if (view === 'all') return true
          if (view === 'done') return row.status === 'done' || row.status === 'dropped'
          if (row.status === 'done' || row.status === 'dropped') return false
          if (view === 'open') return true
          return row.kind === view
        })

        const sortDirection = sortMode.endsWith('-asc') ? 1 : -1
        const byTime = (a, b) => ((a.updatedAt ?? 0) - (b.updatedAt ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0)) * sortDirection
        const byNumber = (a, b) => ((a.major ?? -1) - (b.major ?? -1) || (a.minor ?? -1) - (b.minor ?? -1)) * sortDirection
        const manualRank = new Map(manualOrder.map((id, index) => [id, index]))
        const shownSorted = [...shown].sort((a, b) => {
          if (sortMode === 'manual') {
            const left = manualRank.get(a.id)
            const right = manualRank.get(b.id)
            if (left !== undefined && right !== undefined) return left - right
            if (left !== undefined) return -1
            if (right !== undefined) return 1
          }
          if (sortMode === 'relevance') {
            const related = Number(b.hit === true) - Number(a.hit === true)
            if (related !== 0) return related
            return byTime(a, b)
          }
          return sortMode.startsWith('number') ? byNumber(a, b) : byTime(a, b)
        })
        const sortLabelOf = (mode) => {
          if (mode === 'manual') return t('sort.manual')
          if (mode === 'time-asc') return t('sort.timeAsc')
          if (mode === 'time-desc') return t('sort.timeDesc')
          if (mode === 'number-asc') return t('sort.numberAsc')
          if (mode === 'number-desc') return t('sort.numberDesc')
          return t('sort.relevance')
        }

        function chooseSort(mode) {
          setSortMode(mode)
          setManualOrder([])
          setSortOpen(false)
          storeOrderState(scope, view, mode, [])
        }

        function applyManualOrder(ids) {
          const rank = new Map(ids.map((id, index) => [id, index]))
          const selected = rows.filter((row) => rank.has(row.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id))
          if (selected.length === 0) return
          let cursor = 0
          const nextRows = rows.map((row) => (rank.has(row.id) ? selected[cursor++] : row))
          const body = document.querySelector('.tdash-body')
          const before = captureCardTops(body)
          if (before !== undefined) orderBeforeRef.current = before
          setSortMode('manual')
          setManualOrder(ids)
          setSortOpen(false)
          storeOrderState(scope, view, 'manual', ids)
          setRows(nextRows)
        }

        function beginDrag(row, event) {
          if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a') !== null) {
            event.preventDefault()
            return
          }
          dragIdRef.current = row.id
          dropIndexRef.current = null
          setDraggingId(row.id)
          setDropIndex(null)
          setSortOpen(false)
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
            event.dataTransfer.effectAllowed = 'move'
            try {
              const visibleRef = row.label === null || row.label === undefined
                ? (row.title === '' ? row.id : row.title)
                : `#${row.label}「${row.title}」`
              event.dataTransfer.setData('text/plain', `${visibleRef} `)
              // A lifted clone follows the pointer; no native translucent ghost.
              const cardElement = event.currentTarget
              const rect = cardElement.getBoundingClientRect()
              const clone = cardElement.cloneNode(true)
              clone.removeAttribute('data-row-id')
              clone.setAttribute('aria-hidden', 'true')
              clone.style.position = 'fixed'
              clone.style.left = '-2000px'
              clone.style.top = '0'
              clone.style.width = `${rect.width}px`
              clone.style.height = `${rect.height}px`
              clone.style.opacity = '0.92'
              clone.style.pointerEvents = 'none'
              clone.style.zIndex = '10000'
              clone.style.boxShadow = '0 12px 30px rgba(0,0,0,.28)'
              document.body.appendChild(clone)
              event.dataTransfer.setDragImage(clone, Math.max(0, event.clientX - rect.left), Math.max(0, event.clientY - rect.top))
              setTimeout(() => clone.remove(), 0)
            } catch {
              // If a custom image is rejected, at least suppress the native ghost.
              try {
                const blank = document.createElement('img')
                blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
                event.dataTransfer.setDragImage(blank, 0, 0)
              } catch {
                // Ordering still works without a drag image.
              }
            }
          }
        }

        function dragOverBody(event) {
          if (dragIdRef.current === null) return
          event.preventDefault()
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
          const cards = [...document.querySelectorAll('.tdash-card')]
          let index = cards.length
          for (let position = 0; position < cards.length; position += 1) {
            const rect = cards[position].getBoundingClientRect()
            if (event.clientY < rect.top + rect.height / 2) {
              index = position
              break
            }
          }
          if (dropIndexRef.current === index) return
          dropIndexRef.current = index
          setDropIndex(index)
        }

        function dropOnBody(event) {
          event.preventDefault()
          const index = dropIndexRef.current
          const dragged = dragIdRef.current
          finishDrag()
          if (index === null || dragged === null) return
          const from = shownSorted.findIndex((row) => row.id === dragged)
          if (from < 0) return
          const ids = shownSorted.map((row) => row.id)
          const [moved] = ids.splice(from, 1)
          const insert = from < index ? index - 1 : index
          ids.splice(insert, 0, moved)
          if (ids.every((id, position) => id === shownSorted[position]?.id)) return
          applyManualOrder(ids)
        }

        function finishDrag() {
          dragIdRef.current = null
          dropIndexRef.current = null
          setDraggingId(null)
          setDropIndex(null)
        }

        const scopeOptions = [
          ...workspaceRows.map((workspace) => ({
            value: workspace.path,
            label: workspace.title === '' ? workspace.path : workspace.title,
          })),
          { value: SCOPE_ALL, label: t('scope.all') },
        ]
        const selectValue = scope === null ? SCOPE_ALL : scope

        const head = h(
          'div',
          { className: 'tdash-head' },
          h(
            'select',
            {
              className: 'tdash-scope',
              value: selectValue,
              title: t('scope.label'),
              'aria-label': t('scope.label'),
              onChange: (event) => {
                setScopePick({ key: currentPath, value: event.target.value })
              },
            },
            scopeOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
          typeof currentPath !== 'string' || currentPath === ''
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'tdash-rules-btn',
                  title: t('rules.title'),
                  'data-on': rulesOpen ? 'true' : 'false',
                  'aria-expanded': rulesOpen ? 'true' : 'false',
                  onClick: () => setRulesOpen((open) => !open),
                },
                t('rules.title'),
              ),
          h(
            'div',
            { className: 'tdash-sort-wrap' },
            h(
              'button',
              {
                type: 'button',
                className: 'tdash-sort-btn',
                title: t('sort.tip'),
                'aria-label': t('sort.tip'),
                'aria-expanded': sortOpen ? 'true' : 'false',
                'data-on': sortOpen ? 'true' : 'false',
                onClick: () => setSortOpen((open) => !open),
              },
              `${t('sort.label')} · ${sortLabelOf(sortMode)}`,
            ),
            sortOpen
              ? h(
                  'div',
                  { className: 'tdash-sort-pop', role: 'menu' },
                  ['time-asc', 'time-desc', 'number-asc', 'number-desc', 'relevance'].map((mode) =>
                    h(
                      'button',
                      {
                        key: mode,
                        type: 'button',
                        className: 'tdash-sort-opt',
                        role: 'menuitem',
                        'data-on': sortMode === mode ? 'true' : 'false',
                        onClick: () => chooseSort(mode),
                      },
                      sortLabelOf(mode),
                    ),
                  ),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tdash-info',
              title: t('help.title'),
              'aria-label': t('help.title'),
              'aria-expanded': helpOpen ? 'true' : 'false',
              'data-on': helpOpen ? 'true' : 'false',
              onClick: () => setHelpOpen((open) => !open),
            },
            'i',
          ),
          h('span', { className: 'tdash-busy', 'data-on': pendingId !== null || creating ? 'true' : 'false', 'aria-hidden': 'true' }),
        )

        const viewRow = h(
          'div',
          { className: 'tdash-views' },
          h(
            'div',
            { className: 'tdash-views-tabs' },
            VIEWS.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'tdash-view',
                'data-view': item.id,
                'data-on': view === item.id ? 'true' : 'false',
                onClick: () => {
                  setView(item.id)
                  storeView(item.id)
                },
              },
              t(item.label),
              h('span', { className: 'tdash-n' }, String(counts[item.id])),
            ),
          ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tdash-iconbtn',
              title: t('action.new'),
              'aria-label': t('action.new'),
              'data-on': draft === null ? 'false' : 'true',
              onClick: () => {
                setPendingDelete(null)
                setDraft(draft === null ? { title: '', kind: defaultKind(view), nextStep: '' } : null)
              },
            },
            draft === null ? '+' : '×',
          ),
        )

        const rulesRow =
          typeof currentPath !== 'string' || currentPath === '' || !rulesOpen
            ? null
            : h(
                'div',
                { className: 'tdash-rules' },
                h(
                  'div',
                  { className: 'tdash-rules-body' },
                  h(
                    'div',
                    { className: 'tdash-rules-top' },
                    h('div', { className: 'tdash-rules-hint' }, t('rules.hint')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tdash-btn',
                        'data-primary': 'true',
                        disabled: rulesBusy || rulesText === rulesSaved,
                        onClick: () => void saveRules(),
                      },
                      t('rules.save'),
                    ),
                  ),
                  h('textarea', {
                    className: 'tdash-rules-input',
                    value: rulesText,
                    placeholder: t('rules.placeholder'),
                    rows: 4,
                    onChange: (event) => setRulesText(event.target.value),
                  }),
                ),
              )

        const formRow =
          draft === null
            ? null
            : h(
                'div',
                { className: 'tdash-form' },
                h('input', {
                  className: 'tdash-input',
                  placeholder: t('form.titlePlaceholder'),
                  value: draft.title,
                  maxLength: 80,
                  autoFocus: true,
                  onChange: (event) => {
                    setDraft({ ...draft, title: event.target.value })
                  },
                  onKeyDown: (event) => {
                    if (imeComposing(event)) return
                    if (event.key === 'Enter') createRow()
                    if (event.key === 'Escape') setDraft(null)
                  },
                }),
                h('input', {
                  className: 'tdash-input',
                  placeholder: t('form.nextStepPlaceholder'),
                  value: draft.nextStep,
                  maxLength: 280,
                  onChange: (event) => {
                    setDraft({ ...draft, nextStep: event.target.value })
                  },
                  onKeyDown: (event) => {
                    if (imeComposing(event)) return
                    if (event.key === 'Enter') createRow()
                    if (event.key === 'Escape') setDraft(null)
                  },
                }),
                h(
                  'div',
                  { className: 'tdash-actions' },
                  h(
                    'div',
                    { className: 'tdash-kinds' },
                    KINDS.map((kind) =>
                      h(
                        'button',
                        {
                          key: kind,
                          type: 'button',
                          className: 'tdash-kind',
                          'data-kind': kind,
                          'data-on': draft.kind === kind ? 'true' : 'false',
                          onClick: () => {
                            setDraft({ ...draft, kind })
                          },
                        },
                        t(KIND_LABEL[kind]),
                      ),
                    ),
                  ),
                  h('span', { className: 'tdash-spacer' }),
                  h('button', { type: 'button', className: 'tdash-btn', onClick: () => setDraft(null) }, t('action.cancel')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'tdash-btn',
                      'data-primary': 'true',
                      disabled: draft.title.trim() === '' || creating || scope === null,
                      onClick: createRow,
                    },
                    t('action.save'),
                  ),
                ),
              )

        /** One labelled block in the expanded card. */
        function section(title, children) {
          return h(
            'div',
            { className: 'tdash-section' },
            h('div', { className: 'tdash-section-title' }, title),
            ...children,
          )
        }

        /** The expanded body of one card, from the detail endpoint. */
        function detailBody(row) {
          const detail = details[row.id]
          if (detail === undefined) return h('div', { className: 'tdash-section' }, t('detail.loading'))
          const blocks = []
          const brief = detail.brief !== null && typeof detail.brief === 'object' ? detail.brief : null
          const core = detail.core ?? {}
          if (brief !== null) {
            const facts = []
            const addFact = (label, value) => {
              if (typeof value === 'string' && value !== '') {
                facts.push(h('div', { className: 'tdash-fact' }, h('span', { className: 'tdash-fact-label' }, label), value))
              }
            }
            addFact(t('detail.briefGoal'), brief.goal)
            addFact(t('detail.briefWhy'), brief.why)
            for (const [key, label] of [
              ['confirmed', 'detail.briefConfirmed'],
              ['constraints', 'detail.briefConstraints'],
              ['leads', 'detail.briefLeads'],
              ['openQuestions', 'detail.briefOpen'],
            ]) {
              const items = Array.isArray(brief[key]) ? brief[key] : []
              if (items.length === 0) continue
              addFact(
                t(label),
                items.map((item) => `[${item.basis}] ${item.text}${item.impact === 'blocking' ? ' [blocking]' : ''}`).join('；'),
              )
            }
            addFact(t('detail.briefNext'), brief.nextAction)
            if (detail.briefSource === 'derived') {
              addFact(t('detail.cause'), core.cause)
              addFact(t('detail.intent'), core.intent)
            }
            const title = detail.briefSource === 'derived'
              ? `${t('detail.brief')} · ${t('detail.briefDerived')}`
              : t('detail.brief')
            if (facts.length > 0) blocks.push(section(title, facts))
          } else {
            const facts = []
            if (core.symptom !== undefined && core.symptom !== '') {
              facts.push(h('div', { className: 'tdash-fact' }, h('span', { className: 'tdash-fact-label' }, t('detail.symptom')), core.symptom))
            }
            if (core.cause !== undefined && core.cause !== '') {
              facts.push(h('div', { className: 'tdash-fact' }, h('span', { className: 'tdash-fact-label' }, t('detail.cause')), core.cause))
            }
            if (core.intent !== undefined && core.intent !== '') {
              facts.push(h('div', { className: 'tdash-fact' }, h('span', { className: 'tdash-fact-label' }, t('detail.intent')), core.intent))
            }
            if (facts.length > 0) blocks.push(h('div', { className: 'tdash-section' }, ...facts))
          }
          if (detail.request !== null && detail.request !== undefined) {
            blocks.push(section(t('detail.request'), [h('div', { className: 'tdash-request' }, detail.request.text)]))
          }
          const briefWarnings = detail.briefWarnings ?? []
          if (briefWarnings.length > 0) {
            blocks.push(
              section(
                t('detail.briefWarnings'),
                briefWarnings.map((warning, index) => h('div', { key: `bw${index}`, className: 'tdash-ref-text' }, warning)),
              ),
            )
          }

          const mustRead = detail.mustRead ?? []
          if (mustRead.length > 0) {
            blocks.push(
              section(
                t('detail.mustRead'),
                mustRead.map((item, index) =>
                  h(
                    'div',
                    { key: `m${index}`, className: 'tdash-ref' },
                    h('div', { className: 'tdash-ref-label' }, `${index + 1}. ${item.label}`),
                    h('div', { className: 'tdash-ref-text' }, item.text),
                  ),
                ),
              ),
            )
          }
          const park = detail.park ?? []
          if (park.length > 0) {
            blocks.push(
              section(
                t('detail.park'),
                park.map((item) =>
                  h(
                    'div',
                    { key: item.id, className: 'tdash-ref' },
                    h('div', { className: 'tdash-ref-label' }, item.label),
                    h('div', { className: 'tdash-ref-text' }, item.why),
                  ),
                ),
              ),
            )
          }
          const files = detail.touchedFiles ?? []
          if (files.length > 0) {
            blocks.push(section(t('detail.files'), [h('div', { className: 'tdash-mono' }, files.join('  '))]))
          }
          const notes = detail.notes ?? []
          blocks.push(section(t('detail.notes'), notes.length === 0
            ? [h('div', { className: 'tdash-ref-text' }, t('detail.empty'))]
            : notes.map((note, index) =>
                h(
                  'div',
                  { key: `n${index}`, className: 'tdash-note' },
                  h('div', { className: 'tdash-note-text' }, `${index + 1}. ${note.kind === 'no-result' ? `[${t('note.noResult')}] ` : ''}${note.text}`),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'tdash-icon',
                      title: t('action.deleteNote'),
                      onClick: () => deleteNote(row.id, index),
                    },
                    h('span', { className: 'tdash-x' }, '×'),
                  ),
                ),
              )))
          const code = detail.code ?? {}
          const meta = []
          if (detail.origin !== null && detail.origin !== undefined) {
            meta.push(`${t('detail.origin')}: ${shortSession(detail.origin.sessionId)} · turn ${detail.origin.turn}`)
          }
          if (code.commit !== undefined && code.commit !== '') {
            meta.push(`${t('detail.commit')}: ${String(code.commit).slice(0, 7)}${code.branch === '' ? '' : ` (${code.branch})`}`)
          }
          for (const symbol of code.symbols ?? []) {
            meta.push(`symbol: ${symbol.file}${symbol.symbol === undefined ? '' : `#${symbol.symbol}`}${symbol.line === undefined ? '' : `:${symbol.line}`}`)
          }
          if (meta.length > 0) blocks.push(h('div', { className: 'tdash-mono' }, meta.join('\n')))
          return h('div', { className: 'tdash-detail' }, ...blocks)
        }

        function card(row, dropLine = null) {
          const meta = []
          // Files win over the request text: both at once is noise.
          if (row.touchedFileCount > 0) meta.push(fill(t('meta.files'), row.touchedFileCount))
          else if (row.hasRequest === true) meta.push(t('meta.request'))
          if (row.notesCount > 0) meta.push(fill(t('meta.notes'), row.notesCount))

          const titleNode =
            editingId === row.id
              ? h('input', {
                  className: 'tdash-edit',
                  value: editingText,
                  maxLength: 80,
                  autoFocus: true,
                  onChange: (event) => setEditingText(event.target.value),
                  onBlur: () => commitTitle(row.id),
                  onKeyDown: (event) => {
                    if (imeComposing(event)) return
                    if (event.key === 'Enter') commitTitle(row.id)
                    if (event.key === 'Escape') setEditingId(null)
                  },
                })
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'tdash-title',
                    title: t('action.edit'),
                    onClick: () => {
                      setEditingId(row.id)
                      setEditingText(row.title)
                    },
                  },
                  row.title === '' ? t('untitled') : row.title,
                )

          const done = row.status === 'done'
          const tail = h(
            'div',
            { className: 'tdash-handle' },
            h('button', { type: 'button', className: 'tdash-handle-btn', 'data-tip': t('tip.quote'), 'aria-label': t('tip.quote'), onClick: () => insertIntoCurrent(row) }, t('action.insertHere')),
            h('button', { type: 'button', className: 'tdash-handle-btn', 'data-tip': t('tip.brief'), 'aria-label': t('tip.brief'), onClick: () => void insertBriefIntoCurrent(row) }, t('action.insertBrief')),
            h('button', { type: 'button', className: 'tdash-handle-btn', 'data-tip': t('tip.newSession'), 'aria-label': t('tip.newSession'), onClick: () => void startSessionFor(row) }, t('action.newSession')),
          )

          return h(
            'div',
            {
              key: row.id,
              className: 'tdash-card',
              'data-row-id': row.id,
              'data-kind': row.kind,
              'data-status': row.status,
              'data-dragging': draggingId === row.id ? 'true' : 'false',
              draggable: true,
              onDragStart: (event) => beginDrag(row, event),
              onDragEnd: finishDrag,
            },
            dropLine === null ? null : h('span', { className: 'tdash-drop-line', 'data-position': dropLine, 'aria-hidden': 'true' }),
            h(
              'div',
              { className: 'tdash-row1' },
              h('button', {
                type: 'button',
                className: 'tdash-radio',
                role: 'radio',
                'aria-checked': done ? 'true' : 'false',
                'data-done': done ? 'true' : 'false',
                'data-dropped': row.status === 'dropped' ? 'true' : 'false',
                title: t('action.toggleDone'),
                onClick: (event) => {
                  moveCardToView(event.currentTarget, row.id, done ? 'open' : 'done')
                },
              }),
              h('span', { className: 'tdash-kindtag' }, t(KIND_LABEL[row.kind])),
              row.label === null || row.label === undefined ? null : h('span', { className: 'tdash-no' }, `#${row.label}`),
              row.status === 'doing' ? h('span', { className: 'tdash-doing' }, t('action.doing')) : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'tdash-icon tdash-topx',
                  title: t('action.delete'),
                  onClick: () => setPendingDelete(pendingDelete === row.id ? null : row.id),
                },
                h('span', { className: 'tdash-x' }, '×'),
              ),
            ),
            h(
              'div',
              { className: 'tdash-titlerow' },
              titleNode,
            ),
            row.nextStep === '' ? null : h('div', { className: 'tdash-next' }, row.nextStep),
            h(
              'div',
              { className: 'tdash-footrow' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'tdash-icon tdash-expand',
                  title: t(expanded[row.id] === true ? 'action.collapse' : 'action.expand'),
                  'aria-expanded': expanded[row.id] === true ? 'true' : 'false',
                  onClick: () => toggleDetail(row.id),
                },
                h('span', { className: 'tdash-chevron', 'data-open': expanded[row.id] === true ? 'true' : 'false' }),
              ),
              meta.length === 0 ? null : h('span', { className: 'tdash-metainline' }, meta.join(' · ')),
              h('span', { className: 'tdash-spacer' }),
              tail,
            ),
            pendingDelete === row.id
              ? h(
                  'div',
                  { className: 'tdash-popover' },
                  h('button', { type: 'button', className: 'tdash-del', 'data-danger': 'true', onClick: () => removeRow(row.id) }, t('action.delete')),
                  h('button', { type: 'button', className: 'tdash-del', onClick: () => archiveRow(row.id) }, t('action.archive')),
                  h('button', { type: 'button', className: 'tdash-del', onClick: () => setPendingDelete(null) }, t('action.cancel')),
                )
              : null,
            expanded[row.id] === true ? detailBody(row) : null,
          )
        }

        let body
        if (phase === 'error' && rows.length === 0) {
          body = h(
            'div',
            { className: 'tdash-state' },
            h('div', { className: 'tdash-state-title' }, t('state.error')),
            h('div', null, errorText),
            h('button', { type: 'button', className: 'tdash-btn', onClick: () => void load() }, t('state.retry')),
          )
        } else if (phase === 'loading' && rows.length === 0) {
          body = h('div', { className: 'tdash-state' }, t('state.loading'))
        } else if (shown.length === 0) {
          body = h(
            'div',
            { className: 'tdash-state' },
            h('div', { className: 'tdash-state-title' }, t('empty.title')),
            h('div', null, t('empty.hint')),
          )
        } else {
          const dragFrom = draggingId === null ? -1 : shownSorted.findIndex((row) => row.id === draggingId)
          const showLine = draggingId !== null && dropIndex !== null && dropIndex !== dragFrom && dropIndex !== dragFrom + 1
          body = shownSorted.map((row, index) => {
            if (!showLine) return card(row)
            if (index === dropIndex) return card(row, 'before')
            if (dropIndex === shownSorted.length && index === shownSorted.length - 1) return card(row, 'after')
            return card(row)
          })
        }

        return h(
          'div',
          { className: 'tdash-root' },
          head,
          viewRow,
          h(
            'div',
            {
              className: 'tdash-body',
              onDragOver: dragOverBody,
              onDrop: dropOnBody,
            },
            errorText !== '' && phase !== 'error' ? h('div', { className: 'tdash-err' }, errorText) : null,
            helpOpen
              ? h(
                  'div',
                  { className: 'tdash-help' },
                  h(
                    'div',
                    { className: 'tdash-help-head' },
                    h('span', { className: 'tdash-help-title' }, t('help.title')),
                    h('button', { type: 'button', className: 'tdash-del', onClick: () => setHelpOpen(false) }, t('help.close')),
                  ),
                  h('div', { className: 'tdash-help-body' }, t('help.body')),
                )
              : null,
            formRow,
            rulesRow,
            body,
          ),
        )
      }

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: ID,
            kind: ID,
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [
              {
                id: ID,
                order: 40,
                title: () => t('tab.title'),
                description: () => t('tab.description'),
              },
            ],
          }),
        'todo-assistant: tab type',
      )

      /** Never leave a blank pane: surface a render failure inside the tab. */
      class TodoBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error) {
          console.error('todo-assistant: render failed', error)
        }

        render() {
          if (this.state.error === null) return this.props.children
          const text = this.state.error !== null && typeof this.state.error.message === 'string' ? this.state.error.message : String(this.state.error)
          return h(
            'div',
            { className: 'tdash-root' },
            h('div', { className: 'tdash-err', style: { margin: '8px' } }, `todo-assistant: ${text}`),
          )
        }
      }

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, function TodoTab(props) {
          return h(TodoBoundary, null, h(TodoPanel, props))
        }),
      )

      // §6.2 B: one action on every finalized assistant message, and the panel
      // that collects the paragraphs the developer picks.
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'todo-assistant-capture', order: 20, label: () => t('capture.action') },
          function TodoCaptureAction(props) {
            return h(TodoBoundary, null, h(CaptureAction, props))
          },
        ),
      )
      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          { name: 'conversation.input.overlay', id: 'todo-assistant-marker', order: 50 },
          function TodoMarkerCompletion(props) {
            return h(TodoBoundary, null, h(MarkerCompletion, props))
          },
        ),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'todo-assistant-capture', order: 100 }, function TodoCaptureOverlay() {
          return h(TodoBoundary, null, h(CaptureOverlay))
        }),
      )
    }

    return { inject, apply }
  },
})
