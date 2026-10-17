/**
 * Headless verification of DESIGN.md §10.2 — registering a custom storage domain.
 *
 * This runs the **real** composition pieces out of the local DSH installation:
 * the storage hub, the JSON backend, and the storage-domain facility. It opens
 * the `todo-assistant` domain declared by `domain.js`, drives every wire endpoint
 * through `api.js`, closes and reopens the domain to prove durability, and
 * asserts the facility's single-open rule.
 *
 * The second half builds the real `todo_add` definition with the installation's
 * `defineTool` and a fake agent session, so the capture form (limits, origin,
 * git coordinates, park ids) is proven without a running model.
 *
 * It does not load the plugin through the profile (no `install_bundle`), so it
 * proves the spec/record/API contract, not the peer-dependency resolution of the
 * installed package; that is checked live after installation.
 *
 * Usage: node scripts/verify-domain.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { createTodoSpec, labelOf } from '../domain.js'
import { readCodeCoordinates } from '../git.js'
import { createTodoAddTool, createTodoListTool, createTodoNoteTool, createTodoReadTool, createTodoRecallTool, createTodoStatusTool } from '../tool.js'
import { createDetector, filesFromToolCall, matchingPath, normalizePath, reminderLine } from '../detect.js'
import { createMarkerQueue, extractTodoBlocks, messageText } from '../marker.js'
import { findDuplicate, titleSimilarity } from '../dedupe.js'
import { createRecall } from '../recall.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')

/** Import one installation package by its resolved entry file. */
const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)

let checks = 0
let failures = 0

/**
 * Assert that one tool result matches its declared output schema surface: every
 * returned key is declared (the schema is closed), and every required key exists.
 * This is the cheap structural half of the runtime's output validation.
 */
function checkOutput(tool, value, label) {
  const properties = tool.output.schema.properties ?? {}
  const declared = new Set(Object.keys(properties))
  const extra = Object.keys(value).filter((key) => !declared.has(key))
  const required = tool.output.schema.required ?? []
  const missing = required.filter((key) => !(key in value))
  check(`${label}: output stays inside its schema`, extra.length === 0 && missing.length === 0, `extra=${extra.join(',')} missing=${missing.join(',')}`)
}

