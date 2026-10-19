/**
 * Gate 1 / T5 acceptance — the deterministic half of docs/PLAN.md §8.0.
 *
 * This drives the real capture/store/projection code over a temp JSON backend
 * and records, per scenario, whether the System accepts a good brief, rejects a
 * source-only card, persists the brief, deduplicates, and stays legacy-safe.
 *
 * It deliberately does NOT prove that a model writes the expected brief. The
 * semantic half (did the model understand, invent, ask, or call `todo_recall`)
 * is recorded separately in docs/GATE1-T5-ACCEPTANCE.md and must never be
 * inferred from this script. A green run here is "deterministic coverage
 * passed", not "Gate 1 passed".
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { applyPatch, createTodoSpec, projectFull, projectL0 } from '../domain.js'
import { createTodoAddTool, createTodoNoteTool, createTodoReadTool } from '../tool.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const FIXTURE = new URL('./fixtures/todo_assistant.v1.json', import.meta.url)

const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)

const SCENARIOS = {
  S1: '当前上下文充分：目标/约束/下一步都明确',
  S2: '需求完整，但没有明确代码文件',
  S3: '当前上下文包含用户已确认的实现约束',
  S4: '当前上下文混有 AI 推断和未经确认的假设',
  S5: '当前上下文存在相互矛盾的决定',
  S6: '当前上下文缺少影响实现正确性的关键信息',
  S7: '任务很简单：只需一句目标 + 下一步',
  S8: '任务较复杂：多个背景、约束、线索、未决问题',
  S9: '已有待办与新任务相似',
  S10: '只有来源指针/文件路径，没有任务简报（必须失败）',
  CONTRACT: '下一步字段契约与读取投影',
  PERSIST: '旧卡读取、保存和重新打开',
}

let checks = 0
let failures = 0
const buckets = new Map()

function bucket(id) {
  if (!buckets.has(id)) buckets.set(id, { title: SCENARIOS[id] ?? id, checks: 0, failures: 0 })
  return buckets.get(id)
}

function check(id, label, ok, detail) {
  const entry = bucket(id)
  checks += 1
  entry.checks += 1
  if (ok) {
    console.log(`  ok   [${id}] ${label}`)
    return
  }
  failures += 1
  entry.failures += 1
  console.log(`  FAIL [${id}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function checkEqual(id, label, actual, expected) {
  check(id, label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const sequence = [
  { type: 'turn/start', seq: 4, data: { turn: 3 } },
  { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这个旁支任务记一下' }] } },
  { type: 'tool/result', seq: 9, data: {} },
]

function fakeSession(cwd) {
  return { id: 'sess-gate1', header: { cwd }, seq: 10, snapshotEvents: () => sequence }
}

function execFor(session) {
  return { agent: { id: 'sess-gate1', session }, signal: new AbortController().signal, callId: 'call-gate1' }
}

function hasCard(store, title) {
  return store.all().some((record) => record.title === title)
}

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-gate1-'))
  console.log(`temp storage root: ${root}`)
  const ctx = new Context()
  try {
    await copyFile(FIXTURE, join(root, 'todo_assistant.json'))
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    const domain = await ctx.storageDomain.open(spec)
    const store = createStore(domain)

    let clock = 1_800_000_000_000
    const now = () => (clock += 1000)
    const tool = createTodoAddTool({
      defineTool,
      store,
      now,
      readGit: async () => ({ commit: '', branch: '', symbols: [] }),
      resolveWorkspace: async (cwd) => (cwd === '' ? 'inbox' : cwd),
    })
    const readTool = createTodoReadTool({ defineTool, store })
    const noteTool = createTodoNoteTool({ defineTool, store, now })
    const api = createApi({ store })
    const capture = (args, cwd = '/tmp/gate1') => tool.execute(args, execFor(fakeSession(cwd)))
    const read = (id) => readTool.execute({ id }, execFor(fakeSession('/tmp/gate1')))

    async function expectRejection(id, label, args, code, cwd = '/tmp/gate1') {
      try {
        await capture(args, cwd)
        check(id, label, false, 'no rejection')
      } catch (error) {
        check(id, label, error.code === code, `${error.code}: ${error.message}`)
      }
    }

    console.log('\nS1: current context is sufficient')
    const s1 = await capture({
      title: '设置页深色模式开关',
      kind: 'idea',
      touchedFiles: ['Gate1SettingsView.swift'],
      mustRead: [],
      nextStep: '先确认现有主题切换入口',
      brief: {
        goal: '给设置页增加深色模式开关',
        why: '用户希望在夜间使用',
        constraints: [{ text: '只改设置页，不动主题系统', basis: 'decided' }],
        nextAction: '先确认现有主题切换入口',
      },
    })
    check('S1', 'todo_add stores a complete brief', s1.status === 'created' && s1.brief === true, JSON.stringify(s1))
    check('S1', 'todo_add does not flag the complete brief as source-only', !s1.warnings.some((item) => item.includes('only leads')), JSON.stringify(s1.warnings))
    const s1Stored = store.get(s1.id)
    checkEqual('S1', 'brief goal/why/constraint/nextAction persist', [s1Stored.brief.goal, s1Stored.brief.why, s1Stored.brief.constraints[0].text, s1Stored.brief.nextAction], ['给设置页增加深色模式开关', '用户希望在夜间使用', '只改设置页，不动主题系统', '先确认现有主题切换入口'])
    checkEqual('S1', 'core.nextStep mirrors brief.nextAction', s1Stored.core.nextStep, s1Stored.brief.nextAction)
    const s1Read = await read(s1.id)
    checkEqual('S1', 'todo_read returns the stored brief', [s1Read.briefSource, s1Read.brief.goal, s1Read.briefWarnings.length], ['stored', '给设置页增加深色模式开关', 0])

    console.log('\nS2: complete requirement without a code file')
    const s2 = await capture({
      title: '支持导出 CSV',
      kind: 'idea',
      touchedFiles: [],
      mustRead: [],
      nextStep: '先确认现有导出入口',
      brief: {
        goal: '支持把当前列表导出为 CSV',
        constraints: [{ text: '不引入新的第三方依赖', basis: 'decided' }],
        nextAction: '先确认现有导出入口',
      },
    })
    check('S2', 'a card without file paths is accepted', s2.status === 'created' && s2.brief === true, JSON.stringify(s2))
    checkEqual('S2', 'touchedFiles stays empty instead of being invented', store.get(s2.id).touchedFiles, [])
    const s2Read = await read(s2.id)
    checkEqual('S2', 'brief has no leads and keeps the constraint', [s2Read.brief.leads.length, s2Read.brief.constraints[0].text], [0, '不引入新的第三方依赖'])
    check('S2', 'the empty-file warning is soft, not a rejection', s2.warnings.some((item) => item.includes('touchedFiles is empty')), JSON.stringify(s2.warnings))

    console.log('\nS3: user-confirmed constraints')
    const s3 = await capture({
      title: '限制删除操作',
      kind: 'defect',
      touchedFiles: [],
      mustRead: [],
      nextStep: '按已确认的约束实现',
      brief: {
        goal: '删除语言时给出明确反馈',
        constraints: [
          { text: '最后一种语言不允许删除', basis: 'decided' },
          { text: '删除失败要给出反馈', basis: 'requirement' },
        ],
        nextAction: '按已确认的约束实现',
      },
    })
    const s3Read = await read(s3.id)
    checkEqual('S3', 'constraint text and basis are preserved', s3Read.brief.constraints.map((item) => [item.text, item.basis]), [['最后一种语言不允许删除', 'decided'], ['删除失败要给出反馈', 'requirement']])
    check('S3', 'no constraint is downgraded to inferred', s3Read.brief.constraints.every((item) => item.basis !== 'inferred'), JSON.stringify(s3Read.brief.constraints))

    console.log('\nS4: inference and unknown assumptions stay labeled')
    const s4 = await capture({
      title: '删除状态未刷新',
      kind: 'defect',
      touchedFiles: [],
      mustRead: [],
      nextStep: '确认缓存路径',
      brief: {
        goal: '修复删除后的状态未刷新',
        confirmed: [
          { text: '可能是缓存没有失效', basis: 'inferred' },
          { text: '是否只在最后一种语言时出现还未确认', basis: 'unknown' },
        ],
        nextAction: '确认缓存路径',
      },
    })
    const s4Read = await read(s4.id)
    checkEqual('S4', 'inferred/unknown bases are preserved', s4Read.brief.confirmed.map((item) => item.basis), ['inferred', 'unknown'])
    check('S4', 'the credibility warning is present', s4Read.briefWarnings.some((item) => item.includes('no confirmed/decided/verified')), JSON.stringify(s4Read.briefWarnings))
    check('S4', 'inference is not promoted to a decision', s4Read.brief.confirmed.every((item) => item.basis !== 'decided' && item.basis !== 'verified'), JSON.stringify(s4Read.brief.confirmed))

    console.log('\nS5: conflicting decisions are surfaced')
    const s5 = await capture({
      title: '登录入口方案冲突',
      kind: 'idea',
      touchedFiles: [],
      mustRead: [],
      nextStep: '先请开发者确认登录方案',
      brief: {
        goal: '实现登录入口',
        constraints: [
          { text: '使用方案 A', basis: 'decided' },
          { text: '使用方案 B', basis: 'decided' },
        ],
        nextAction: '先请开发者确认登录方案',
        openQuestions: [{ text: '方案 A 与方案 B 冲突，需要开发者选择', basis: 'unknown', impact: 'blocking' }],
      },
    })
    const s5Read = await read(s5.id)
    checkEqual('S5', 'both conflicting decisions are kept', s5Read.brief.constraints.map((item) => item.text), ['使用方案 A', '使用方案 B'])
    checkEqual('S5', 'the conflict carries a blocking question', [s5Read.brief.openQuestions.length, s5Read.brief.openQuestions[0].impact], [1, 'blocking'])
    check('S5', 'the system does not silently pick one side', s5Read.brief.constraints.length === 2, JSON.stringify(s5Read.brief))

    console.log('\nS6: a blocking gap is recorded without invention')
    const s6 = await capture({
      title: '删除反馈待确认',
      kind: 'defect',
      touchedFiles: [],
      mustRead: [],
      nextStep: '先确认删除被拒绝时的期望行为',
      brief: {
        goal: '修复删除反馈',
        nextAction: '先确认删除被拒绝时的期望行为',
        openQuestions: [{ text: '删除最后一种语言时是否应显示 toast？', basis: 'unknown', impact: 'blocking' }],
      },
    })
    const s6Read = await read(s6.id)
    checkEqual('S6', 'the blocking question persists', [s6Read.brief.openQuestions.length, s6Read.brief.openQuestions[0].text, s6Read.brief.openQuestions[0].impact], [1, '删除最后一种语言时是否应显示 toast？', 'blocking'])
    checkEqual('S6', 'no confirmed fact or constraint is invented', [s6Read.brief.confirmed.length, s6Read.brief.constraints.length, s6Read.brief.leads.length], [0, 0, 0])

    console.log('\nS7: a simple task stays light')
    const s7 = await capture({
      title: '支持批量导入',
      kind: 'idea',
      touchedFiles: [],
      mustRead: [],
      nextStep: '先验证解析性能',
      brief: { goal: '支持批量导入', nextAction: '先验证解析性能' },
    })
    const s7Read = await read(s7.id)
    checkEqual('S7', 'minimal brief is stored and read back', [s7Read.briefSource, s7Read.brief.goal, s7Read.brief.nextAction], ['stored', '支持批量导入', '先验证解析性能'])
    checkEqual('S7', 'optional arrays stay empty', [s7Read.brief.confirmed.length, s7Read.brief.constraints.length, s7Read.brief.leads.length, s7Read.brief.openQuestions.length], [0, 0, 0, 0])
    check('S7', 'the simple task gets no quality warning', s7Read.briefWarnings.length === 0, JSON.stringify(s7Read.briefWarnings))
    check('S7', 'the simple task is not padded into a long brief', s7Read.brief.goal.length + s7Read.brief.nextAction.length < 80, JSON.stringify(s7Read.brief))

    console.log('\nS8: a complex task keeps the important material')
    const s8 = await capture({
      title: '导出功能完整改造',
      kind: 'idea',
      touchedFiles: ['Gate1Export.swift', 'Gate1Csv.swift'],
      mustRead: [],
      nextStep: '先按已确认的格式写解析器',
      brief: {
        goal: '重做导出流程',
        why: '现有 JSON 导出无法在表格工具中使用',
        confirmed: [
          { text: '现有导出只支持 JSON', basis: 'requirement' },
          { text: '表格工具需要 CSV', basis: 'requirement' },
        ],
        constraints: [
          { text: '不引入第三方 CSV 库', basis: 'decided' },
          { text: '保留原有 JSON 导出入口', basis: 'decided' },
          { text: '字段顺序必须稳定', basis: 'requirement' },
        ],
        leads: [
          { text: 'Gate1Export.swift', basis: 'unknown' },
          { text: 'Gate1Csv.swift', basis: 'unknown' },
        ],
        nextAction: '先按已确认的格式写解析器',
        openQuestions: [{ text: '大文件是否需要流式导出？', basis: 'unknown', impact: 'non-blocking' }],
      },
    })
    const s8Read = await read(s8.id)
    checkEqual('S8', 'all complex brief sections are preserved', [s8Read.brief.confirmed.length, s8Read.brief.constraints.length, s8Read.brief.leads.length, s8Read.brief.openQuestions.length], [2, 3, 2, 1])
    check('S8', 'key constraints are not dropped or truncated', s8Read.brief.constraints.every((item) => item.text.length > 0), JSON.stringify(s8Read.brief.constraints))
    check('S8', 'the complex brief stays under the hard limit', s8Read.briefWarnings.every((item) => !item.includes('hard limit')), JSON.stringify(s8Read.briefWarnings))

    console.log('\nS9: duplicate detection and merge')
    const dupCwd = '/tmp/gate1-dup'
    const base = await capture({
      title: '刷新令牌失败',
      kind: 'defect',
      touchedFiles: ['Gate1Auth.swift'],
      mustRead: [],
      nextStep: '检查刷新逻辑',
      brief: {
        goal: '修复刷新令牌后 401',
        why: '用户会话过期后请求失败',
        confirmed: [{ text: '刷新请求返回 401', basis: 'requirement' }],
        nextAction: '检查刷新逻辑',
      },
    }, dupCwd)
    const duplicate = await capture({
      title: '登录页无法继续',
      kind: 'defect',
      touchedFiles: ['Gate1Auth.swift'],
      mustRead: [],
      nextStep: '检查刷新逻辑',
      brief: { goal: '修复刷新令牌后 401', nextAction: '检查刷新逻辑' },
    }, dupCwd)
    checkEqual('S9', 'the same file plus the same goal is a duplicate', [duplicate.status, duplicate.candidateId], ['duplicate', base.id])
    check('S9', 'the duplicate result explains the match', duplicate.matchReason.includes('goal') && duplicate.goalSimilarity >= 0.65, JSON.stringify(duplicate))
    const differentGoal = await capture({
      title: '刷新令牌失败！',
      kind: 'defect',
      touchedFiles: ['Gate1Auth.swift'],
      mustRead: [],
      nextStep: '先确认主题入口',
      brief: { goal: '为登录页增加暗色主题', nextAction: '先确认主题入口' },
    }, dupCwd)
    checkEqual('S9', 'a different goal on the same file is not blocked', differentGoal.status, 'created')
    const forced = await capture({
      title: '登录页无法继续',
      kind: 'defect',
      touchedFiles: ['Gate1Auth.swift'],
      mustRead: [],
      nextStep: '检查刷新逻辑',
      brief: { goal: '修复刷新令牌后 401', nextAction: '检查刷新逻辑' },
      forceCreate: true,
    }, dupCwd)
    checkEqual('S9', 'forceCreate creates after explicit confirmation', forced.status, 'created')
    const beforeNotes = store.get(base.id).notes.length
    await noteTool.execute({ id: base.id, text: '补一条证据：刷新失败也会影响设置页', kind: 'evidence' }, execFor(fakeSession(dupCwd)))
    checkEqual('S9', 'the confirmed merge appends a note instead of a second card', [beforeNotes, store.get(base.id).notes.length, store.all().filter((record) => record.title === '刷新令牌失败').length], [0, 1, 1])

    console.log('\nS10: source-only input must fail')
    await expectRejection('S10', 'path-only capture with no brief is rejected', {
      title: '旧式路径卡',
      kind: 'defect',
      touchedFiles: ['Gate1OnlyPath.swift'],
      mustRead: [],
      nextStep: '检查文件',
    }, 'todo/brief-required')
    check('S10', 'the rejected path-only card stores nothing', !hasCard(store, '旧式路径卡'), JSON.stringify(store.all().map((record) => record.title)))
    await expectRejection('S10', 'a leads-only brief is rejected', {
      title: '只有线索的简报',
      kind: 'defect',
      touchedFiles: [],
      mustRead: [],
      nextStep: '检查线索',
      brief: { goal: '修复问题', nextAction: '检查线索', leads: [{ text: 'Gate1OnlyPath.swift', basis: 'unknown' }] },
    }, 'todo/brief-source-only')
    check('S10', 'the rejected leads-only card stores nothing', !hasCard(store, '只有线索的简报'), JSON.stringify(store.all().map((record) => record.title)))
    await expectRejection('S10', 'forceCreate does not bypass the quality gate', {
      title: '强制创建只有路径',
      kind: 'defect',
      touchedFiles: ['Gate1ForceOnly.swift'],
      mustRead: [],
      nextStep: '检查文件',
      forceCreate: true,
    }, 'todo/brief-required')
    const legacyOnly = await capture({
      title: '旧式仅下一步',
      kind: 'idea',
      touchedFiles: [],
      mustRead: [],
      nextStep: '先确认需求',
    })
    check('S10', 'a legacy title + nextStep card without paths stays compatible', legacyOnly.status === 'created' && legacyOnly.brief === false, JSON.stringify(legacyOnly))
    const legacyRead = await read(legacyOnly.id)
    checkEqual('S10', 'the legacy card projects a derived brief', [legacyRead.briefSource, legacyRead.brief.goal, legacyRead.brief.nextAction], ['derived', '旧式仅下一步', '先确认需求'])
    const legacyWithFact = await capture({
      title: '旧式路径卡带必读',
      kind: 'defect',
      touchedFiles: ['Gate1Legacy.swift'],
      mustRead: [{ label: '已确认约束', text: '只改设置页' }],
      nextStep: '按约束检查',
    })
    check('S10', 'a legacy path card with a substantive mustRead fact is still accepted', legacyWithFact.status === 'created', JSON.stringify(legacyWithFact))

    console.log('\nCONTRACT: nextStep / brief.nextAction')
    const briefOnly = await capture({
      title: '只有简报没有旧 nextStep',
      kind: 'idea',
      touchedFiles: [],
      mustRead: [],
      brief: { goal: '验证简报单独提供 nextAction', nextAction: '先做最小验证' },
    })
    const briefOnlyStored = store.get(briefOnly.id)
    checkEqual('CONTRACT', 'brief-only capture synchronizes core.nextStep', [briefOnly.status, briefOnlyStored.core.nextStep, briefOnlyStored.brief.nextAction], ['created', '先做最小验证', '先做最小验证'])
    const bothSame = await capture({
      title: '下一步一致',
      kind: 'idea',
      touchedFiles: [],
      mustRead: [],
      nextStep: '先做最小验证',
      brief: { goal: '验证两者一致', nextAction: '先做最小验证' },
    })
    check('CONTRACT', 'identical nextStep and brief.nextAction do not warn', !bothSame.warnings.some((item) => item.includes('differs from brief.nextAction')), JSON.stringify(bothSame.warnings))
    const conflict = await capture({
      title: '下一步冲突',
      kind: 'defect',
      touchedFiles: [],
      mustRead: [],
      nextStep: '旧下一步 A',
      brief: { goal: '验证 nextStep 冲突', nextAction: '简报下一步 B' },
    })
    const conflictStored = store.get(conflict.id)
    checkEqual('CONTRACT', 'brief.nextAction wins and is mirrored', [conflictStored.core.nextStep, conflictStored.brief.nextAction], ['简报下一步 B', '简报下一步 B'])
    check('CONTRACT', 'the conflict produces a diagnostic warning', conflict.warnings.some((item) => item.includes('differs from brief.nextAction')), JSON.stringify(conflict.warnings))
    try {
      await capture({
        title: '缺少下一步',
        kind: 'idea',
        touchedFiles: [],
        mustRead: [],
        brief: { goal: '明确的目标但没有下一步' },
      })
      check('CONTRACT', 'a clear goal without nextAction is rejected, not invented', false, 'no rejection')
    } catch (error) {
      // The tool schema rejects the missing required field before the handler
      // runs; the manual API/store path reaches `todo/brief-next-required`.
      const rejected = (error.code === 'todo/brief-next-required' || String(error.code).includes('INVALID_ARGS')) && /nextAction/u.test(error.message)
      check('CONTRACT', 'a clear goal without nextAction is rejected, not invented', rejected, `${error.code}: ${error.message}`)
    }
    check('CONTRACT', 'the missing-nextAction card stores nothing', !hasCard(store, '缺少下一步'), JSON.stringify(store.all().map((record) => record.title)))
    const apiMissingNext = await api.handle('create', {
      workspace: '/tmp/gate1',
      title: 'API 缺少下一步',
      kind: 'idea',
      brief: { goal: '明确的目标但没有下一步' },
    })
    check('CONTRACT', 'manual API create rejects a missing nextAction', apiMissingNext.ok === false && apiMissingNext.error.code === 'todo/brief-next-required', JSON.stringify(apiMissingNext))
    const manual = await api.handle('create', {
      workspace: '/tmp/gate1',
      title: 'API 冲突卡片',
      kind: 'idea',
      nextStep: 'API 旧下一步',
      brief: { goal: 'API 目标', nextAction: 'API 简报下一步' },
    })
    check('CONTRACT', 'manual API create makes brief.nextAction canonical', manual.ok === true && manual.value.item.nextStep === 'API 简报下一步', JSON.stringify(manual))
    check('CONTRACT', 'manual API create reports the conflict', manual.ok === true && manual.value.warnings?.some((item) => item.includes('differs from brief.nextAction')), JSON.stringify(manual))
    const patchedNext = applyPatch(briefOnlyStored, { nextStep: '更新后的下一步' }, now())
    checkEqual('CONTRACT', 'patch nextStep updates brief.nextAction', [patchedNext.core.nextStep, patchedNext.brief.nextAction], ['更新后的下一步', '更新后的下一步'])
    const patchedBrief = applyPatch(briefOnlyStored, { brief: { goal: '更新后的目标', nextAction: '更新后的目标下一步' } }, now())
    checkEqual('CONTRACT', 'patch brief updates core.nextStep', [patchedBrief.core.nextStep, patchedBrief.brief.nextAction], ['更新后的目标下一步', '更新后的目标下一步'])
    const inconsistent = {
      ...briefOnlyStored,
      id: 'td_gate1_inconsistent',
      major: 99,
      minor: 1,
      core: { ...briefOnlyStored.core, nextStep: '旧 nextStep' },
      brief: { ...briefOnlyStored.brief, nextAction: '简报 nextAction' },
    }
    await domain.table('todos').put('td_gate1_inconsistent', inconsistent)
    const inconsistentFull = projectFull(store.get('td_gate1_inconsistent'))
    checkEqual('CONTRACT', 'full projection canonicalizes core.nextStep', inconsistentFull.core.nextStep, '简报 nextAction')
    check('CONTRACT', 'full projection warns about the stale mirror', inconsistentFull.briefWarnings.some((item) => item.includes('differed')), JSON.stringify(inconsistentFull.briefWarnings))
    checkEqual('CONTRACT', 'list projection also uses the canonical next action', projectL0(store.get('td_gate1_inconsistent')).nextStep, '简报 nextAction')

    console.log('\nPERSIST: legacy fixture and reopen')
    const old = store.get('td_old01')
    const oldFull = projectFull(old)
    checkEqual('PERSIST', 'the version-1 fixture still opens and derives a brief', [oldFull.briefSource, oldFull.brief.goal], ['derived', '删除最后一种语言时列表异常'])
    checkEqual('PERSIST', 'the old card has no stored brief on disk', old.brief, undefined)
    const oldRead = await read('td_old01')
    checkEqual('PERSIST', 'todo_read exposes the derived brief', oldRead.briefSource, 'derived')
    check('PERSIST', 'the old card is not presented as verified', oldRead.briefWarnings.some((item) => item.includes('no confirmed/decided/verified')), JSON.stringify(oldRead.briefWarnings))

    await domain.close()
    const reopened = await ctx.storageDomain.open(spec)
    const reopenedStore = createStore(reopened)
    const reopenedS1 = reopenedStore.get(s1.id)
    check('PERSIST', 'the stored brief survives close/reopen', reopenedS1.brief !== undefined && reopenedS1.brief.goal === '给设置页增加深色模式开关', JSON.stringify(reopenedS1?.brief))
    const reopenedS7 = reopenedStore.get(s7.id)
    checkEqual('PERSIST', 'the simple brief survives close/reopen', [reopenedS7.brief.goal, reopenedS7.brief.nextAction], ['支持批量导入', '先验证解析性能'])
    const reopenedOld = reopenedStore.get('td_old01')
    check('PERSIST', 'the old card remains brief-free after reopen', reopenedOld.brief === undefined)
    checkEqual('PERSIST', 'the old card still derives a brief after reopen', projectFull(reopenedOld).briefSource, 'derived')
    const file = await readFile(join(root, 'todo_assistant.json'), 'utf8')
    check('PERSIST', 'the single-layout file stays at version 1', file.includes('"version": 1'))
    check('PERSIST', 'the single-layout file contains the new brief', file.includes('给设置页增加深色模式开关'))
    await reopened.close()

    console.log('\nGate 1 deterministic scenario summary')
    for (const [id, entry] of buckets) {
      const status = entry.failures === 0 ? 'PASS' : 'FAIL'
      console.log(`  ${status} ${id} ${entry.title} (${entry.checks - entry.failures}/${entry.checks})`)
    }
    console.log('\nNot covered here (requires semantic/live probes; never infer from this script):')
    console.log('  - whether the model produces the expected brief instead of a path list');
    console.log('  - whether the model avoids todo_recall when the current context is sufficient');
    console.log('  - whether the model asks the developer on conflict/missing information');
    console.log('  - whether the model invents facts or mechanically fills every field');
    console.log('\nA green run means deterministic coverage passed, not that Gate 1 passed.')
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
