/**
 * Headless verification of PLAN.md B3 — deterministic Markdown plan import,
 * preview, confirmed commit, and Markdown export.
 *
 * It runs the real storage hub / JSON backend / storage-domain facility over a
 * copy of the version-1 fixture and drives `plan.import.*` / `plan.export`
 * through `api.js`, plus the pure parser/renderer directly for round-trips.
 *
 * Covered:
 *   1. parsing the fixture (phases, sub-phase, dependencies, acceptance,
 *      context, decisions, risks, result) with inferred items and unclassified
 *      lines, and code fences ignored;
 *   2. preview never writes storage;
 *   3. commit requires `confirmedInferred` when anything was inferred; a
 *      committed project matches the preview and drops unclassified lines;
 *   4. unresolved dependency bindings are marked and always block commit;
 *   5. malformed input rejects with a specific `plan/import-*` code;
 *   6. export: default JSON unchanged, `format:'markdown'` renders re-parseable
 *      syntax, unknown formats reject;
 *   7. export → preview round-trip is structurally equivalent;
 *   8. ordinary cards are unaffected and the committed plan is durable.
 *
 * Usage: node scripts/verify-import.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 *        IMPORT_FIXTURE   (default: scripts/fixtures/plan.md)
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { PLAN_LIMITS, createTodoSpec } from '../domain.js'
import { writePlanMarkdown } from '../plan-export.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = process.env.IMPORT_FIXTURE ?? join(HERE, 'fixtures', 'plan.md')
const DATA_FIXTURE = join(HERE, 'fixtures', 'todo_assistant.v1.json')

const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)

let checks = 0
let failures = 0

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

/** Expect one wire endpoint to fail with `code`. */
async function expectCode(label, api, endpoint, payload, code) {
  const result = await api.handle(endpoint, payload)
  const actual = result.ok === false ? result.error?.code : 'ok'
  check(`${label} → ${code}`, actual === code, `got ${actual}: ${JSON.stringify(result)}`)
}

/** Expect one async call to reject with a user-facing message. */
async function expectReject(label, run, pattern) {
  try {
    await run()
    check(label, false, 'no error was thrown')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, pattern.test(message), message)
  }
}