/** Assert one expectation and report both outcomes. */
function check(label, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Assert strict equality with a readable detail. */
function checkEqual(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

/** Call one wire endpoint and unwrap it, failing the run on a wire error. */
async function call(api, endpoint, payload) {
  const result = await api.handle(endpoint, payload)
  if (result.ok !== true) throw new Error(`${endpoint} failed: ${result.error.code} ${result.error.message}`)
  return result.value
}

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)

  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-verify-'))
  console.log(`temp storage root: ${root}`)

  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    console.log('\n§10.2 domain declaration and open')
    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    checkEqual('domain name', spec.name, 'todo_assistant')
    checkEqual('declared tables', Object.keys(spec.tables), ['todos', 'rules'])

    const domain = await ctx.storageDomain.open(spec)
    check('open() returns a handle with a todos table', domain != null && domain.table('todos') != null)

    // The facility enforces one open handle per domain name.
    let duplicateCode = 'none'
    try {
      await ctx.storageDomain.open(spec)
    } catch (error) {
      duplicateCode = error?.code ?? error?.message ?? 'unknown'
    }
    checkEqual('second open of the same name is rejected', duplicateCode, 'already-open')

    // A sibling domain name (the shipped `workspace` domain uses its own name)
    // does not collide with ours.
    check('no other domain answers to todo-assistant', ctx.storageDomain.get('todo_assistant') === domain)

    console.log('\nwire surface over a live domain')
    const store = createStore(domain)
    const api = createApi({ store })

    const empty = await call(api, 'list', { workspace: '/tmp/repo-a' })
    checkEqual('list of an unknown workspace is empty', empty.items, [])

    const created = await call(api, 'create', {
      workspace: '/tmp/repo-a',
      title: '鉴权 token 刷新后 401',
      kind: 'defect',
      nextStep: '检查 refresh 是否带 rotation',
      sessionId: 'sess-verify',
      touchedFiles: ['src/auth/router.ts'],
    })
    check('create returns a td_ id', /^td_[a-z0-9]{4}$/u.test(created.item.id), created.item.id)
    checkEqual('new card starts open', created.item.status, 'open')
    checkEqual('workspace is recorded', created.item.workspace, '/tmp/repo-a')
    checkEqual('session from the tab is recorded as origin', created.item.origin?.sessionId, 'sess-verify')

    const idea = await call(api, 'create', {
      workspace: 'inbox',
      title: '支持批量导入',
      kind: 'idea',
      nextStep: '先验证解析性能',
    })

    checkEqual('workspace list is isolated', (await call(api, 'list', { workspace: '/tmp/repo-a' })).items.length, 1)
    checkEqual('inbox list is isolated', (await call(api, 'list', { workspace: 'inbox' })).items.length, 1)
    checkEqual('all-buckets list sees both', (await call(api, 'list', { all: true })).items.length, 2)

    const patched = await call(api, 'patch', { id: idea.item.id, patch: { title: '支持批量导入 CSV', status: 'doing' } })
    checkEqual('patch updates title and status', [patched.item.title, patched.item.status], ['支持批量导入 CSV', 'doing'])

    const noted = await call(api, 'note.add', { id: idea.item.id, text: '解析器在 1M 行时超时', kind: 'evidence', fromSession: 'sess-verify', turn: 3 })
    checkEqual('note append keeps one note', noted.item.notesCount, 1)
    const noteless = await call(api, 'note.remove', { id: idea.item.id, index: 0 })
    checkEqual('note removal leaves none', noteless.item.notesCount, 0)

    const rejected = await api.handle('create', { workspace: '/tmp/repo-a', title: '   ', kind: 'defect' })
    checkEqual('blank title is refused with a stable code', rejected.error?.code, 'todo/title-required')
    const unknown = await api.handle('nope', {})
    checkEqual('unknown endpoint is refused', unknown.error?.code, 'todo/unknown-endpoint')

    const removed = await call(api, 'remove', { id: created.item.id })
    checkEqual('remove answers the id', removed.id, created.item.id)
    checkEqual('list after remove keeps the other card', (await call(api, 'list', { all: true })).items.length, 1)

    console.log('\nmarkers (#DB … #/db)')
    checkEqual('a simple block is extracted', extractTodoBlocks('看这个 #DB 导出表头重复 #/db 然后继续'), ['导出表头重复'])
    checkEqual('the end marker is optional', extractTodoBlocks('#DB 导出表头重复\n还有第二行'), ['导出表头重复\n还有第二行'])
    checkEqual('the markers are case-insensitive', extractTodoBlocks('#dB 修复登录 #/dB'), ['修复登录'])
    checkEqual('code fences are skipped', extractTodoBlocks('例子：\n```\n#DB 不应命中 #/db\n```\n真的 #DB 要这个 #/db'), ['要这个'])
    checkEqual('inline code is skipped', extractTodoBlocks('写成 `#DB 例子 #/db` 就行，实际 #DB 记这个 #/db'), ['记这个'])
    checkEqual(
      'multiple blocks are extracted in order',
      extractTodoBlocks('#DB 第一件 #/db 中间 #DB 第二件 #/db'),
      ['第一件', '第二件'],
    )
    checkEqual('the #memo alias works', extractTodoBlocks('笔记 #MEMO 周三要交表 #/MEMO'), ['周三要交表'])
    checkEqual('the end markers are interchangeable', extractTodoBlocks('#db 混用结束标记 #/memo'), ['混用结束标记'])
    checkEqual('#dbx is not a marker', extractTodoBlocks('#dbx 不算 #/db'), [])
    checkEqual('no marker yields nothing', extractTodoBlocks('普通消息，没有标记'), [])
    checkEqual('a marker inside a word does not match', extractTodoBlocks('abc#DB 不算 #/db'), [])
    checkEqual('a marker after punctuation matches', extractTodoBlocks('两条：#db 第一段 #/db 和第二段'), ['第一段'])
    checkEqual(
      'a quoted end marker inside the block does not close it early',
      extractTodoBlocks('先看：#db\n应该自动补全对应的“#/db”，然后把光标放中间\n#/db'),
      ['应该自动补全对应的“#/db”，然后把光标放中间'],
    )
    checkEqual('an empty block is dropped', extractTodoBlocks('#DB #/db'), [])
    const queue = createMarkerQueue()
    check('queueing reports a hit', queue.onUserMessage('sess-marker', '#DB 记这个 #/db', 'msg-1') === true, '')
    check('the same claim is not queued twice', queue.onUserMessage('sess-marker', '#DB 记这个 #/db', 'msg-1') === false, '')
    checkEqual('the queue drains once', [queue.take('sess-marker').length, queue.take('sess-marker').length], [1, 0])
    queue.onUserMessage('sess-marker', '#DB 记这个 #/db')
    queue.forget('sess-marker')
    checkEqual('forget clears the queue', [queue.take('sess-marker').length, queue.size], [0, 0])
    checkEqual(
      'message text joins text blocks only',
      messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image', ref: 'x' }, { type: 'text', text: 'b' }] }),
      'a\nb',
    )

    console.log('\nrules per workspace')
    const rulesA = await call(api, 'rules.set', { workspace: '/tmp/repo-a', text: '积极提问\n一次只做一件事' })
    checkEqual('rules round-trip the text', rulesA.text, '积极提问\n一次只做一件事')
    checkEqual('rules read back by workspace', (await call(api, 'rules.get', { workspace: '/tmp/repo-a' })).text, rulesA.text)
    checkEqual('another workspace has no rules', (await call(api, 'rules.get', { workspace: '/tmp/repo-b' })).text, '')
    await call(api, 'rules.set', { workspace: '/tmp/repo-a', text: '  ' })
    checkEqual('blank text clears the rules', (await call(api, 'rules.get', { workspace: '/tmp/repo-a' })).text, '')
    try {
      await call(api, 'rules.set', { workspace: '', text: 'x' })
      check('an empty workspace is refused', false, 'no rejection')
    } catch (error) {
      check('an empty workspace is refused', String(error.message).includes('todo/workspace-required'), error.message)
    }

    console.log('\nM2 capture form (todo_add)')
    const tool = createTodoAddTool({
      defineTool,
      store,
      now: () => 1_800_000_000_000,
      readGit: async () => ({ commit: 'c0ffee1234', branch: 'main', symbols: [] }),
      resolveWorkspace: async (cwd) => (cwd === '' ? 'inbox' : cwd),
    })
    checkEqual('tool name', tool.name, 'todo_add')
    check('tool demands consent in its description', tool.description.includes('explicitly agreed'), tool.description)
    check('tool forbids self-driven read-back', tool.description.includes('never read it back on your own'), '')
    checkEqual('required parameters', tool.parameters.required, ['title', 'kind', 'nextStep', 'touchedFiles', 'mustRead'])

    const sequence = [
      { type: 'turn/start', seq: 4, data: { turn: 3 } },
      { type: 'user/message', seq: 5, data: {} },
      { type: 'tool/result', seq: 9, data: {} },
    ]
    const session = {
      header: { cwd: '/tmp/repo-a' },
      seq: 10,
      snapshotEvents: () => sequence,
    }
    const exec = { agent: { id: 'sess-tool', session }, signal: new AbortController().signal, callId: 'call-1' }

    const captured = await tool.execute(
      {
        title: '刷新 token 后 401',
        kind: 'defect',
        nextStep: '检查 rotation 是否带上了',
        symptom: '刷新后下一个请求 401',
        touchedFiles: ['src/auth/router.ts', 'src/auth/router.ts', 'src/auth/refresh.ts'],
        mustRead: [
          { label: 'refresh 实现', text: 'refresh() 直接返回旧 token', where: { file: 'src/auth/refresh.ts', seqRange: [5, 9] } },
          { label: '调用点', text: 'router.ts:88 没有 await rotate()' },
        ],
        park: [{ label: 'auth 测试夹具', why: '可能也要改 mock' }],
        symbols: [{ file: 'src/auth/refresh.ts', symbol: 'refresh', line: 30 }],
      },
      exec,
    )
    const stored = store.get(captured.id)
    check('capture stores the card', stored !== undefined && stored.title === '刷新 token 后 401')
    checkEqual('origin turn and range', [stored.origin.turn, stored.origin.seqRange], [3, [4, 9]])
    checkEqual('origin session and cwd', [stored.origin.sessionId, stored.origin.cwd], ['sess-tool', '/tmp/repo-a'])
    checkEqual('git coordinates filled host-side', [stored.code.commit, stored.code.branch], ['c0ffee1234', 'main'])
    checkEqual('model symbols kept next to the commit', stored.code.symbols, [{ file: 'src/auth/refresh.ts', symbol: 'refresh', line: 30 }])
    checkEqual('touched files deduplicated', stored.touchedFiles, ['src/auth/router.ts', 'src/auth/refresh.ts'])
    checkEqual('park ids are stable', stored.park.map((item) => item.id), ['p1'])
    checkEqual('mustRead where kept', stored.mustRead[0].where, { file: 'src/auth/refresh.ts', seqRange: [5, 9] })
    checkEqual('capture output counts', [captured.status, captured.mustRead, captured.park, captured.warnings], ['created', 2, 1, []])
    checkOutput(tool, captured, 'todo_add created')
    console.log('\nlabels (major.minor)')
    const labelled = store.all().map((card) => labelOf(card).label)
    check('every card has a label', labelled.every((value) => typeof value === 'string' && /^\d+\.\d+$/u.test(value)), JSON.stringify(labelled))
    check('labels are unique', new Set(labelled).size === labelled.length, JSON.stringify(labelled))
    const cardLabel = labelOf(store.get(captured.id)).label
    checkEqual('a bare label resolves the card', store.findRef(cardLabel)?.id, captured.id)
    checkEqual('a #label also resolves', store.findRef(`#${cardLabel}`)?.id, captured.id)
    checkEqual('the internal id still resolves', store.findRef(captured.id)?.id, captured.id)
    checkEqual('an unknown label resolves to nothing', store.findRef('99.99'), undefined)

    const [cardMajor, cardMinor] = cardLabel.split('.').map(Number)
    const sibling = await store.create(
      { workspace: '/tmp/repo-a', title: 'sibling in the same session', kind: 'idea', sessionId: 'sess-tool', rootSessionId: 'sess-tool' },
      () => 1_800_000_100_000,
    )
    checkEqual('the same root session reuses the major and bumps the minor', labelOf(sibling).label, `${cardMajor}.${cardMinor + 1}`)
    const otherSessionCard = await store.create(
      { workspace: '/tmp/repo-a', title: 'another session', kind: 'idea', sessionId: 'sess-other', rootSessionId: 'sess-other' },
      () => 1_800_000_100_100,
    )
    checkEqual('a different root session opens a new major at .1', labelOf(otherSessionCard).label, `${cardMajor + 1}.1`)
    const sessionless = await store.create({ workspace: '/tmp/repo-a', title: 'no session', kind: 'idea' }, () => 1_800_000_100_200)
    checkEqual('a session-less card gets a new major and minor 0', labelOf(sessionless).label, `${cardMajor + 2}.0`)
    await store.remove(sibling.id)
    await store.remove(otherSessionCard.id)
    await store.remove(sessionless.id)

    const legacy = { ...store.get(captured.id), id: 'td_legacy', title: 'legacy card', number: 7 }
    delete legacy.major
    delete legacy.minor
    await domain.table('todos').put('td_legacy', legacy)
    const migratedCount = await store.migrateLabels()
    checkEqual('a legacy number migrates to 1.x', labelOf(store.get('td_legacy')).label, '1.7')
    check('migration reports the migrated record', migratedCount === 1, String(migratedCount))
    await domain.table('todos').delete('td_legacy')

    console.log('\nverbatim developer request')
    const requestSession = {
      id: 'sess-tool',
      header: { cwd: '/tmp/repo-a' },
      seq: 12,
      snapshotEvents: () => [
        { type: 'turn/start', seq: 4, data: { turn: 3 } },
        {
          type: 'user/message',
          seq: 5,
          data: { id: 'msg-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我记一下：导出 CSV 时表头重复\n第二行是补充' }] },
        },
        {
          type: 'user/message',
          seq: 6,
          data: { id: 'msg-2', role: 'user', source: { kind: 'file-change' }, content: [{ type: 'text', text: '3 个文件已变更' }] },
        },
      ],
    }
    const requestExec = { agent: { id: 'sess-tool', session: requestSession } }
    const withRequest = await tool.execute(
      { title: '导出 CSV 表头重复', kind: 'defect', nextStep: '查 header 写出逻辑', touchedFiles: ['src/export/csv.ts'], mustRead: [] },
      requestExec,
    )
    const storedRequest = store.get(withRequest.id).request
    checkEqual('the human message is stored verbatim', storedRequest.text, '帮我记一下：导出 CSV 时表头重复\n第二行是补充')
    check('synthetic injections are skipped', !storedRequest.text.includes('3 个文件已变更'), storedRequest.text)
    checkEqual('the request records its turn', storedRequest.turn, 3)
    checkEqual('manual cards carry no request', store.get(created.item.id)?.request, undefined)

    console.log('\nmarked blocks become the request')
    const markerSession = {
      id: 'sess-tool',
      header: { cwd: '/tmp/repo-a' },
      seq: 14,
      snapshotEvents: () => [
        { type: 'turn/start', seq: 4, data: { turn: 4 } },
        {
          type: 'user/message',
          seq: 5,
          data: {
            id: 'msg-blocks',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: '两条：#db 第一段内容 #/db 与 #db 第二段内容 #/db' }],
          },
        },
      ],
    }
    const markerExec = { agent: { id: 'sess-tool', session: markerSession } }
    const firstBlock = await tool.execute(
      { title: '标记第一段', kind: 'idea', nextStep: 'n1', touchedFiles: ['src/a/one.ts'], mustRead: [] },
      markerExec,
    )
    const secondBlock = await tool.execute(
      { title: '标记第二段', kind: 'idea', nextStep: 'n2', touchedFiles: ['src/a/two.ts'], mustRead: [] },
      markerExec,
    )
    checkEqual('the first capture takes the first block', store.get(firstBlock.id).request.text, '第一段内容')
    checkEqual('the second capture takes the second block', store.get(secondBlock.id).request.text, '第二段内容')
    checkEqual('blocks record their index', [store.get(firstBlock.id).request.block, store.get(secondBlock.id).request.block], [0, 1])
    check('markers never appear in the request', !store.get(firstBlock.id).request.text.includes('#db'), store.get(firstBlock.id).request.text)
    await call(api, 'patch', { id: store.get(firstBlock.id).id, patch: { request: { text: '修正后的原话' } } })
    checkEqual('patch can repair the request text', store.get(firstBlock.id).request.text, '修正后的原话')
    checkEqual('the repair keeps the captured turn', store.get(firstBlock.id).request.turn, 4)

    console.log('\npath normalization')
    const absolute = await tool.execute(
      {
        title: '绝对路径归一化',
        kind: 'defect',
        nextStep: 'n',
        touchedFiles: ['/tmp/repo-a/src/abs/one.ts', './src/rel/two.ts', 'src/rel/two.ts'],
        symbols: [{ file: '/tmp/repo-a/src/abs/one.ts', symbol: 'refresh' }],
        mustRead: [],
      },
      exec,
    )
    checkEqual('absolute and ./-prefixed paths normalize on write', store.get(absolute.id).touchedFiles, [
      'src/abs/one.ts',
      'src/rel/two.ts',
    ])
    checkEqual('symbols carry the normalized file', store.get(absolute.id).code.symbols[0].file, 'src/abs/one.ts')
    const again = await tool.execute(
      { title: '绝对路径归一化（重复）', kind: 'defect', nextStep: 'n', touchedFiles: ['/tmp/repo-a/src/abs/one.ts'], mustRead: [] },
      exec,
    )
    checkEqual('the same file written differently still dedupes', again.status, 'duplicate')

    const emptyFiles = await tool.execute(
      { title: '想法：批量导入', kind: 'idea', nextStep: '先量一下 1M 行解析耗时', touchedFiles: [], mustRead: [] },
      exec,
    )
    check('empty touchedFiles only warns', emptyFiles.warnings.length === 1 && emptyFiles.status === 'created', JSON.stringify(emptyFiles))

    async function rejects(label, args, code) {
      try {
        await tool.execute(args, exec)
        check(label, false, 'no rejection')
      } catch (error) {
        check(label, error.code === code, `got ${error.code}: ${error.message}`)
      }
    }
    const base = { kind: 'defect', nextStep: 'next', touchedFiles: [], mustRead: [] }
    await rejects('title over 40 characters is rejected', { ...base, title: '一'.repeat(41) }, 'todo/title-too-long')
    await rejects('missing title is rejected', { ...base, title: '   ' }, 'todo/title-required')
    try {
      await tool.execute({ ...base, title: 'x', kind: 'bug' }, exec)
      check('unknown kind is rejected at the schema boundary', false, 'no rejection')
    } catch (error) {
      check('unknown kind is rejected at the schema boundary', /kind/u.test(error.message), `${error.code}: ${error.message}`)
    }
    await rejects('empty nextStep is rejected', { ...base, title: 'x', nextStep: '' }, 'todo/next-step-required')
    await rejects(
      'four mustRead items are rejected',
      { ...base, title: 'x', mustRead: Array.from({ length: 4 }, (_, i) => ({ label: `l${i}`, text: 't' })) },
      'todo/too-many-must-read',
    )
    await rejects(
      'mustRead text over 200 characters is rejected',
      { ...base, title: 'x', mustRead: [{ label: 'l', text: '字'.repeat(201) }] },
      'todo/must-read-too-long',
    )
    await rejects(
      'park label over 30 characters is rejected',
      { ...base, title: 'x', park: [{ label: '标'.repeat(31), why: 'w' }] },
      'todo/park-label-too-long',
    )
    await rejects(
      'park why over 60 characters is rejected',
      { ...base, title: 'x', park: [{ label: 'l', why: '因'.repeat(61) }] },
      'todo/park-why-too-long',
    )

    console.log('\nM3 read / note / list')
    const readTool = createTodoReadTool({ defineTool, store })
    const noteTool = createTodoNoteTool({ defineTool, store, now: () => 1_800_000_500_000 })
    const listTool = createTodoListTool({ defineTool, store, resolveWorkspace: async (cwd) => (cwd === '' ? 'inbox' : cwd) })

    const card = await readTool.execute({ id: captured.id }, exec)
    checkEqual('read returns the card shape', card.shape, 'card')
    checkEqual('read keeps core fields', [card.core.nextStep, card.core.symptom], ['检查 rotation 是否带上了', '刷新后下一个请求 401'])
    checkEqual('read returns mustRead bodies', card.mustRead.map((item) => item.label), ['refresh 实现', '调用点'])
    checkEqual('read returns park labels without pointers', Object.keys(card.park[0]).sort(), ['label', 'why'])
    checkEqual('read returns code coordinates', [card.code.commit, card.code.branch], ['c0ffee1234', 'main'])
    checkEqual('read reports the note count', card.notesCount, 0)
    checkOutput(readTool, card, 'todo_read card')
    const readWithRequest = await readTool.execute({ id: withRequest.id }, exec)
    checkEqual('todo_read returns the verbatim request', readWithRequest.request.text, storedRequest.text)
    checkOutput(readTool, readWithRequest, 'todo_read with request')
    checkOutput(readTool, await readTool.execute({ id: captured.id, part: 'notes' }, exec), 'todo_read notes')
    checkOutput(readTool, await readTool.execute({ id: captured.id, part: 'park:1' }, exec), 'todo_read park')

    const notesShape = await readTool.execute({ id: captured.id, part: 'notes' }, exec)
    checkEqual('read notes shape is empty before any note', [notesShape.shape, notesShape.notesCount], ['notes', 0])
    const parkShape = await readTool.execute({ id: captured.id, part: 'park:1' }, exec)
    checkEqual('park pointer includes where', [parkShape.shape, parkShape.index, parkShape.pointer.label], ['park', 1, 'auth 测试夹具'])
    async function readRejects(label, args, code) {
      try {
        await readTool.execute(args, exec)
        check(label, false, 'no rejection')
      } catch (error) {
        check(label, error.code === code, `got ${error.code}: ${error.message}`)
      }
    }
    await readRejects('unknown card is rejected', { id: 'td_nope' }, 'todo/not-found')
    await readRejects('park out of range is rejected', { id: captured.id, part: 'park:9' }, 'todo/park-missing')
    await readRejects('unknown part is rejected', { id: captured.id, part: 'body' }, 'todo/invalid-part')

    const appended = await noteTool.execute({ id: captured.id, text: '其实 rotate() 是异步的', kind: 'evidence' }, exec)
    checkOutput(noteTool, appended, 'todo_note')
    checkEqual('note appends with the session turn', [appended.notesCount, appended.kind], [1, 'evidence'])
    const storedNote = store.get(captured.id).notes[0]
    checkEqual('note records its source session', [storedNote.fromSession, storedNote.turn], ['sess-tool', 3])
    const notesAfter = await readTool.execute({ id: captured.id, part: 'notes' }, exec)
    checkEqual('notes are readable in order', notesAfter.notes.map((note) => note.text), ['其实 rotate() 是异步的'])
    try {
      await noteTool.execute({ id: captured.id, text: '字'.repeat(301) }, exec)
      check('note over 300 characters is rejected', false, 'no rejection')
    } catch (error) {
      check('note over 300 characters is rejected', error.code === 'todo/note-too-long', `got ${error.code}: ${error.message}`)
    }

    const activeList = await listTool.execute({}, exec)
    checkOutput(listTool, activeList, 'todo_list')
    check('list defaults to this workspace and active cards', activeList.workspace === '/tmp/repo-a' && activeList.items.some((item) => item.id === captured.id), JSON.stringify(activeList))
    checkEqual('list returns only the index fields', Object.keys(activeList.items[0]).sort(), ['id', 'kind', 'label', 'status', 'title'])
    const doneOnly = await listTool.execute({ workspace: '/tmp/repo-a', status: 'done' }, exec)
    checkEqual('list filters by status', doneOnly.total, 0)
    const everyWorkspace = await listTool.execute({ workspace: '*' }, exec)
    check('list with * spans workspaces', everyWorkspace.total >= 2, JSON.stringify(everyWorkspace))

    console.log('\nM4 path matching and the reminder detector')
    checkEqual('absolute paths relativize against the cwd', normalizePath('/tmp/repo-a/src/auth/x.ts', '/tmp/repo-a'), 'src/auth/x.ts')
    checkEqual('dot segments and backslashes normalize', normalizePath('.\\src\\auth\\x.ts', ''), 'src/auth/x.ts')
    checkEqual('a path outside the cwd stays absolute', normalizePath('/other/src/x.ts', '/tmp/repo-a'), '/other/src/x.ts')
    checkEqual(
      'read/edit/grep arguments yield paths',
      [
        filesFromToolCall('read', JSON.stringify({ file_path: 'src/a.ts' }), ''),
        filesFromToolCall('edit', JSON.stringify({ file_path: 'src/b.ts', old_string: 'x' }), ''),
        filesFromToolCall('grep', JSON.stringify({ pattern: 'x', path: 'src/auth' }), ''),
      ],
      [['src/a.ts'], ['src/b.ts'], ['src/auth']],
    )
    checkEqual('unknown tool and bad JSON yield nothing', [filesFromToolCall('bash', '{"command":"ls"}', ''), filesFromToolCall('read', 'not-json', '')], [[], []])

    const matchCard = { id: 'td_m1', title: 't', touchedFiles: ['src/auth/router.ts'] }
    checkEqual('exact file match', matchingPath(matchCard, ['src/auth/router.ts']), 'src/auth/router.ts')
    checkEqual('two shared directory segments match', matchingPath(matchCard, ['src/auth/token.ts']), 'src/auth/token.ts')
    checkEqual('one shared segment does not match', matchingPath(matchCard, ['src/ui/token.ts']), undefined)
    checkEqual('a searched directory matches its files', matchingPath(matchCard, ['src/auth']), 'src/auth')
    checkEqual('a single-segment directory does not match', matchingPath(matchCard, ['src']), undefined)
    check('a reminder line names the card and the file', reminderLine({ cardId: 'td_m1', title: '刷新 token', file: 'src/auth/router.ts' }).includes('#td_m1'), '')

    const detector = createDetector({ store, now: () => 1_800_000_900_000 })
    const fakeSession = { id: 'sess-tool', header: { cwd: '/tmp/repo-a' } }
    const feed = (event) => detector.onSessionEvent(fakeSession, event)
    feed({ type: 'turn/start', seq: 20, data: { turn: 4 } })
    feed({ type: 'tool/call', seq: 21, data: { turn: 4, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: '/tmp/repo-a/src/auth/router.ts' }) } })
    feed({ type: 'step/end', seq: 22, data: { turn: 4, step: 1 } })
    const firstReminder = detector.takeReminder('sess-tool')
    const capturedLabel = labelOf(store.get(captured.id)).label
    check(
      'a matching edit produces one reminder line',
      firstReminder.includes('src/auth/router.ts') && firstReminder.includes(`#${capturedLabel}`),
      firstReminder,
    )
    checkEqual('the reminder is consumed once', detector.takeReminder('sess-tool'), '')
    check('the badge set survives consumption', detector.hitIds('sess-tool').has(captured.id), JSON.stringify([...detector.hitIds('sess-tool')]))

    feed({ type: 'tool/call', seq: 23, data: { turn: 4, step: 2, callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: '/tmp/repo-a/src/ui/button.tsx' }) } })
    feed({ type: 'step/end', seq: 24, data: { turn: 4, step: 2 } })
    checkEqual('the badge keeps an earlier match in the same turn', detector.hitIds('sess-tool').size, 1)
    checkEqual('the same card is not reminded twice in one turn', detector.takeReminder('sess-tool'), '')
    feed({ type: 'turn/start', seq: 25, data: { turn: 5 } })
    feed({ type: 'tool/call', seq: 26, data: { turn: 5, step: 1, callId: 'c4', name: 'read', arguments: JSON.stringify({ file_path: '/tmp/repo-a/src/ui/button.tsx' }) } })
    feed({ type: 'step/end', seq: 27, data: { turn: 5, step: 1 } })
    checkEqual('the next turn starts with an empty badge', detector.hitIds('sess-tool').size, 0)
    checkEqual('the next turn produces no reminder for unrelated work', detector.takeReminder('sess-tool'), '')

    feed({ type: 'tool/call', seq: 28, data: { turn: 5, step: 2, callId: 'c5', name: 'read', arguments: JSON.stringify({ file_path: '/tmp/repo-a/src/auth/refresh.ts' }) } })
    feed({ type: 'step/end', seq: 29, data: { turn: 5, step: 2 } })
    feed({ type: 'turn/start', seq: 30, data: { turn: 6 } })
    check('pending reminders survive into the next turn', detector.takeReminder('sess-tool').includes(`#${capturedLabel}`), '')
    const otherSession = { id: 'sess-other', header: { cwd: '/tmp/repo-a' } }
    detector.onSessionEvent(otherSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    detector.onSessionEvent(otherSession, { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'x', name: 'edit', arguments: JSON.stringify({ file_path: 'src/auth/router.ts' }) } })
    detector.onSessionEvent(otherSession, { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } })
    checkEqual('cards only match their own session', detector.hitIds('sess-other').size, 0)
    detector.forget('sess-other')
    checkEqual('forget drops the session state', detector.size, 1)

    console.log('\ncompletion (todo_status)')
    const statusTool = createTodoStatusTool({ defineTool, store, now: () => 1_800_000_700_000 })
    const closed = await statusTool.execute({ id: capturedLabel, status: 'done' }, exec)
    checkEqual('status closes the card by label', [closed.status, closed.label], ['done', capturedLabel])
    checkEqual('the store reflects it', store.get(captured.id).status, 'done')
    checkOutput(statusTool, closed, 'todo_status')
    const reopenedCard = await statusTool.execute({ id: captured.id, status: 'doing' }, exec)
    checkEqual('status reopens by id', reopenedCard.status, 'doing')
    const badStatus = await statusTool.execute({ id: capturedLabel, status: 'open' }, exec)
    checkEqual('open is accepted as a status', badStatus.status, 'open')
    try {
      await statusTool.execute({ id: capturedLabel, status: 'nope' }, exec)
      check('an unknown status is rejected', false, 'no rejection')
    } catch (error) {
      check('an unknown status is rejected', /status/u.test(error.message), `${error.code}: ${error.message}`)
    }
    try {
      await statusTool.execute({ id: '99.99', status: 'done' }, exec)
      check('an unknown label is rejected', false, 'no rejection')
    } catch (error) {
      check('an unknown label is rejected', error.code === 'todo/not-found', `${error.code}: ${error.message}`)
    }

    console.log('\nM6 recall (manifest then body)')
    const fakeLog = {
      events: [
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        // `user/message` stores the message AS its data (no `message` wrapper).
        { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: '帮我看看刷新 token 后 401 的问题' }] } },
        { type: 'assistant/message', seq: 3, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先确认 refresh 的实现\n然后看 rotate 调用点' }] } } },
        { type: 'tool/call', seq: 4, data: { turn: 1, step: 1, name: 'read', arguments: '{}' } },
        { type: 'tool/result', seq: 5, data: { turn: 1, message: { role: 'tool', content: [{ type: 'text', text: 'refresh() 直接返回旧 token' }] } } },
        { type: 'turn/start', seq: 6, data: { turn: 2 } },
        { type: 'user/message', seq: 7, data: { role: 'user', content: [{ type: 'text', text: '继续' }] } },
      ],
    }
    const recall = createRecall({
      readSession: async (sessionId) => {
        if (sessionId !== 'sess-recall') throw new Error('unknown session')
        return fakeLog
      },
      estimateTokens: () => 42,
    })
    const recallTool = createTodoRecallTool({ defineTool, store, recall })
    const manifestOrigin = { sessionId: 'sess-recall', turn: 1, seqRange: [1, 5], cwd: '/tmp/repo-a', at: 1 }
    const capturedOriginal = store.get(captured.id)
    await store.put({ ...capturedOriginal, origin: manifestOrigin })
    const manifest = await recallTool.execute({ id: captured.id })
    checkEqual('manifest shape', [manifest.shape, manifest.available, manifest.total], ['manifest', true, 3])
    checkOutput(recallTool, manifest, 'todo_recall manifest')
    checkEqual('manifest lists role, turn and seq', manifest.entries.map((entry) => [entry.seq, entry.role, entry.turn]), [[2, 'user', 1], [3, 'assistant', 1], [5, 'tool', 1]])
    checkEqual('manifest previews the first line', manifest.entries[0].preview, '帮我看看刷新 token 后 401 的问题')
    checkEqual('manifest carries token estimates', manifest.entries[0].tokens, 42)
    checkEqual('manifest sums tokens', manifest.tokens, 126)
    const body = await recallTool.execute({ id: captured.id, slice: [2, 3] })
    checkEqual('body shape and slice', [body.shape, body.slice], ['body', [2, 3]])
    checkOutput(recallTool, body, 'todo_recall body')
    checkEqual('body returns the two messages', body.entries.map((entry) => entry.seq), [2, 3])
    check('body keeps multi-line text', body.entries[1].text.includes('\n'), body.entries[1].text)
    const emptySlice = await recallTool.execute({ id: captured.id, slice: [4, 4] })
    checkEqual('a slice with no messages is unavailable', emptySlice.shape, 'unavailable')
    const noOrigin = await tool.execute({ ...base, title: 'no origin card', kind: 'defect' }, exec)
    const noOriginCard = { ...store.get(noOrigin.id), origin: undefined }
    await store.put(noOriginCard)
    const unavailable = await recallTool.execute({ id: noOrigin.id })
    checkEqual('a card without origin is unavailable', [unavailable.shape, unavailable.available], ['unavailable', false])
    checkOutput(recallTool, unavailable, 'todo_recall unavailable')
    const missing = await recall.manifest({ ...manifestOrigin, sessionId: 'sess-gone' })
    checkEqual('an unreadable session degrades', missing.available, false)
    // Restore the captured card's real origin for the later durability checks.
    await store.put(capturedOriginal)

    console.log('\nM7 duplicate detection')
    check('identical titles are fully similar', titleSimilarity('刷新 token 后 401', '刷新 token 后 401！') > 0.99, '')
    check('unrelated titles are not similar', titleSimilarity('刷新 token 后 401', '支持批量导入 CSV') < 0.2, '')
    const duplicate = await tool.execute(
      { title: '刷新 token 后 401！', kind: 'defect', nextStep: '再查一次', touchedFiles: ['src/auth/router.ts'], mustRead: [] },
      exec,
    )
    checkEqual('a similar card with a shared file is not created twice', [duplicate.status, duplicate.candidateId], ['duplicate', captured.id])
    checkOutput(tool, duplicate, 'todo_add duplicate')
    check('duplicate answer names the shared file', duplicate.sharedFiles.includes('src/auth/router.ts'), JSON.stringify(duplicate))
    checkEqual('the duplicate path stores nothing', store.all().filter((card) => card.title.startsWith('刷新 token 后 401')).length, 1)
    const unrelated = await tool.execute(
      { title: '刷新 token 后 401！', kind: 'defect', nextStep: '再查一次', touchedFiles: ['src/ui/button.tsx'], mustRead: [] },
      exec,
    )
    checkEqual('a shared title alone is not a duplicate', unrelated.status, 'created')
    const noFiles = await tool.execute({ title: '刷新 token 后 401！', kind: 'defect', nextStep: '再查一次', touchedFiles: [], mustRead: [] }, exec)
    checkEqual('empty touchedFiles skips duplicate detection', noFiles.status, 'created')
    const pureHit = findDuplicate(store.all(), { workspace: '/tmp/repo-a', title: '刷新 token 后 401', touchedFiles: ['src/auth/router.ts'] })
    check('findDuplicate works on the store contents', pureHit !== undefined && pureHit.card.id === captured.id, JSON.stringify(pureHit))

    console.log('\nM5 handling binding')
    const handled = await call(api, 'handle', { id: captured.id, sessionId: 'session-handler' })
    checkEqual('handle records the session on the list row', handled.item.handlingSession, 'session-handler')
    const handledRecord = store.get(captured.id)
    checkEqual('handling is durable', [handledRecord.handling.sessionId, typeof handledRecord.handling.at], ['session-handler', 'number'])
    const handledDetail = await call(api, 'detail', { id: captured.id })
    checkEqual('detail carries handling', handledDetail.item.handling.sessionId, 'session-handler')
    const missingSession = await api.handle('handle', { id: captured.id, sessionId: '   ' })
    checkEqual('empty session id is rejected', missingSession.error?.code, 'todo/session-required')

    console.log('\ngit fallback (file reader)')
    const repo = join(root, 'fake-repo')
    await mkdir(join(repo, '.git', 'refs', 'heads'), { recursive: true })
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/topic\n')
    await writeFile(join(repo, '.git', 'refs', 'heads', 'topic'), 'deadbeef\n')
    const packedRepo = join(root, 'packed-repo')
    await mkdir(join(packedRepo, '.git'), { recursive: true })
    await writeFile(join(packedRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(packedRepo, '.git', 'packed-refs'), '# pack-refs with: peeled fully-peeled\nabc123 refs/heads/main\n')
    const detached = join(root, 'detached-repo')
    await mkdir(join(detached, '.git'), { recursive: true })
    await writeFile(join(detached, '.git', 'HEAD'), 'feedface\n')
    checkEqual('loose ref resolves branch and commit', await readCodeCoordinates(repo, undefined), {
      commit: 'deadbeef',
      branch: 'topic',
      symbols: [],
    })
    checkEqual('packed refs are read', await readCodeCoordinates(packedRepo, undefined), { commit: 'abc123', branch: 'main', symbols: [] })
    checkEqual('detached HEAD keeps the commit only', await readCodeCoordinates(detached, undefined), {
      commit: 'feedface',
      branch: '',
      symbols: [],
    })
    checkEqual('a directory without .git degrades quietly', await readCodeCoordinates(root, undefined), {
      commit: '',
      branch: '',
      symbols: [],
    })

    // The preferred path is git through `ctx.subprocess`, not the file reader.
    const calls = []
    const fakeSubprocess = {
      resolveExecutable: async (command) => {
        calls.push(['resolveExecutable', command])
        return '/usr/bin/git'
      },
      spawn: (spec) => {
        calls.push(['spawn', spec.argv.slice(1).join(' '), spec.cwd])
        const stdout = spec.argv.includes('--abbrev-ref') ? 'main\n' : 'abc123\n'
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) } },
        }
      },
    }
    checkEqual('subprocess path reads commit and branch', await readCodeCoordinates('/tmp/repo-a', fakeSubprocess), {
      commit: 'abc123',
      branch: 'main',
      symbols: [],
    })
    checkEqual('both git commands run in the session cwd', calls.slice(1).map((entry) => entry[2]), ['/tmp/repo-a', '/tmp/repo-a'])
    const failingSubprocess = {
      resolveExecutable: async () => '/usr/bin/git',
      spawn: () => ({ done: Promise.resolve({ exitCode: 128, signal: null }), collected: {} }),
    }
    checkEqual(
      'a failing git falls back to the files',
      await readCodeCoordinates(join(root, 'fake-repo'), failingSubprocess),
      { commit: 'deadbeef', branch: 'topic', symbols: [] },
    )

    console.log('\ndurability across close and reopen')
    await domain.close()
    const reopened = await ctx.storageDomain.open(spec)
    const reopenedStore = createStore(reopened)
    const reopenedApi = createApi({ store: reopenedStore })
    const after = await call(reopenedApi, 'list', { all: true })
    const titles = after.items.map((item) => item.title)
    check('manual cards survive reopen', titles.includes('支持批量导入 CSV'), JSON.stringify(titles))
    check('captured cards survive reopen', titles.includes('刷新 token 后 401') && titles.includes('想法：批量导入'), JSON.stringify(titles))
    const editedCard = after.items.find((item) => item.title === '支持批量导入 CSV')
    checkEqual('edited status survives reopen', editedCard?.status, 'doing')
    const capturedRecord = reopenedStore.get(captured.id)
    checkEqual('captured coordinates survive reopen', [capturedRecord?.origin?.turn, capturedRecord?.code?.commit], [3, 'c0ffee1234'])

    const file = await readFile(join(root, 'todo_assistant.json'), 'utf8')
    check('single-layout JSON file is written', file.includes('支持批量导入 CSV'))
    await reopened.close()

    console.log(`\n${checks - failures}/${checks} checks passed`)
  } finally {
    await ctx.registry.delete(Storage)
    await rm(root, { recursive: true, force: true })
  }
}

main().then(
  () => {
    if (failures > 0) process.exitCode = 1
  },
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
