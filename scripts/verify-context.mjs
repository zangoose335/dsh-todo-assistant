/**
 * Headless verification of PLAN.md B4 — phase context pack and handoff.
 *
 * It runs the real storage hub / JSON backend / storage-domain facility, builds
 * a project with dependencies and a recorded result, and checks:
 *
 *   1. the pack's fields (project/phase, current flag, direct prerequisites and
 *      their results, project+phase decisions, must-keep, acceptance, risks,
 *      unresolved notes, workspace rules, pending proposals);
 *   2. source pointers: three layers merged, de-duplicated, capped, no bodies;
 *   3. `phaseId` omission uses the current phase, with clear errors otherwise;
 *   4. `plan.context` is read-only and does not bump the version;
 *   5. the rendered handoff text: sections, "result not recorded", the 4,000
 *      character bound, truncation hint, and no body leakage;
 *   6. `todo_plan_context` tool schema/render/errors;
 *   7. ordinary cards are unaffected and the pack survives a reopen.
 *
 * Usage: node scripts/verify-context.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { CONTEXT_SOURCE_LIMIT, CONTEXT_TEXT_LIMIT, createTodoSpec, renderPhaseContextText } from '../domain.js'
import { createTodoPlanContextTool } from '../tool.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'todo_assistant.v1.json')

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

/** Assert a tool result matches its closed output schema. */
function checkOutput(tool, value, label) {
  const properties = tool.output.schema.properties ?? {}
  const declared = new Set(Object.keys(properties))
  const extra = Object.keys(value).filter((key) => !declared.has(key))
  const required = tool.output.schema.required ?? []
  const missing = required.filter((key) => !(key in value))
  check(`${label}: output stays inside its schema`, extra.length === 0 && missing.length === 0, `extra=${extra.join(',')} missing=${missing.join(',')}`)
}

/** Detect `undefined` values that would make a wire value non-lossless JSON. */
function checkLossless(label, value) {
  const bad = []
  const walk = (item, path) => {
    if (item === undefined) {
      bad.push(path)
      return
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, `${path}[${index}]`))
      return
    }
    if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) walk(child, `${path}.${key}`)
    }
  }
  walk(value, '$')
  check(label, bad.length === 0, bad.join(', '))
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

