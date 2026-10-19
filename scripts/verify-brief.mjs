/**
 * P0-BASE + T1/T2 offline verification.
 *
 * Drives the real storage-domain/json backend over the checked-in version-1
 * fixture, then exercises TaskBrief normalization, legacy projection, capture,
 * read, patch and persistence without a running model.
 */
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { BRIEF_LIMITS, briefForRecord, briefQuality, normalizeBrief } from '../brief.js'
import { applyPatch, createTodoSpec, projectFull, projectL0 } from '../domain.js'
import { TOOL_DESCRIPTION, createTodoAddTool, createTodoNoteTool, createTodoReadTool } from '../tool.js'
import { findDuplicate } from '../dedupe.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const FIXTURE = new URL('./fixtures/todo_assistant.v1.json', import.meta.url)

const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)

let checks = 0
let failures = 0

function check(label, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function checkEqual(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

function checkOutput(tool, value, label) {
  const properties = tool.output.schema.properties ?? {}
  const declared = new Set(Object.keys(properties))
  const extra = Object.keys(value).filter((key) => !declared.has(key))
  const required = tool.output.schema.required ?? []
  const missing = required.filter((key) => !(key in value))
  check(`${label}: output stays inside its schema`, extra.length === 0 && missing.length === 0, `extra=${extra.join(',')} missing=${missing.join(',')}`)
}

function fakeSession(events = [], seq = 10) {
  return {
    id: 'sess-brief',
    header: { cwd: '/tmp/legacy-repo' },
    seq,
    snapshotEvents: () => events,
  }
}

function execFor(session) {
  return { agent: { id: 'sess-brief', session }, signal: new AbortController().signal, callId: 'call-brief' }
}

const sequence = [
  { type: 'turn/start', seq: 4, data: { turn: 3 } },
  { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把语言删除的问题记一下' }] } },
  { type: 'tool/result', seq: 9, data: {} },
]

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-brief-'))
  console.log(`temp storage root: ${root}`)
  const ctx = new Context()
  try {
    await copyFile(FIXTURE, join(root, 'todo_assistant.json'))
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    checkEqual('domain version remains 1', spec.version, 1)
    const domain = await ctx.storageDomain.open(spec)
    const store = createStore(domain)

    console.log('\nP0-BASE: version-1 fixture compatibility')
    const old = store.get('td_old01')
    check('old card loads from the version-1 fixture', old !== undefined && old.title === '语言列表删除异常')
    checkEqual('old card has no stored brief', old.brief, undefined)
    const oldFull = projectFull(old)
    checkEqual('old card projects a derived brief', oldFull.briefSource, 'derived')
    checkEqual('derived goal comes from core.symptom', oldFull.brief.goal, '删除最后一种语言时列表异常')
    checkEqual('derived nextAction comes from core.nextStep', oldFull.brief.nextAction, '检查删除按钮的启用条件和删除后的反馈调用')
    check('derived confirmed keeps mustRead with unknown basis', oldFull.brief.confirmed.some((item) => item.text.includes('最后一种语言不允许删除') && item.basis === 'unknown'), JSON.stringify(oldFull.brief.confirmed))
    check('derived leads keep touchedFiles as unknown leads', oldFull.brief.leads.some((item) => item.text === 'LanguageListView.swift' && item.basis === 'unknown'), JSON.stringify(oldFull.brief.leads))
    check('derived brief keeps park references as unknown leads', oldFull.brief.leads.some((item) => item.text.includes('操作反馈') && item.basis === 'unknown'), JSON.stringify(oldFull.brief.leads))
    const second = projectFull(store.get('td_old02'))
    checkEqual('old card with cause/intent still projects cause/intent', [second.core.cause, second.core.intent], ['header 在写入数据行时被再次输出', '导出文件应只包含一行表头'])
    check('derived brief keeps the cause as unknown', second.brief.confirmed.some((item) => item.text === 'header 在写入数据行时被再次输出' && item.basis === 'unknown'), JSON.stringify(second.brief.confirmed))

    const pathOnly = {
      ...old,
      id: 'td_pathonly',
      major: 1,
      minor: 98,
      title: '只有路径的旧卡',
      core: { nextStep: '检查文件' },
      touchedFiles: ['OnlyPath.swift'],
      mustRead: [],
      park: [],
    }
    await domain.table('todos').put('td_pathonly', pathOnly)
    const pathOnlyFull = projectFull(store.get('td_pathonly'))
    check('derived path-only brief keeps the quality warning', pathOnlyFull.briefWarnings.some((item) => item.includes('only leads')), JSON.stringify(pathOnlyFull.briefWarnings))

    const readTool = createTodoReadTool({ defineTool, store })
    const oldRead = await readTool.execute({ id: 'td_old01' }, execFor(fakeSession(sequence)))
    checkEqual('todo_read returns the derived brief source', oldRead.briefSource, 'derived')
    check('todo_read returns a brief goal', typeof oldRead.brief.goal === 'string' && oldRead.brief.goal.includes('语言'), JSON.stringify(oldRead.brief))
    check('old legacy facts are not presented as verified', oldRead.briefWarnings.some((item) => item.includes('no confirmed/decided/verified')), JSON.stringify(oldRead.briefWarnings))
    checkOutput(readTool, oldRead, 'todo_read legacy card')
    const oldRendered = readTool.output.render({}, oldRead)[0].text
    check('todo_read renders the brief before legacy references', oldRendered.includes('brief:') && oldRendered.includes('goal:'), oldRendered)
    check('todo_read derived brief keeps legacy must-read rows', oldRendered.includes('must-read 1.'), oldRendered)

    console.log('\nT1: brief normalization and limits')
    const simple = normalizeBrief({ goal: '支持批量导入', nextAction: '先验证解析性能' })
    check('simple brief normalizes with no errors', simple.errors.length === 0 && simple.brief.confirmed.length === 0, JSON.stringify(simple.errors))
    check('simple brief passes quality without filler fields', briefQuality(simple.brief).length === 0, JSON.stringify(briefQuality(simple.brief)))
    const complex = normalizeBrief({
      goal: '修复语言列表删除异常',
      why: '删除失败时开发者无法判断原因',
      confirmed: [{ text: '当前缺少操作反馈', basis: 'verified' }],
      constraints: [
        { text: '最后一种语言不允许删除', basis: 'decided' },
        { text: '无需让列表项跟随手指移动', basis: 'decided' },
      ],
      leads: [{ text: 'LanguageListView.swift', basis: 'unknown' }],
      nextAction: '检查删除按钮的启用条件和反馈调用',
      openQuestions: [{ text: '删除失败时是否需要 toast', basis: 'unknown', impact: 'non-blocking' }],
    })
    check('complex brief normalizes with no errors', complex.errors.length === 0, JSON.stringify(complex.errors))
    checkEqual('complex brief preserves user constraints', complex.brief.constraints.map((item) => item.text), ['最后一种语言不允许删除', '无需让列表项跟随手指移动'])
    checkEqual('complex brief keeps the verified fact basis', complex.brief.confirmed[0].basis, 'verified')
    checkEqual('complex brief keeps the next action', complex.brief.nextAction, '检查删除按钮的启用条件和反馈调用')

    const missingGoal = normalizeBrief({ nextAction: '检查' })
    check('brief without goal is rejected', missingGoal.errors.some((item) => item.code === 'todo/brief-goal-required'), JSON.stringify(missingGoal.errors))
    const missingNext = normalizeBrief({ goal: '修复问题' })
    check('brief without nextAction is rejected', missingNext.errors.some((item) => item.code === 'todo/brief-next-required'), JSON.stringify(missingNext.errors))
    const badBasis = normalizeBrief({ goal: '修复问题', nextAction: '检查', confirmed: [{ text: '看起来是缓存问题', basis: 'guess' }] })
    check('brief with an invalid basis is rejected', badBasis.errors.some((item) => item.code === 'todo/brief-invalid-basis'), JSON.stringify(badBasis.errors))
    const tooLong = normalizeBrief({ goal: '修复问题', nextAction: '检查', confirmed: [{ text: '字'.repeat(BRIEF_LIMITS.itemText + 1), basis: 'verified' }] })
    check('brief item over the limit is rejected', tooLong.errors.some((item) => item.code === 'todo/brief-item-too-long'), JSON.stringify(tooLong.errors))
    const duplicate = normalizeBrief({ goal: '修复问题', nextAction: '检查', confirmed: [{ text: '同一事实', basis: 'verified' }, { text: '同一事实', basis: 'verified' }] })
    check('brief duplicate items are removed with a warning', duplicate.brief.confirmed.length === 1 && duplicate.warnings.some((item) => item.includes('duplicate')), JSON.stringify(duplicate))
    const sourceOnly = normalizeBrief({ goal: '修复问题', nextAction: '检查', leads: [{ text: 'LanguageListView.swift', basis: 'unknown' }] })
    check('source-only brief is rejected', sourceOnly.errors.some((item) => item.code === 'todo/brief-source-only'), JSON.stringify(sourceOnly.errors))
    const sourceOnlyWarnings = briefQuality({ goal: '修复问题', nextAction: '检查', confirmed: [], constraints: [], leads: [{ text: 'LanguageListView.swift', basis: 'unknown' }], openQuestions: [] })
    check('source-only brief is also flagged by the quality rules', sourceOnlyWarnings.some((item) => item.includes('only leads')), JSON.stringify(sourceOnlyWarnings))
    const inferredOnly = normalizeBrief({ goal: '修复问题', nextAction: '检查', confirmed: [{ text: '可能是缓存', basis: 'inferred' }] })
    check('inferred-only brief is flagged by the quality rules', briefQuality(inferredOnly.brief).some((item) => item.includes('no confirmed')), JSON.stringify(briefQuality(inferredOnly.brief)))
    const superseded = normalizeBrief({ goal: '修复问题', nextAction: '检查', confirmed: [{ text: '旧方案 A', basis: 'superseded' }] })
    check('superseded item produces a warning', superseded.warnings.some((item) => item.includes('superseded')), JSON.stringify(superseded.warnings))
    const supersededConstraint = normalizeBrief({
      goal: '修复问题',
      nextAction: '检查当前方案',
      constraints: [{ text: '旧方案不再使用', basis: 'superseded' }],
    })
    check('superseded item cannot remain a current constraint', supersededConstraint.errors.some((item) => item.code === 'todo/brief-superseded-constraint'), JSON.stringify(supersededConstraint.errors))
    const conflicting = normalizeBrief({
      goal: '实现登录入口',
      nextAction: '先确认使用哪个登录方案',
      constraints: [
        { text: '使用方案 A', basis: 'decided' },
        { text: '使用方案 B', basis: 'decided' },
      ],
      openQuestions: [{ text: '方案 A 与方案 B 冲突，需开发者决定', basis: 'unknown', impact: 'blocking' }],
    })
    check('conflicting decisions are preserved, not silently dropped', conflicting.errors.length === 0 && conflicting.brief.constraints.length === 2, JSON.stringify(conflicting))
    check('conflicting decisions can carry a blocking question', conflicting.brief.openQuestions[0].impact === 'blocking', JSON.stringify(conflicting.brief.openQuestions))
    const blocking = normalizeBrief({
      goal: '修复删除反馈',
      nextAction: '先确认删除被拒绝时的期望行为',
      openQuestions: [{ text: '删除最后一种语言时是否应显示 toast？', basis: 'unknown', impact: 'blocking' }],
    })
    check('blocking open question is preserved', blocking.errors.length === 0 && blocking.brief.openQuestions[0].impact === 'blocking', JSON.stringify(blocking))
    const partial = normalizeBrief({
      goal: '修复删除反馈',
      nextAction: '按已确认方案实现',
      confirmed: [
        { text: '已确认使用左右抖动反馈', basis: 'decided' },
        { text: '可能是缓存未刷新', basis: 'inferred' },
      ],
    })
    checkEqual('partial decisions keep decided/inferred bases', partial.brief.confirmed.map((item) => item.basis), ['decided', 'inferred'])
    const tooManyConstraints = normalizeBrief({
      goal: '约束过多',
      nextAction: '先确认哪些约束有效',
      constraints: Array.from({ length: BRIEF_LIMITS.constraintsItems + 1 }, (_, index) => ({ text: `约束${index}`, basis: 'decided' })),
    })
    check('constraints over the cap are rejected, not truncated', tooManyConstraints.errors.some((item) => item.code === 'todo/brief-too-many-items'), JSON.stringify(tooManyConstraints.errors))
    const hugeBrief = normalizeBrief({
      goal: '目'.repeat(200),
      why: '背'.repeat(200),
      nextAction: '行'.repeat(280),
      confirmed: Array.from({ length: 6 }, (_, index) => ({ text: `事实${index}${'字'.repeat(196)}`, basis: 'verified' })),
    })
    check('brief over the hard total limit is rejected', hugeBrief.errors.some((item) => item.code === 'todo/brief-too-long'), JSON.stringify(hugeBrief.errors))
    const longBrief = normalizeBrief({
      goal: '长背景任务',
      nextAction: '先读已确认事实',
      confirmed: Array.from({ length: 6 }, (_, index) => ({ text: `事实 ${index + 1}: ${'背景'.repeat(97)}`, basis: 'verified' })),
    })
    check('long but under-hard-limit brief gets a soft warning', longBrief.errors.length === 0 && longBrief.warnings.some((item) => item.includes('soft limit')), JSON.stringify(longBrief.warnings))
    check('todo_add description says not to read history for the brief', TOOL_DESCRIPTION.includes('do not read history to complete the brief'), TOOL_DESCRIPTION)

    console.log('\nT1/T2: todo_add with a task brief')
    const tool = createTodoAddTool({
      defineTool,
      store,
      now: () => 1_800_000_000_000,
      readGit: async () => ({ commit: '', branch: '', symbols: [] }),
      resolveWorkspace: async (cwd) => (cwd === '' ? 'inbox' : cwd),
    })
    const exec = execFor(fakeSession(sequence))
    const created = await tool.execute(
      {
        title: '最后一种语言删除无反馈',
        kind: 'defect',
        nextStep: '检查删除按钮的启用条件和反馈调用',
        touchedFiles: ['LanguageListViewModel.swift'],
        mustRead: [],
        brief: {
          goal: '修复语言列表删除异常',
          why: '删除失败时开发者无法判断原因',
          confirmed: [{ text: '当前缺少操作反馈', basis: 'verified' }],
          constraints: [
            { text: '最后一种语言不允许删除', basis: 'decided' },
            { text: '无需让列表项跟随手指移动', basis: 'decided' },
          ],
          leads: [{ text: 'LanguageListViewModel.swift', basis: 'unknown' }],
          nextAction: '检查删除按钮的启用条件和反馈调用',
          openQuestions: [],
        },
      },
      exec,
    )
    checkEqual('todo_add reports that a brief was stored', created.brief, true)
    checkEqual('todo_add has no unexpected brief warnings', created.warnings, [])
    checkOutput(tool, created, 'todo_add with brief')
    const stored = store.get(created.id)
    check('stored record keeps the brief', stored.brief !== undefined && stored.brief.goal === '修复语言列表删除异常')
    checkEqual('stored brief keeps user constraints', stored.brief.constraints.map((item) => item.text), ['最后一种语言不允许删除', '无需让列表项跟随手指移动'])
    const full = projectFull(stored)
    checkEqual('stored brief is projected as stored', full.briefSource, 'stored')
    const api = createApi({ store })
    const detail = await api.handle('detail', { id: created.id })
    check('detail endpoint carries the stored brief', detail.ok === true && detail.value.item.brief.goal === '修复语言列表删除异常', JSON.stringify(detail))
    const list = await api.handle('list', { workspace: '/tmp/legacy-repo' })
    check('list row exposes hasBrief/briefGoal', list.ok === true && list.value.items.some((item) => item.id === created.id && item.hasBrief === true && item.briefGoal.includes('语言')), JSON.stringify(list))

    const apiConflict = await api.handle('create', {
      workspace: '/tmp/legacy-repo',
      title: 'API 冲突卡片',
      kind: 'idea',
      nextStep: 'API 旧下一步',
      brief: { goal: 'API 目标', nextAction: 'API 简报下一步' },
    })
    check('API create makes brief.nextAction canonical', apiConflict.ok === true && apiConflict.value.item.nextStep === 'API 简报下一步', JSON.stringify(apiConflict))
    check('API create reports the conflict warning', apiConflict.ok === true && apiConflict.value.warnings?.some((item) => item.includes('differs from brief.nextAction')), JSON.stringify(apiConflict))
    const apiPatched = await api.handle('patch', {
      id: apiConflict.value.item.id,
      patch: { nextStep: 'API 补丁旧值', brief: { goal: 'API 目标', nextAction: 'API 补丁简报值' } },
    })
    check('API patch makes brief.nextAction canonical', apiPatched.ok === true && apiPatched.value.item.nextStep === 'API 补丁简报值', JSON.stringify(apiPatched))
    check('API patch reports the conflict warning', apiPatched.ok === true && apiPatched.value.warnings?.some((item) => item.includes('differs from brief.nextAction')), JSON.stringify(apiPatched))
    const read = await readTool.execute({ id: created.id }, exec)
    checkEqual('todo_read returns the stored brief', read.briefSource, 'stored')
    checkEqual('todo_read preserves the verified fact', read.brief.confirmed[0].basis, 'verified')
    check('todo_read render includes the brief and the user constraint', readTool.output.render({}, read)[0].text.includes('brief:') && readTool.output.render({}, read)[0].text.includes('最后一种语言不允许删除'))

    const conflict = await tool.execute(
      {
        title: 'nextStep 冲突测试',
        kind: 'defect',
        nextStep: '旧下一步 A',
        touchedFiles: ['Conflict.swift'],
        mustRead: [],
        brief: { goal: '验证 nextStep 冲突', nextAction: '简报下一步 B' },
      },
      exec,
    )
    const conflictStored = store.get(conflict.id)
    checkEqual('brief.nextAction wins over nextStep', [conflictStored.core.nextStep, conflictStored.brief.nextAction], ['简报下一步 B', '简报下一步 B'])
    check('nextStep conflict produces a warning', conflict.warnings.some((item) => item.includes('differs from brief.nextAction')), JSON.stringify(conflict.warnings))
    const conflictRead = await readTool.execute({ id: conflict.id }, exec)
    checkEqual('todo_read sees one canonical next action', [conflictRead.core.nextStep, conflictRead.brief.nextAction], ['简报下一步 B', '简报下一步 B'])

    const simpleCreated = await tool.execute(
      {
        title: '支持批量导入',
        kind: 'idea',
        nextStep: '先验证解析性能',
        touchedFiles: [],
        mustRead: [],
        brief: { goal: '支持批量导入', nextAction: '先验证解析性能' },
      },
      exec,
    )
    checkEqual('simple task can store a minimal brief', simpleCreated.brief, true)
    check('simple task does not get a source-only warning', simpleCreated.warnings.some((item) => item.includes('only leads')) === false, JSON.stringify(simpleCreated.warnings))
    const briefOnly = await tool.execute(
      {
        title: '只有简报没有旧 nextStep',
        kind: 'idea',
        touchedFiles: ['BriefOnly.swift'],
        mustRead: [],
        brief: { goal: '验证简报单独提供 nextAction', nextAction: '先做最小验证' },
      },
      exec,
    )
    check('brief-only capture succeeds without a legacy nextStep', briefOnly.status === 'created' && briefOnly.brief === true, JSON.stringify(briefOnly))
    const briefOnlyStored = store.get(briefOnly.id)
    checkEqual('brief-only capture synchronizes core.nextStep', [briefOnlyStored.core.nextStep, briefOnlyStored.brief.nextAction], ['先做最小验证', '先做最小验证'])
    const briefOnlyRead = await readTool.execute({ id: briefOnly.id }, exec)
    checkEqual('brief-only capture reads back consistently', [briefOnlyRead.core.nextStep, briefOnlyRead.brief.nextAction], ['先做最小验证', '先做最小验证'])
    const simpleRead = await readTool.execute({ id: simpleCreated.id }, exec)
    checkEqual('simple task reads back as a stored brief', [simpleRead.briefSource, simpleRead.brief.goal, simpleRead.brief.nextAction], ['stored', '支持批量导入', '先验证解析性能'])
    check('simple task keeps optional arrays empty', [simpleRead.brief.confirmed.length, simpleRead.brief.constraints.length, simpleRead.brief.leads.length, simpleRead.brief.openQuestions.length].every((count) => count === 0), JSON.stringify(simpleRead.brief))

    try {
      await tool.execute(
        {
          title: '删除流程反馈检查',
          kind: 'defect',
          nextStep: '检查代码',
          touchedFiles: ['LanguageFeedback.swift'],
          mustRead: [],
          brief: {
            goal: '修复语言列表删除',
            nextAction: '检查代码',
            leads: [{ text: 'LanguageFeedback.swift', basis: 'unknown' }],
          },
        },
        exec,
      )
      check('source-only brief is rejected by todo_add', false, 'no rejection')
    } catch (error) {
      check('source-only brief is rejected by todo_add', error.code === 'todo/brief-source-only', `${error.code}: ${error.message}`)
    }
    check('source-only rejection stores no card', !store.all().some((record) => record.title === '删除流程反馈检查'), JSON.stringify(store.all().map((record) => record.title)))

    const blockingCreated = await tool.execute(
      {
        title: '删除反馈待确认',
        kind: 'defect',
        nextStep: '先确认删除被拒绝时的期望行为',
        touchedFiles: ['BlockingFeedback.swift'],
        mustRead: [],
        brief: {
          goal: '修复删除反馈',
          nextAction: '先确认删除被拒绝时的期望行为',
          openQuestions: [{ text: '删除最后一种语言时是否应显示 toast？', basis: 'unknown', impact: 'blocking' }],
        },
      },
      exec,
    )
    const blockingRead = await readTool.execute({ id: blockingCreated.id }, exec)
    checkEqual('blocking open question persists and reads back', blockingRead.brief.openQuestions[0].impact, 'blocking')
    const inferredCreated = await tool.execute(
      {
        title: '删除状态未刷新',
        kind: 'defect',
        nextStep: '确认缓存路径',
        touchedFiles: ['LanguageStore.swift'],
        mustRead: [],
        brief: {
          goal: '修复语言删除异常',
          nextAction: '确认缓存路径',
          confirmed: [{ text: '可能是缓存未刷新', basis: 'inferred' }],
        },
      },
      exec,
    )
    check('inferred-only brief gets a credibility warning', inferredCreated.warnings.some((item) => item.includes('no confirmed')), JSON.stringify(inferredCreated.warnings))
    const inferredRead = await readTool.execute({ id: inferredCreated.id }, exec)
    checkEqual('inferred cause reads back as inferred', inferredRead.brief.confirmed[0].basis, 'inferred')
    check('inferred-only read keeps the credibility warning', inferredRead.briefWarnings.some((item) => item.includes('no confirmed')), JSON.stringify(inferredRead.briefWarnings))

    const unbackedCreated = await tool.execute(
      {
        title: '无来源的已验证事实',
        kind: 'idea',
        nextStep: '先补来源',
        touchedFiles: [],
        mustRead: [],
        brief: {
          goal: '验证无来源事实的提示',
          nextAction: '先补来源',
          confirmed: [{ text: '生产环境使用 PostgreSQL', basis: 'verified' }],
        },
      },
      exec,
    )
    const unbackedRead = await readTool.execute({ id: unbackedCreated.id }, exec)
    check('unsourced verified fact gets a source warning', unbackedRead.briefWarnings.some((item) => item.includes('no sourceIds')), JSON.stringify(unbackedRead.briefWarnings))

    const legacyCreated = await tool.execute(
      {
        title: '没有简报的旧式卡',
        kind: 'idea',
        nextStep: '先确认需求',
        touchedFiles: [],
        mustRead: [],
      },
      exec,
    )
    checkEqual('legacy capture reports no stored brief', legacyCreated.brief, false)
    check('legacy capture render tells the model to add a brief', tool.output.render({}, legacyCreated)[0].text.includes('No task brief was stored'), tool.output.render({}, legacyCreated)[0].text)
    try {
      await tool.execute(
        {
          title: '旧式路径卡 A',
          kind: 'defect',
          nextStep: '检查文件',
          touchedFiles: ['LegacyOnlyPath.swift'],
          mustRead: [],
        },
        exec,
      )
      check('new path-only legacy capture is rejected', false, 'no rejection')
    } catch (error) {
      check('new path-only legacy capture is rejected', error.code === 'todo/brief-required', `${error.code}: ${error.message}`)
    }
    check('rejected path-only capture stores no card', !store.all().some((record) => record.title === '旧式路径卡 A'), JSON.stringify(store.all().map((record) => record.title)))

    try {
      await tool.execute(
        {
          title: '坏 brief',
          kind: 'defect',
          nextStep: '检查',
          touchedFiles: [],
          mustRead: [],
          brief: { goal: '修复问题', nextAction: '检查', confirmed: [{ text: '推断', basis: 'guess' }] },
        },
        exec,
      )
      check('invalid brief basis is rejected by todo_add', false, 'no rejection')
    } catch (error) {
      check('invalid brief basis is rejected by todo_add', (error.code === 'todo/brief-invalid-basis' || String(error.code).includes('INVALID_ARGS')) && /basis/u.test(error.message), `${error.code}: ${error.message}`)
    }

    console.log('\nT3: brief-aware duplicate detection')
    const dupA = await store.create(
      {
        workspace: '/tmp/t3-dup',
        title: '刷新令牌失败',
        kind: 'defect',
        nextStep: '检查刷新逻辑',
        touchedFiles: ['T3Auth.swift'],
        brief: {
          goal: '修复刷新令牌后 401',
          why: '用户会话过期后请求失败',
          confirmed: [{ text: '刷新请求返回 401', basis: 'verified' }],
          nextAction: '检查刷新逻辑',
        },
      },
      () => 1_800_000_300_000,
    )
    const sameGoal = findDuplicate(store.all(), {
      workspace: '/tmp/t3-dup',
      title: '登录页无法继续',
      goal: '修复刷新令牌后 401',
      why: '用户会话过期后请求失败',
      touchedFiles: ['T3Auth.swift'],
    })
    check('same shared file + similar goal is a duplicate even with a different title', sameGoal?.card.id === dupA.id, JSON.stringify(sameGoal))
    checkEqual('duplicate result explains the goal match', sameGoal?.matchReason, 'shared file + similar goal')
    check('duplicate result carries goal similarity', sameGoal?.goalSimilarity >= 0.65, JSON.stringify(sameGoal))
    check('duplicate result carries why similarity as an explanation', sameGoal?.whySimilarity >= 0.65, JSON.stringify(sameGoal))

    const differentGoal = findDuplicate(store.all(), {
      workspace: '/tmp/t3-dup',
      title: '刷新令牌失败',
      goal: '为登录页增加暗色主题',
      why: '用户希望在夜间使用',
      touchedFiles: ['T3Auth.swift'],
    })
    check('same file + similar title but unrelated goals is not a duplicate', differentGoal === undefined, JSON.stringify(differentGoal))

    const whyOnly = findDuplicate(store.all(), {
      workspace: '/tmp/t3-dup',
      title: '完全不同的入口',
      goal: '为登录页增加暗色主题',
      why: '用户会话过期后请求失败',
      touchedFiles: ['T3Auth.swift'],
    })
    check('why similarity alone does not decide a duplicate', whyOnly === undefined, JSON.stringify(whyOnly))

    const legacyDuplicate = findDuplicate(store.all(), {
      workspace: '/tmp/t3-dup',
      title: '刷新令牌失败！',
      touchedFiles: ['T3Auth.swift'],
    })
    check('legacy title + shared file baseline still works', legacyDuplicate?.card.id === dupA.id, JSON.stringify(legacyDuplicate))

    const t3Exec = execFor({ ...fakeSession(sequence), header: { cwd: '/tmp/t3-dup' } })
    const goalOnlyTool = await tool.execute(
      {
        title: '登录页无法继续',
        kind: 'defect',
        touchedFiles: ['T3Auth.swift'],
        mustRead: [],
        brief: { goal: '修复刷新令牌后 401', nextAction: '检查刷新逻辑' },
      },
      t3Exec,
    )
    checkEqual('todo_add returns a goal-aware duplicate', [goalOnlyTool.status, goalOnlyTool.candidateId], ['duplicate', dupA.id])
    check('todo_add duplicate output is explainable', goalOnlyTool.matchReason.includes('goal') && goalOnlyTool.goalSimilarity >= 0.65, JSON.stringify(goalOnlyTool))
    checkOutput(tool, goalOnlyTool, 'todo_add goal duplicate')
    const forcedCreate = await tool.execute(
      {
        title: '登录页无法继续',
        kind: 'defect',
        touchedFiles: ['T3Auth.swift'],
        mustRead: [],
        brief: { goal: '修复刷新令牌后 401', nextAction: '检查刷新逻辑' },
        forceCreate: true,
      },
      t3Exec,
    )
    checkEqual('confirmed create overrides the duplicate signal', forcedCreate.status, 'created')
    checkEqual('confirmed create stores the new card', store.get(forcedCreate.id).title, '登录页无法继续')
    try {
      await tool.execute(
        {
          title: '强制创建只有路径',
          kind: 'defect',
          nextStep: '检查文件',
          touchedFiles: ['ForceOnly.swift'],
          mustRead: [],
          forceCreate: true,
        },
        t3Exec,
      )
      check('forceCreate does not bypass the task-brief quality gate', false, 'no rejection')
    } catch (error) {
      check('forceCreate does not bypass the task-brief quality gate', error.code === 'todo/brief-required', `${error.code}: ${error.message}`)
    }
    const noteTool = createTodoNoteTool({ defineTool, store, now: () => 1_800_000_410_000 })
    const beforeNotes = store.get(dupA.id).notes.length
    const appended = await noteTool.execute({ id: dupA.id, text: '补一条新证据：刷新失败也会影响设置页', kind: 'evidence' }, t3Exec)
    checkEqual('confirmed merge appends a note to the existing card', [beforeNotes, store.get(dupA.id).notes.length, appended.notesCount], [0, 1, 1])
    checkEqual('confirmed merge does not create a second card', store.all().filter((record) => record.title === '刷新令牌失败').length, 1)

    const differentGoalTool = await tool.execute(
      {
        title: '刷新令牌失败！',
        kind: 'defect',
        touchedFiles: ['T3Auth.swift'],
        mustRead: [],
        brief: { goal: '为登录页增加暗色主题', nextAction: '先确认主题入口' },
      },
      t3Exec,
    )
    checkEqual('todo_add does not block a different goal on the same file', differentGoalTool.status, 'created')
    checkEqual('different-goal card keeps its own brief', store.get(differentGoalTool.id).brief.goal, '为登录页增加暗色主题')

    console.log('\nT1: patch, manual create and persistence')
    const patched = applyPatch(stored, { nextStep: '检查删除按钮和反馈调用' }, 1_800_000_100_000)
    checkEqual('nextStep patch updates brief.nextAction', patched.brief.nextAction, '检查删除按钮和反馈调用')
    const briefPatched = applyPatch(stored, { brief: { goal: '修复语言删除', nextAction: '先确认删除按钮状态' } }, 1_800_000_150_000)
    check('brief patch replaces the brief', briefPatched.brief.goal === '修复语言删除' && briefPatched.brief.nextAction === '先确认删除按钮状态', JSON.stringify(briefPatched.brief))
    checkEqual('brief patch synchronizes core.nextStep', briefPatched.core.nextStep, '先确认删除按钮状态')

    const inconsistent = {
      ...stored,
      id: 'td_inconsistent',
      major: 1,
      minor: 99,
      core: { ...stored.core, nextStep: '旧 nextStep' },
      brief: { ...stored.brief, nextAction: '简报 nextAction' },
    }
    await domain.table('todos').put('td_inconsistent', inconsistent)
    const inconsistentFull = projectFull(store.get('td_inconsistent'))
    checkEqual('projection uses brief.nextAction as canonical for core', inconsistentFull.core.nextStep, '简报 nextAction')
    check('projection warns about the mismatched legacy nextStep', inconsistentFull.briefWarnings.some((item) => item.includes('differed')), JSON.stringify(inconsistentFull.briefWarnings))
    checkEqual('list projection also uses the canonical next action', projectL0(store.get('td_inconsistent')).nextStep, '简报 nextAction')
    const manual = await store.create(
      {
        workspace: '/tmp/legacy-repo',
        title: '手动卡片',
        kind: 'idea',
        nextStep: '先写最小验证',
        brief: { goal: '手动卡片的目标', nextAction: '先写最小验证' },
      },
      () => 1_800_000_200_000,
    )
    check('manual create can store a brief', manual.brief !== undefined && manual.brief.goal === '手动卡片的目标')
    const manualConflict = await store.create(
      {
        workspace: '/tmp/legacy-repo',
        title: '手动冲突卡片',
        kind: 'idea',
        nextStep: '旧的下一步',
        brief: { goal: '手动冲突目标', nextAction: '新的下一步' },
      },
      () => 1_800_000_250_000,
    )
    checkEqual('manual create also makes brief.nextAction canonical', [manualConflict.core.nextStep, manualConflict.brief.nextAction], ['新的下一步', '新的下一步'])
    const manualNoBrief = await store.create(
      {
        workspace: '/tmp/legacy-repo',
        title: '无简报手动卡',
        kind: 'idea',
        nextStep: '先确认需求',
      },
      () => 1_800_000_260_000,
    )
    const manualNoBriefView = projectFull(manualNoBrief)
    check('manual card without brief projects a derived brief', manualNoBriefView.briefSource === 'derived' && manualNoBriefView.brief.goal === '无简报手动卡' && manualNoBriefView.brief.nextAction === '先确认需求', JSON.stringify(manualNoBriefView.brief))
    const manualTitleOnly = await store.create(
      {
        workspace: '/tmp/legacy-repo',
        title: '只有标题的手动卡',
        kind: 'idea',
      },
      () => 1_800_000_270_000,
    )
    const manualTitleOnlyView = projectFull(manualTitleOnly)
    check('title-only manual card exposes the missing nextAction warning', manualTitleOnlyView.briefSource === 'derived' && manualTitleOnlyView.briefWarnings.some((item) => item.includes('no nextAction')), JSON.stringify(manualTitleOnlyView.briefWarnings))

    await domain.close()
    const reopened = await ctx.storageDomain.open(spec)
    const reopenedStore = createStore(reopened)
    const reopenedNew = reopenedStore.get(created.id)
    check('new brief survives close/reopen', reopenedNew.brief !== undefined && reopenedNew.brief.goal === '修复语言列表删除异常')
    const reopenedSimple = reopenedStore.get(simpleCreated.id)
    checkEqual('simple brief persists after reopen', [reopenedSimple.brief.goal, reopenedSimple.brief.nextAction], ['支持批量导入', '先验证解析性能'])
    const reopenedInferred = reopenedStore.get(inferredCreated.id)
    checkEqual('inferred basis persists after reopen', reopenedInferred.brief.confirmed[0].basis, 'inferred')
    const reopenedConflict = reopenedStore.get(conflict.id)
    checkEqual('conflict remains consistent after reopen', [reopenedConflict.core.nextStep, reopenedConflict.brief.nextAction], ['简报下一步 B', '简报下一步 B'])
    const reopenedInconsistent = projectFull(reopenedStore.get('td_inconsistent'))
    checkEqual('persisted inconsistent legacy record is canonicalized on read', reopenedInconsistent.core.nextStep, '简报 nextAction')
    const reopenedOld = reopenedStore.get('td_old01')
    check('old card remains brief-free on disk', reopenedOld.brief === undefined)
    checkEqual('old card still projects a derived brief after reopen', projectFull(reopenedOld).briefSource, 'derived')
    const file = await readFile(join(root, 'todo_assistant.json'), 'utf8')
    check('single-layout file keeps version 1', file.includes('"version": 1'))
    check('single-layout file stores the new brief', file.includes('修复语言列表删除异常'))
    await reopened.close()

    // T4: simulate an old domain schema that predates `brief`. This is a
    // schema-level downgrade probe, not a run of the old published package.
    const oldTodo = z.object({
      id: z.string(),
      major: z.number().int().optional(),
      minor: z.number().int().optional(),
      number: z.number().int().optional(),
      workspace: z.string(),
      title: z.string(),
      status: z.enum(['open', 'doing', 'done', 'dropped']),
      kind: z.enum(['defect', 'idea']),
      createdAt: z.number(),
      updatedAt: z.number(),
      origin: z.any().optional(),
      request: z.any().optional(),
      code: z.any(),
      touchedFiles: z.array(z.string()),
      core: z.any(),
      mustRead: z.array(z.any()),
      park: z.array(z.any()),
      notes: z.array(z.any()),
      handling: z.any().optional(),
    })
    const oldRules = z.object({ workspace: z.string(), text: z.string(), updatedAt: z.number() })
    const oldSpec = storageDomain.defineDomain({
      name: 'todo_assistant',
      version: 1,
      tables: { todos: storageDomain.domainTable(oldTodo), rules: storageDomain.domainTable(oldRules) },
    })
    const oldDomain = await ctx.storageDomain.open(oldSpec)
    const oldSchemaRead = oldDomain.table('todos').get(created.id)
    check('old schema strips the unknown brief on read', oldSchemaRead !== undefined && oldSchemaRead.brief === undefined, JSON.stringify(oldSchemaRead))
    await oldDomain.table('todos').put(created.id, { ...oldSchemaRead, title: '旧版本写回' })
    const downgraded = JSON.parse(await readFile(join(root, 'todo_assistant.json'), 'utf8'))
    check('old schema write drops the brief from the rewritten record', downgraded.tables.todos[created.id].brief === undefined, JSON.stringify(downgraded.tables.todos[created.id]))
    check('old schema cannot recover the dropped brief', oldDomain.table('todos').get(created.id).brief === undefined)
    await oldDomain.close()

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