/** A whitespace/order-normalized view of a preview for round-trip comparison. */
function normalized(preview) {
  return {
    name: preview.name,
    goal: preview.goal,
    decisions: [...preview.decisions].sort(),
    risks: [...preview.risks].sort(),
    phases: preview.phases
      .map((phase) => ({
        number: phase.number,
        title: phase.title,
        goal: phase.goal,
        nextStep: phase.nextStep,
        parent: phase.parentNumber ?? null,
        dependsOn: phase.dependsOn.map((ref) => ref.replace(/^(?:Phase|阶段)\s*/iu, '').trim()),
        acceptance: phase.acceptance,
        mustKeep: phase.mustKeep,
        decisions: phase.decisions,
        result: phase.resultSummary,
      }))
      .sort((left, right) => left.number.localeCompare(right.number)),
  }
}

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)
  console.log(`fixture: ${FIXTURE}`)

  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-import-'))
  const dataPath = join(root, 'todo_assistant.json')
  console.log(`temp storage root: ${root}`)

  const ctx = new Context()
  try {
    await copyFile(DATA_FIXTURE, dataPath)
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    const domain = await ctx.storageDomain.open(spec)
    const store = createStore(domain)
    const clock = { value: 1_800_300_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })
    const text = await readFile(FIXTURE, 'utf8')

    console.log('\nB3 §1 parse the fixture')
    const preview = (await call(api, 'plan.import.preview', { text })).preview
    checkEqual(
      'project name and goal',
      [preview.name, preview.goal],
      ['计划导入示例', '用一个 Markdown 计划验证 B3 的解析、预览与 round-trip。'],
    )
    checkEqual(
      'phase tree keeps sub-phase parents',
      preview.phases.map((phase) => [phase.number, phase.parentNumber ?? null]),
      [['1', null], ['2', null], ['2a', '2']],
    )
    checkEqual(
      'dependency references stay raw',
      [preview.phases[1].dependsOn, preview.phases[2].dependsOn],
      [['1'], ['Phase 2']],
    )
    checkEqual('project decisions and risks', [preview.decisions.length, preview.risks.length], [2, 1])
    checkEqual(
      'phase sections are split correctly',
      [
        preview.phases[0].goal,
        preview.phases[0].acceptance.length,
        preview.phases[0].nextStep,
        preview.phases[1].decisions.length,
        preview.phases[1].resultSummary,
        preview.phases[2].mustKeep.length,
      ],
      ['引入 Project Plan schema 与三张表', 2, '补 schema 与表', 1, 'B1/B2 已完成', 1],
    )
    checkEqual(
      'inferred: one auto number plus two dependency bindings',
      preview.inferred.map((item) => item.kind).sort(),
      ['dependency', 'dependency', 'number'],
    )
    check(
      'every dependency binding is resolved to a target',
      preview.inferred.filter((item) => item.kind === 'dependency').every((item) => item.resolved === true && typeof item.target === 'string'),
      JSON.stringify(preview.inferred),
    )
    checkEqual(
      'code fences are ignored and the table is unclassified',
      preview.unclassified.map((item) => item.text),
      ['| 表格 | 无法识别 |', '| --- | --- |'],
    )
    checkEqual('clean fixture has no warnings', preview.warnings.length, 0)
    checkEqual('stats', [preview.stats.phases, preview.stats.roots, preview.stats.unclassified], [3, 2, 2])

    const spaced = (
      await call(api, 'plan.import.preview', {
        text: '# 空行计划\n\n目标段落\n\n## Phase 1: A\nGoal:\n逐行目标\nAcceptance:\n\n- 一条验收\n',
      })
    ).preview
    checkEqual(
      'a blank after a label is fine for lists and empty single values',
      [spaced.phases[0].goal, spaced.phases[0].acceptance],
      ['逐行目标', ['一条验收']],
    )

    const chinese = (
      await call(api, 'plan.import.preview', {
        text: '# 中文计划\n\n目标段落\n\n## 阶段 1：模型\n目标: 建表\n验收:\n- 可开\n依赖:\n- 2\n\n## 阶段 2：接口\n上下文:\n- 只读\n',
      })
    ).preview
    checkEqual('Chinese labels and full-width colon parse', [chinese.name, chinese.phases[0].goal, chinese.phases[0].acceptance], ['中文计划', '建表', ['可开']])
    checkEqual(
      'Chinese dependency and context sections parse',
      [chinese.phases[0].dependsOn, chinese.phases[1].mustKeep, chinese.inferred[0].target],
      [['2'], ['只读'], '2'],
    )

    console.log('\nB3 §2 preview never writes')
    const tableSizes = () => [domain.table('projects').size, domain.table('plan_proposals').size, domain.table('plan_changes').size]
    const sizesBefore = tableSizes()
    await call(api, 'plan.import.preview', { text })
    checkEqual('all plan tables are unchanged after previewing', tableSizes(), sizesBefore)
    await expectCode('a missing preview is rejected', api, 'plan.import.commit', {}, 'plan/import-preview-required')

    console.log('\nB3 §3 commit requires confirmation and matches the preview')
    await expectCode(
      'unconfirmed inferences block the commit',
      api,
      'plan.import.commit',
      { preview, workspace: '/tmp/import-ws' },
      'plan/import-inferred-unconfirmed',
    )
    const stripped = JSON.parse(JSON.stringify(preview))
    stripped.inferred = []
    await expectCode(
      'editing the inferred list away does not bypass the gate',
      api,
      'plan.import.commit',
      { preview: stripped, workspace: '/tmp/import-ws' },
      'plan/import-inferred-unconfirmed',
    )
    const simplePreview = (
      await call(api, 'plan.import.preview', { text: '# 简单计划\n\n只有一个阶段。\n\n## Phase 1: 只有一步\nGoal: 干活\n' })
    ).preview
    checkEqual('a preview without inferences or dependencies has nothing to confirm', simplePreview.inferred.length, 0)
    const simpleCommit = await call(api, 'plan.import.commit', { preview: simplePreview, workspace: '/tmp/import-ws' })
    checkEqual('a no-inference commit needs no confirmation flag', simpleCommit.item.phaseCount, 1)
    const noGoal = (await call(api, 'plan.import.preview', { text: '# 无目标\n\n## Phase 1: A\n' })).preview
    await expectCode(
      'a preview without a goal is rejected at commit',
      api,
      'plan.import.commit',
      { preview: noGoal, workspace: '/tmp/import-ws' },
      'plan/goal',
    )
    const committed = await call(api, 'plan.import.commit', { preview, workspace: '/tmp/import-ws', confirmedInferred: true })
    const projectId = committed.item.id
    check('the imported project id is backend-safe', /^pj_[a-z0-9]{4}$/u.test(projectId), projectId)
    const item = (await call(api, 'plan.detail', { id: projectId })).item
    const byPid = new Map(item.phases.map((phase) => [phase.pid, phase]))
    checkEqual(
      'committed phases keep their numbers and parents',
      item.phases.map((phase) => [phase.number, phase.parentPid === undefined ? null : byPid.get(phase.parentPid)?.number]),
      [['1', null], ['2', null], ['2a', '2']],
    )
    checkEqual(
      'dependencies bind to the phase pids',
      [item.phases[1].dependsOn, item.phases[2].dependsOn],
      [[item.phases[0].pid], [item.phases[1].pid]],
    )
    checkEqual(
      'project decisions/risks are stored as decided evidence',
      [item.decisions.map((entry) => entry.basis), item.risks.map((entry) => entry.basis)],
      [['decided', 'decided'], ['decided']],
    )
    checkEqual(
      'the imported result summary defaults to claimed',
      [item.phases[1].result?.summary, item.phases[1].result?.verification],
      ['B1/B2 已完成', 'claimed'],
    )
    checkEqual('unclassified lines are not stored', item.phases.length, 3)
    checkEqual('the commit records a create change', (await call(api, 'plan.change.list', { id: projectId })).items[0].kind, 'create')

    console.log('\nB3 §4 unresolved dependencies')
    const unresolvedText = '# 未解析计划\n\n## Phase 1: A\nDepends on:\n- 99\n'
    const unresolvedPreview = (await call(api, 'plan.import.preview', { text: unresolvedText })).preview
    checkEqual(
      'an unresolved dependency is marked in the preview',
      [unresolvedPreview.inferred.length, unresolvedPreview.inferred[0].resolved],
      [1, false],
    )
    await expectCode(
      'an unresolved dependency always blocks the commit',
      api,
      'plan.import.commit',
      { preview: unresolvedPreview, workspace: '/tmp/import-ws', confirmedInferred: true },
      'plan/import-unresolved-dependency',
    )
    const edited = JSON.parse(JSON.stringify(preview))
    edited.phases[0].dependsOn = ['99']
    await expectCode(
      'an edited preview with a bad dependency is rejected too',
      api,
      'plan.import.commit',
      { preview: edited, workspace: '/tmp/import-ws', confirmedInferred: true },
      'plan/import-unresolved-dependency',
    )
    const cyclic = (
      await call(api, 'plan.import.preview', {
        text: '# 环\n\n验证提交时的环校验。\n\n## Phase 1: A\nDepends on:\n- 2\n\n## Phase 2: B\nDepends on:\n- 1\n',
      })
    ).preview
    check('a cyclic plan still previews with resolved bindings', cyclic.inferred.every((entry) => entry.resolved === true))
    await expectCode(
      'a dependency cycle is rejected by B2 at commit',
      api,
      'plan.import.commit',
      { preview: cyclic, workspace: '/tmp/import-ws', confirmedInferred: true },
      'plan/phase-dependency-cycle',
    )

    console.log('\nB3 §5 malformed input')
    await expectCode('empty text', api, 'plan.import.preview', { text: '' }, 'plan/import-empty')
    await expectCode('whitespace-only text', api, 'plan.import.preview', { text: ' \n\t ' }, 'plan/import-empty')
    await expectCode('missing level-1 title', api, 'plan.import.preview', { text: '## Phase 1: A\n' }, 'plan/import-title-required')
    await expectCode('orphan sub-phase', api, 'plan.import.preview', { text: '# P\n\n### Phase 1a: x\n' }, 'plan/import-orphan-subphase')
    await expectCode(
      'duplicate display number',
      api,
      'plan.import.preview',
      { text: '# P\n\n## Phase 1: A\n\n## Phase 1: B\n' },
      'plan/import-duplicate-number',
    )
    await expectCode('empty phase title', api, 'plan.import.preview', { text: '# P\n\n## Phase 1:\n' }, 'plan/import-phase-title-required')
    await expectCode(
      'text over the import limit',
      api,
      'plan.import.preview',
      { text: `# ${'x'.repeat(PLAN_LIMITS.importText)}` },
      'plan/import-text-too-long',
    )

    console.log('\nB3 §6 export')
    const jsonExport = await call(api, 'plan.export', { id: projectId })
    checkEqual(
      'the default export is still the JSON snapshot',
      [jsonExport.project.id, jsonExport.changes.length >= 1],
      [projectId, true],
    )
    const markdown = await call(api, 'plan.export', { id: projectId, format: 'markdown' })
    checkEqual(
      'the markdown export reports its shape',
      [markdown.id, markdown.format, markdown.version],
      [projectId, 'markdown', jsonExport.project.version],
    )
    check(
      'the markdown export carries the minimal syntax',
      markdown.markdown.includes('# 计划导入示例') &&
        markdown.markdown.includes('## Phase 1: 数据模型') &&
        markdown.markdown.includes('### Phase 2a: 预览器') &&
        markdown.markdown.includes('Depends on:') &&
        markdown.markdown.includes('Result: B1/B2 已完成'),
      markdown.markdown.slice(0, 200),
    )
    await expectCode('an unknown export format is rejected', api, 'plan.export', { id: projectId, format: 'yaml' }, 'plan/invalid-export-format')

    const exportDir = await mkdtemp(join(tmpdir(), 'todo-assistant-export-'))
    const exported = await writePlanMarkdown({ workspace: exportDir, name: 'B3 计划/导入', content: markdown.markdown })
    checkEqual('the export file is written into the workspace', exported.fileName, 'B3 计划-导入.md')
    checkEqual('the export file contains the markdown', await readFile(exported.path, 'utf8'), markdown.markdown)
    const second = await writePlanMarkdown({ workspace: exportDir, name: 'B3 计划/导入', content: markdown.markdown })
    checkEqual('an existing export is never overwritten', second.fileName, 'B3 计划-导入-2.md')
    await expectReject(
      'an inbox plan cannot be exported to a folder',
      () => writePlanMarkdown({ workspace: 'inbox', name: 'x', content: 'x' }),
      /收件箱/u,
    )
    await expectReject(
      'a missing workspace folder is rejected',
      () => writePlanMarkdown({ workspace: join(exportDir, 'missing'), name: 'x', content: 'x' }),
      /不存在/u,
    )
    await rm(exportDir, { recursive: true, force: true })

    const writes = []
    const writerApi = createApi({
      store,
      now: tick,
      writePlanFile: async (request) => {
        writes.push(request)
        return { path: '/tmp/fake.md', fileName: 'fake.md' }
      },
    })
    const written = await call(writerApi, 'plan.export', { id: projectId, format: 'markdown', write: true })
    checkEqual(
      'the endpoint forwards workspace/name/markdown to the writer',
      [writes.length, writes[0].workspace, writes[0].name, writes[0].content === markdown.markdown],
      [1, '/tmp/import-ws', '计划导入示例', true],
    )
    checkEqual('the endpoint returns the written path', [written.path, written.fileName], ['/tmp/fake.md', 'fake.md'])
    const plainApi = createApi({ store, now: tick })
    await expectCode(
      'writing without a writer is rejected',
      plainApi,
      'plan.export',
      { id: projectId, format: 'markdown', write: true },
      'plan/export-unavailable',
    )
    const failingApi = createApi({
      store,
      now: tick,
      writePlanFile: async () => {
        throw new Error('磁盘满了')
      },
    })
    await expectCode(
      'a writer failure is reported as a plan error',
      failingApi,
      'plan.export',
      { id: projectId, format: 'markdown', write: true },
      'plan/export-file',
    )

    console.log('\nB3 §7 export → preview round-trip')
    const reparsed = (await call(api, 'plan.import.preview', { text: markdown.markdown })).preview
    checkEqual('round-trip is structurally equivalent', normalized(reparsed), normalized(preview))
    checkEqual('round-trip keeps the result summary', reparsed.phases[1].resultSummary, 'B1/B2 已完成')
    checkEqual(
      'round-trip keeps dependency bindings inferred',
      reparsed.inferred.filter((item) => item.kind === 'dependency').length,
      2,
    )

    console.log('\nB3 §8 the A-E roadmap fixture')
    const roadmapText = await readFile(join(HERE, 'fixtures', 'plan-a-e.md'), 'utf8')
    const roadmap = (await call(api, 'plan.import.preview', { text: roadmapText })).preview
    checkEqual(
      'the roadmap keeps phases A-E with B1/B2 children',
      roadmap.phases.map((phase) => [phase.number, phase.parentNumber ?? null]),
      [['A', null], ['B', null], ['B1', 'B'], ['B2', 'B'], ['C', null], ['D', null], ['E', null]],
    )
    checkEqual(
      'the roadmap dependencies are kept',
      roadmap.phases.map((phase) => phase.dependsOn),
      [[], ['A'], ['B'], ['B1'], ['B'], ['B2'], ['B']],
    )
    checkEqual(
      'every roadmap dependency is inferred and resolved',
      [roadmap.inferred.length, roadmap.inferred.every((item) => item.resolved === true)],
      [6, true],
    )
    checkEqual('the roadmap has no unclassified content', roadmap.unclassified.length, 0)
    const roadmapSaved = await call(api, 'plan.import.commit', {
      preview: roadmap,
      workspace: '/tmp/import-ws',
      confirmedInferred: true,
    })
    const roadmapDetail = (await call(api, 'plan.detail', { id: roadmapSaved.item.id })).item
    checkEqual('the saved roadmap keeps A-E', roadmapDetail.phases.map((phase) => phase.number), ['A', 'B', 'B1', 'B2', 'C', 'D', 'E'])
    const roadmapByPid = new Map(roadmapDetail.phases.map((phase) => [phase.pid, phase.number]))
    checkEqual(
      'B1/B2 are children of B',
      roadmapDetail.phases.filter((phase) => phase.parentPid !== undefined).map((phase) => [phase.number, roadmapByPid.get(phase.parentPid)]),
      [['B1', 'B'], ['B2', 'B']],
    )
    const letterAuto = (
      await call(api, 'plan.import.preview', {
        text: '# 字母自动编号\n\n验证字母父阶段的子编号。\n\n## Phase A: 父\n### Phase A: 子一\n### Phase A: 子二\n',
      })
    ).preview
    checkEqual('a letter parent auto-numbers children with digits', letterAuto.phases.map((phase) => phase.number), ['A', 'A1', 'A2'])

    console.log('\nB3 §9 ordinary cards and durability')
    const card = await call(api, 'create', { workspace: '/tmp/import-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('an ordinary card still has no project link', [card.item.projectId, card.item.phaseId], [null, null])
    await domain.close()
    const stored = JSON.parse(await readFile(dataPath, 'utf8'))
    checkEqual('the file stays unit version 1', stored.unit.version, 1)
    check(
      'the imported project is persisted',
      stored.tables.projects?.[projectId]?.phases?.length === 3,
      JSON.stringify(stored.tables.projects?.[projectId]?.phases?.map((phase) => phase.number)),
    )
    const reopened = await ctx.storageDomain.open(spec)
    const reopenedStore = createStore(reopened)
    checkEqual('a reopened project keeps its three phases', reopenedStore.getProject(projectId)?.phases.length, 3)
    checkEqual('reopened legacy cards are intact', reopenedStore.get('td_old01')?.title, '语言列表删除异常')
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