/** Expect one tool call to throw with `code`. */
async function expectToolCode(label, run, code) {
  try {
    await run()
    check(`${label} → ${code}`, false, 'no error was thrown')
  } catch (error) {
    check(`${label} → ${code}`, error?.code === code, `got ${error?.code ?? error?.message}`)
  }
}

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)

  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-context-'))
  const dataPath = join(root, 'todo_assistant.json')
  console.log(`temp storage root: ${root}`)

  const ctx = new Context()
  try {
    await copyFile(FIXTURE, dataPath)
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    const domain = await ctx.storageDomain.open(spec)
    const store = createStore(domain)
    const clock = { value: 1_800_400_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })
    const detail = async (id) => (await call(api, 'plan.detail', { id })).item

    console.log('\nB4 §1 set up a plan with prerequisites, results, sources and rules')
    const workspace = '/tmp/context-ws'
    const created = await call(api, 'plan.create', {
      workspace,
      name: 'B4 交接',
      goal: '为指定阶段生成上下文包',
      sources: [{ sid: 's_proj', kind: 'file', label: 'PLAN', where: { file: 'docs/PLAN.md' } }],
      decisions: [{ label: '决定', text: '交接文本不超过 4000 字' }],
      risks: [{ label: '风险', text: '来源可能过期' }],
    })
    const projectId = created.item.id
    const addOne = await call(api, 'plan.phase.add', {
      id: projectId,
      title: '数据模型',
      number: '1',
      goal: '建表',
      acceptance: [{ label: '验收', text: '旧文件可开' }],
      mustKeep: [{ label: '约束', text: 'DOMAIN_VERSION 不变' }],
      decisions: [{ label: '决定', text: '字段保持 optional' }],
      sources: [{ sid: 's_p1', kind: 'file', label: 'B1 文档', where: { file: 'docs/B1.md' } }],
    })
    const p1 = addOne.change.affectedPhaseIds[0]
    const extraSources = Array.from({ length: 12 }, (_, index) => ({
      sid: `s_p2_${index}`,
      kind: 'file',
      label: `P2 来源 ${index}`,
      where: { file: `docs/p2-${index}.md` },
    }))
    const addTwo = await call(api, 'plan.phase.add', {
      id: projectId,
      title: '接口',
      number: '2',
      goal: '写接口',
      dependsOn: [p1],
      acceptance: [{ label: '验收', text: '端点可调' }],
      sources: [
        { sid: 's_proj', kind: 'file', label: 'PLAN', where: { file: 'docs/PLAN.md' } },
        ...extraSources,
      ],
    })
    const p2 = addTwo.change.affectedPhaseIds[0]
    const addThree = await call(api, 'plan.phase.add', {
      id: projectId,
      title: '交接',
      number: '3',
      goal: '做交接',
      nextStep: '生成上下文包',
      dependsOn: [p2],
      acceptance: [{ label: '验收', text: '新会话能读懂' }],
      mustKeep: [{ label: '约束', text: '不传历史正文' }],
      decisions: [{ label: '决定', text: '交接文本不超过 4000 字' }],
      sources: [{ sid: 's_p3', kind: 'file', label: 'B4 文档', where: { file: 'docs/B4.md' } }],
    })
    const p3 = addThree.change.affectedPhaseIds[0]
    await call(api, 'plan.phase.status', { id: projectId, phaseId: p1, status: 'done' })
    await call(api, 'plan.phase.result', {
      id: projectId,
      phaseId: p1,
      sessionId: 's-b4',
      result: { summary: '数据层完成', completed: ['三张表'], tests: [{ command: 'node verify-domain', status: 'passed' }] },
    })
    await call(api, 'plan.phase.status', { id: projectId, phaseId: p2, status: 'active' })
    await call(api, 'plan.phase.update', {
      id: projectId,
      phaseId: p3,
      patch: { notes: [{ kind: 'no-result', text: '没找到旧导出实现', fromSession: 's-b4', turn: 2, sourceIds: ['s_p3'] }] },
    })
    await call(api, 'plan.patch', { id: projectId, patch: { currentPhaseId: p3 } })
    await store.setRules(workspace, '一次只改一个文件\n先解释影响面', tick)
    const proposal = await store.addProposal(
      { projectId, baseVersion: (await detail(projectId)).version, patch: { goal: '新的总体目标' }, reason: '验证待处理数' },
      tick(),
    )
    checkEqual('setup created one pending proposal', proposal.status, 'pending')

    console.log('\nB4 §2 pack fields')
    const pack = (await call(api, 'plan.context', { id: projectId })).pack
    checkEqual('the default phase is the current phase', [pack.phase.number, pack.phase.title, pack.isCurrent], ['3', '交接', true])
    checkEqual('the project header and current phase are present', [pack.project.name, pack.project.status, pack.project.currentPhase.number], ['B4 交接', 'active', '3'])
    checkEqual(
      'the phase carries the goal and next step',
      [pack.phase.goal, pack.phase.nextStep, pack.phase.status],
      ['做交接', '生成上下文包', 'pending'],
    )
    checkEqual(
      'prerequisites are the direct dependencies only',
      pack.prerequisites.map((entry) => [entry.number, entry.status, entry.result === null]),
      [['2', 'active', true]],
    )
    checkEqual(
      'decisions carry their scope',
      pack.decisions.map((entry) => [entry.scope, entry.text]),
      [['project', '交接文本不超过 4000 字'], ['phase', '交接文本不超过 4000 字']],
    )
    checkEqual('must-keep comes from the phase', pack.mustKeep.map((entry) => entry.text), ['不传历史正文'])
    checkEqual('acceptance comes from the phase', pack.acceptance.map((entry) => entry.text), ['新会话能读懂'])
    checkEqual('risks come from the project', pack.risks.map((entry) => entry.text), ['来源可能过期'])
    checkEqual('unresolved lists the no-result note', pack.unresolved, ['没找到旧导出实现'])
    checkEqual('workspace rules travel with the pack', pack.rules, '一次只改一个文件\n先解释影响面')
    checkEqual('the pending proposal count is filled', pack.pendingProposalCount, 1)
    checkEqual('sources are capped', pack.sources.length, CONTEXT_SOURCE_LIMIT)
    check(
      'sources are de-duplicated pointers without bodies',
      new Set(pack.sources.map((source) => JSON.stringify([source.sid, source.kind, source.where ?? null]))).size === pack.sources.length &&
        pack.sources.every((source) => !Object.hasOwn(source, 'text')),
      JSON.stringify(pack.sources.map((source) => source.sid)),
    )
    checkLossless('the pack is lossless JSON', pack)

    const first = (await call(api, 'plan.context', { id: projectId, phaseId: p1 })).pack
    checkEqual(
      'an explicit phase overrides the current phase',
      [first.phase.number, first.phase.status, first.isCurrent],
      ['1', 'done', false],
    )
    checkEqual('a phase without dependencies has no prerequisites', first.prerequisites.length, 0)
    const second = (await call(api, 'plan.context', { id: projectId, phaseId: p2 })).pack
    checkEqual('the direct prerequisite of phase 2 is phase 1', second.prerequisites.map((entry) => entry.number), ['1'])
    checkEqual('phase 2 carries the recorded result of phase 1', second.prerequisites[0].result?.summary, '数据层完成')

    console.log('\nB4 §3 read-only and error paths')
    const versionBefore = (await detail(projectId)).version
    await call(api, 'plan.context', { id: projectId })
    checkEqual('plan.context does not bump the project version', (await detail(projectId)).version, versionBefore)
    const noCurrent = await call(api, 'plan.create', { workspace, name: '无当前', goal: '没有当前阶段' })
    const noCurrentPhase = await call(api, 'plan.phase.add', { id: noCurrent.item.id, title: '唯一', number: '1' })
    await expectCode('a project without a current phase needs phaseId', api, 'plan.context', { id: noCurrent.item.id }, 'plan/phase-required')
    const explicit = (await call(api, 'plan.context', { id: noCurrent.item.id, phaseId: noCurrentPhase.change.affectedPhaseIds[0] })).pack
    checkEqual('an explicit phase still works without a current phase', explicit.phase.number, '1')
    await expectCode('an unknown phase is rejected', api, 'plan.context', { id: projectId, phaseId: 'ph_missing' }, 'plan/phase-not-found')
    await expectCode('an unknown project is rejected', api, 'plan.context', { id: 'pj_missing' }, 'plan/not-found')

    console.log('\nB4 §4 handoff text')
    const text = renderPhaseContextText(pack)
    check('the text opens with the plan and phase', text.startsWith('Plan handoff: B4 交接 — phase 3 交接'), text.slice(0, 80))
    check('the text carries the overall and phase goals', text.includes('Overall goal: 为指定阶段生成上下文包') && text.includes('This phase goal: 做交接'))
    check('the text carries the next step', text.includes('Next step: 生成上下文包'))
    check('the text says a missing prerequisite result is not recorded', text.includes('result not recorded'))
    check('the text carries decisions, acceptance, risks and unresolved', text.includes('Decisions:') && text.includes('Acceptance:') && text.includes('Risks:') && text.includes('Unresolved:'))
    check('the text carries the workspace rules', text.includes('Workspace rules:') && text.includes('先解释影响面'))
    check('the text lists source pointers', text.includes('[file]') && text.includes('docs/B4.md'))
    check('the text includes the handoff instructions', text.includes('Do not read history bodies') && text.includes('report it to the developer'))
    check('the text stays within 4,000 characters', [...text].length <= CONTEXT_TEXT_LIMIT, `${[...text].length}`)

    const huge = {
      ...pack,
      decisions: Array.from({ length: 80 }, (_, index) => ({ scope: 'phase', text: `决定 ${index} ${'字'.repeat(200)}` })),
      sources: Array.from({ length: 40 }, (_, index) => ({
        sid: `s${index}`,
        kind: 'file',
        label: `来源 ${index} ${'x'.repeat(200)}`,
        where: { file: `f${index}` },
      })),
    }
    const hugeText = renderPhaseContextText(huge)
    check('a huge pack is truncated to the limit', [...hugeText].length <= CONTEXT_TEXT_LIMIT, `${[...hugeText].length}`)
    check('the truncated text says so', hugeText.includes('truncated'), hugeText.slice(-160))
    const tinyText = renderPhaseContextText(huge, { limit: 200 })
    check('a small explicit limit is respected too', [...tinyText].length <= 200, `${[...tinyText].length}`)

    console.log('\nB4 §5 todo_plan_context tool')
    const tool = createTodoPlanContextTool({ defineTool, store })
    const result = await tool.execute({ projectId })
    checkEqual('the tool returns the context shape', result.shape, 'context')
    checkOutput(tool, result, 'todo_plan_context')
    const rendered = tool.output.render({}, result)
    check(
      'the tool render is one bounded text block',
      Array.isArray(rendered) && rendered[0]?.type === 'text' && [...rendered[0].text].length <= CONTEXT_TEXT_LIMIT,
      JSON.stringify(rendered?.[0]?.type),
    )
    check('the tool render names the phase', rendered[0].text.includes('phase 3 交接'))
    await expectToolCode('the tool rejects an unknown project', () => tool.execute({ projectId: 'pj_missing' }), 'plan/not-found')
    await expectToolCode('the tool rejects an unknown phase', () => tool.execute({ projectId, phaseId: 'ph_missing' }), 'plan/phase-not-found')
    await expectToolCode('the tool needs a project id', () => tool.execute({ projectId: '' }), 'plan/project-required')

    console.log('\nB4 §6 ordinary cards and durability')
    const card = await call(api, 'create', { workspace, title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('an ordinary card still has no project link', [card.item.projectId, card.item.phaseId], [null, null])
    await domain.close()
    const reopened = await ctx.storageDomain.open(spec)
    const reopenedStore = createStore(reopened)
    const reopenedApi = createApi({ store: reopenedStore, now: tick })
    const reopenedPack = (await call(reopenedApi, 'plan.context', { id: projectId })).pack
    checkEqual('a reopened project still resolves the current phase', reopenedPack.phase.number, '3')
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
