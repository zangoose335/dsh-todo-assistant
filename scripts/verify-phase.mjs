/**
 * Headless verification of PLAN.md B2 — phases, sub-phases, dependencies,
 * acceptance, status, execution results, and the read-only plan tool.
 *
 * It runs the real storage hub / JSON backend / storage-domain facility over a
 * copy of the version-1 fixture, drives the `plan.phase.*` endpoints through
 * `api.js`, and builds `todo_plan_read` with the installation's `defineTool`.
 *
 * Covered:
 *   1. add/update/remove and every structural rejection (pid/number, dangling
 *      dependency, self dependency, dependency cycle, dangling/cyclic parent,
 *      unknown current phase, dependents, children);
 *   2. split (`4` → `4a/4b`): parent becomes `split`, children inherit
 *      acceptance/mustKeep/decisions/sources, depend on the parent, auto-number,
 *      and a second split / status edit on a split parent is rejected;
 *   3. move: same-parent reorder only, with the cross-parent rejection;
 *   4. status (done without a result) and result recording (defaults to
 *      `claimed`, does not change status, replaceable);
 *   5. `todo_plan_read`: projects/project/phase shapes, closed output schema,
 *      lossless JSON, not-found;
 *   6. every write bumps the version and appends the right change kind;
 *   7. ordinary cards are unaffected.
 *
 * Usage: node scripts/verify-phase.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 *        PHASE_FIXTURE     (default: scripts/fixtures/todo_assistant.v1.json)
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'
import { createTodoPlanReadTool } from '../tool.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = process.env.PHASE_FIXTURE ?? join(HERE, 'fixtures', 'todo_assistant.v1.json')

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

/** Detect `undefined` values that make a wire value non-lossless JSON. */
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
  console.log(`fixture: ${FIXTURE}`)

  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-phase-'))
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
    const clock = { value: 1_800_200_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })
    const detail = async (id) => (await call(api, 'plan.detail', { id })).item
    const phaseOf = (item, pid) => item.phases.find((phase) => phase.pid === pid)

    console.log('\nB2 §1 add, structural validation, current phase')
    const created = await call(api, 'plan.create', { workspace: '/tmp/phase-ws', name: 'B2 计划', goal: '阶段、依赖与结果' })
    const projectId = created.item.id
    await expectCode(
      'add without a display number is rejected',
      api,
      'plan.phase.add',
      { id: projectId, title: '无编号' },
      'plan/phase-number-required',
    )
    const addA = await call(api, 'plan.phase.add', {
      id: projectId,
      title: '数据模型',
      number: '1',
      goal: 'schema',
      acceptance: [{ label: '验收', text: '旧文件可开' }],
    })
    const aPid = addA.change.affectedPhaseIds[0]
    checkEqual('add records a phase-add change', [addA.item.version, addA.change.kind], [2, 'phase-add'])
    const addB = await call(api, 'plan.phase.add', { id: projectId, title: '依赖', number: '2', dependsOn: [aPid] })
    const bPid = addB.change.affectedPhaseIds[0]
    const addC = await call(api, 'plan.phase.add', { id: projectId, title: '状态', number: '3', dependsOn: [bPid] })
    const cPid = addC.change.affectedPhaseIds[0]
    const addD = await call(api, 'plan.phase.add', { id: projectId, title: '结果', number: '4' })
    const dPid = addD.change.affectedPhaseIds[0]
    checkEqual('four phases with stable default pids', (await detail(projectId)).phases.map((phase) => phase.number), ['1', '2', '3', '4'])

    const before = (await detail(projectId)).version
    await expectCode('duplicate display number', api, 'plan.phase.add', { id: projectId, title: 'dup', number: '1' }, 'plan/phase-duplicate-number')
    await expectCode(
      'dangling dependency',
      api,
      'plan.phase.add',
      { id: projectId, title: 'dangling', number: '9', dependsOn: ['ph_missing'] },
      'plan/phase-unknown-dependency',
    )
    await expectCode(
      'self dependency',
      api,
      'plan.phase.add',
      { id: projectId, title: 'self', number: '10', pid: 'ph_self', dependsOn: ['ph_self'] },
      'plan/phase-self-dependency',
    )
    await expectCode(
      'dangling parent',
      api,
      'plan.phase.add',
      { id: projectId, title: 'orphan', number: '11', parentPid: 'ph_missing' },
      'plan/phase-unknown-parent',
    )
    await expectCode(
      'dependency cycle',
      api,
      'plan.phase.update',
      { id: projectId, phaseId: aPid, patch: { dependsOn: [cPid] } },
      'plan/phase-dependency-cycle',
    )
    await expectCode('self parent', api, 'plan.phase.update', { id: projectId, phaseId: aPid, patch: { parentPid: aPid } }, 'plan/phase-self-parent')
    await expectCode(
      'status is not patchable through update',
      api,
      'plan.phase.update',
      { id: projectId, phaseId: aPid, patch: { status: 'done' } },
      'plan/unknown-field',
    )
    await expectCode(
      'unknown currentPhaseId',
      api,
      'plan.patch',
      { id: projectId, patch: { currentPhaseId: 'ph_missing' } },
      'plan/current-phase-missing',
    )
    checkEqual('rejected writes did not bump the version', (await detail(projectId)).version, before)
    await expectCode(
      'a new phase cannot start done',
      api,
      'plan.phase.add',
      { id: projectId, title: 'done?', number: '12', status: 'done' },
      'plan/phase-status-on-add',
    )
    await expectCode(
      'updating to a duplicate number is rejected',
      api,
      'plan.phase.update',
      { id: projectId, phaseId: dPid, patch: { number: '1' } },
      'plan/phase-duplicate-number',
    )
    const renamed = await call(api, 'plan.phase.update', { id: projectId, phaseId: dPid, patch: { number: '4b' } })
    checkEqual('a valid number change is applied', phaseOf(await detail(projectId), dPid).number, '4b')

    const parentChange = await call(api, 'plan.phase.update', { id: projectId, phaseId: aPid, patch: { parentPid: bPid } })
    checkEqual('a valid parent change is applied', [parentChange.change.kind, phaseOf(await detail(projectId), aPid).parentPid], ['phase-update', bPid])
    await expectCode(
      'parent cycle',
      api,
      'plan.phase.update',
      { id: projectId, phaseId: bPid, patch: { parentPid: aPid } },
      'plan/phase-parent-cycle',
    )
    const resetParent = await call(api, 'plan.phase.update', { id: projectId, phaseId: aPid, patch: { parentPid: null } })
    checkEqual('null parent clears the parent link', phaseOf(await detail(projectId), aPid).parentPid, undefined)

    const current = await call(api, 'plan.patch', { id: projectId, patch: { currentPhaseId: bPid } })
    checkEqual('currentPhaseId resolves in the row', [current.item.currentPhaseId, current.item.currentPhaseNumber], [bPid, '2'])
    await expectCode(
      'removing a phase others depend on is rejected',
      api,
      'plan.phase.remove',
      { id: projectId, phaseId: bPid },
      'plan/phase-has-dependents',
    )
    const removedC = await call(api, 'plan.phase.remove', { id: projectId, phaseId: cPid })
    checkEqual('removing a leaf records a phase-remove change', removedC.change.kind, 'phase-remove')
    const removedCurrent = await call(api, 'plan.phase.remove', { id: projectId, phaseId: bPid })
    checkEqual(
      'removing the current phase clears currentPhaseId',
      [removedCurrent.item.currentPhaseId, removedCurrent.item.currentPhaseNumber],
      [null, null],
    )
    await call(api, 'plan.phase.remove', { id: projectId, phaseId: dPid })
    checkEqual('only the split candidate remains', (await detail(projectId)).phases.map((phase) => phase.number), ['1'])

    console.log('\nB2 §2 split and move')
    const split = await call(api, 'plan.phase.split', {
      id: projectId,
      phaseId: aPid,
      children: [{ title: '子一' }, { title: '子二', goal: 'g' }],
    })
    checkEqual('split records a phase-split change', [split.change.kind, split.change.affectedPhaseIds.length], ['phase-split', 3])
    const afterSplit = await detail(projectId)
    const parent = phaseOf(afterSplit, aPid)
    const children = afterSplit.phases.filter((phase) => phase.parentPid === aPid)
    checkEqual('the parent becomes split and keeps its fields', [parent.status, parent.number, parent.acceptance.length], ['split', '1', 1])
    checkEqual(
      'children auto-number, depend on the parent, inherit acceptance, start pending',
      [children.map((phase) => phase.number), children.every((phase) => phase.dependsOn.includes(aPid)), children.every((phase) => phase.acceptance.length === 1), children.map((phase) => phase.status)],
      [['1a', '1b'], true, true, ['pending', 'pending']],
    )
    checkEqual('children sit directly after the parent', afterSplit.phases.map((phase) => phase.number), ['1', '1a', '1b'])
    const childA = children[0]
    const childB = children[1]
    await expectCode('splitting a split parent again is rejected', api, 'plan.phase.split', { id: projectId, phaseId: aPid, children: [{ title: 'x' }] }, 'plan/phase-not-splittable')
    await expectCode('splitting without children is rejected', api, 'plan.phase.split', { id: projectId, phaseId: childA.pid, children: [] }, 'plan/split-children-required')
    await expectCode('changing the status of a split parent is rejected', api, 'plan.phase.status', { id: projectId, phaseId: aPid, status: 'active' }, 'plan/phase-is-split')
    await expectCode('removing a parent with children is rejected', api, 'plan.phase.remove', { id: projectId, phaseId: aPid }, 'plan/phase-has-children')

    const moved = await call(api, 'plan.phase.move', { id: projectId, phaseId: childB.pid, beforePid: childA.pid })
    checkEqual('move records a phase-move change and reorders', [moved.change.kind, (await detail(projectId)).phases.map((phase) => phase.number)], ['phase-move', ['1', '1b', '1a']])
    await expectCode(
      'moving across parent groups is rejected',
      api,
      'plan.phase.move',
      { id: projectId, phaseId: childA.pid, beforePid: aPid },
      'plan/phase-move-cross-parent',
    )
    await expectCode('moving onto itself is rejected', api, 'plan.phase.move', { id: projectId, phaseId: childA.pid, beforePid: childA.pid }, 'plan/phase-move-target-self')
    await expectCode('move without a target is rejected', api, 'plan.phase.move', { id: projectId, phaseId: childA.pid }, 'plan/phase-move-target-required')

    const letterProject = await call(api, 'plan.create', { workspace: '/tmp/phase-ws', name: '字母阶段', goal: '字母编号的拆分' })
    const letterA = await call(api, 'plan.phase.add', { id: letterProject.item.id, title: 'A 阶段', number: 'A' })
    await call(api, 'plan.phase.split', {
      id: letterProject.item.id,
      phaseId: letterA.change.affectedPhaseIds[0],
      children: [{ title: '一' }, { title: '二' }],
    })
    const letterDetail = (await call(api, 'plan.detail', { id: letterProject.item.id })).item
    checkEqual('a letter-numbered phase splits into A1/A2', letterDetail.phases.map((phase) => phase.number), ['A', 'A1', 'A2'])
    await call(api, 'plan.remove', { id: letterProject.item.id })

    console.log('\nB2 §3 status and execution result')
    const done = await call(api, 'plan.phase.status', { id: projectId, phaseId: childA.pid, status: 'done' })
    checkEqual(
      'done is allowed without a recorded result',
      [done.change.kind, phaseOf(await detail(projectId), childA.pid).status],
      ['phase-status', 'done'],
    )
    await expectCode('status cannot become split', api, 'plan.phase.status', { id: projectId, phaseId: childB.pid, status: 'split' }, 'plan/phase-status-split')
    await expectCode(
      'an invalid result is rejected',
      api,
      'plan.phase.result',
      { id: projectId, phaseId: childA.pid, result: { tests: [] } },
      'plan/result-summary',
    )
    const recorded = await call(api, 'plan.phase.result', {
      id: projectId,
      phaseId: childA.pid,
      sessionId: 's-b2',
      result: { summary: '做完了', completed: ['a'], tests: [{ command: 'node scripts/verify-phase.mjs', status: 'passed' }] },
    })
    const afterResult = phaseOf(await detail(projectId), childA.pid)
    checkEqual(
      'result defaults to claimed and records the session',
      [recorded.change.kind, afterResult.result.verification, afterResult.result.recordedBySession, afterResult.result.tests[0].status],
      ['phase-result', 'claimed', 's-b2', 'passed'],
    )
    checkEqual('recording a result does not change the status', afterResult.status, 'done')
    const replaced = await call(api, 'plan.phase.result', {
      id: projectId,
      phaseId: childA.pid,
      sessionId: 's-b2',
      result: { summary: '修正后的结论', tests: [{ status: 'failed' }] },
    })
    checkEqual(
      'a second result replaces the slot and records a change',
      [replaced.change.kind, phaseOf(await detail(projectId), childA.pid).result.summary],
      ['phase-result', '修正后的结论'],
    )

    const versionBeforeNoop = (await detail(projectId)).version
    const noop = await call(api, 'plan.phase.status', { id: projectId, phaseId: childA.pid, status: 'done' })
    check(
      'a no-op status neither bumps the version nor records a change',
      !('change' in noop) && noop.item.version === versionBeforeNoop,
      JSON.stringify(Object.keys(noop)),
    )

    console.log('\nB2 §4 todo_plan_read')
    const planTool = createTodoPlanReadTool({ defineTool, store, resolveWorkspace: async (cwd) => cwd })
    const exec = { agent: { session: { header: { cwd: '/tmp/phase-ws' } } } }
    const listShape = await planTool.execute({}, exec)
    checkEqual(
      'the tool lists this workspace’s plans',
      [listShape.shape, listShape.count >= 1, listShape.projects.some((project) => project.id === projectId)],
      ['projects', true, true],
    )
    checkOutput(planTool, listShape, 'todo_plan_read projects')
    const emptyShape = await planTool.execute({}, { agent: { session: { header: { cwd: '/tmp/other-ws' } } } })
    checkEqual('another workspace lists nothing', [emptyShape.shape, emptyShape.count], ['projects', 0])
    const projectShape = await planTool.execute({ projectId }, exec)
    checkEqual('the tool returns the project shape', [projectShape.shape, projectShape.project.phaseCount], ['project', (await detail(projectId)).phases.length])
    checkOutput(planTool, projectShape, 'todo_plan_read project')
    checkLossless('the project read is lossless JSON', projectShape)
    const phaseShape = await planTool.execute({ projectId, phaseId: childA.pid }, exec)
    checkEqual(
      'the phase shape focuses one phase and its dependencies',
      [phaseShape.shape, phaseShape.phase.pid, phaseShape.dependencies.some((dep) => dep.pid === aPid)],
      ['phase', childA.pid, true],
    )
    checkOutput(planTool, phaseShape, 'todo_plan_read phase')
    checkLossless('the phase read is lossless JSON', phaseShape)
    const renderedProject = planTool.output.render({}, projectShape)
    const renderedPhase = planTool.output.render({}, phaseShape)
    check(
      'the tool renders both shapes as one text block',
      Array.isArray(renderedProject) && renderedProject[0]?.type === 'text' && Array.isArray(renderedPhase) && renderedPhase[0]?.type === 'text',
      JSON.stringify([renderedProject?.[0]?.type, renderedPhase?.[0]?.type]),
    )
    await expectToolCode('an unknown project is rejected by the tool', () => planTool.execute({ projectId: 'pj_missing' }, exec), 'plan/not-found')
    await expectToolCode('an unknown phase is rejected by the tool', () => planTool.execute({ projectId, phaseId: 'ph_missing' }, exec), 'plan/phase-not-found')
    await expectToolCode('phaseId without projectId is rejected', () => planTool.execute({ phaseId: childA.pid }, exec), 'plan/project-required')

    console.log('\nB2 §5 change history and cleanup')
    const kinds = (await call(api, 'plan.change.list', { id: projectId })).items.map((change) => change.kind)
    check(
      'the change history records every B2 operation kind',
      ['phase-add', 'phase-update', 'phase-remove', 'phase-split', 'phase-move', 'phase-status', 'phase-result'].every((kind) => kinds.includes(kind)),
      JSON.stringify(kinds),
    )
    const withCurrent = await call(api, 'plan.patch', { id: projectId, patch: { currentPhaseId: childA.pid } })
    checkEqual('a child can become the current phase', withCurrent.item.currentPhaseId, childA.pid)
    await expectCode(
      'replacing phases must keep currentPhaseId valid',
      api,
      'plan.patch',
      { id: projectId, patch: { phases: [] } },
      'plan/current-phase-missing',
    )
    const removedCurrentChild = await call(api, 'plan.phase.remove', { id: projectId, phaseId: childA.pid })
    checkEqual('removing the current child clears currentPhaseId', removedCurrentChild.item.currentPhaseId, null)
    await call(api, 'plan.phase.remove', { id: projectId, phaseId: childB.pid })
    await call(api, 'plan.phase.remove', { id: projectId, phaseId: aPid })
    checkEqual('the project is empty again', (await detail(projectId)).phases.length, 0)

    console.log('\nB2 §6 ordinary cards are unaffected')
    const card = await call(api, 'create', { workspace: '/tmp/phase-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('an ordinary card has no project link', [card.item.projectId, card.item.phaseId], [null, null])
    const legacy = await call(api, 'list', { workspace: '/tmp/legacy-repo' })
    checkEqual('the fixture cards are still listed', legacy.total, 2)

    console.log('\nB2 §7 durability')
    await domain.close()
    const stored = JSON.parse(await readFile(dataPath, 'utf8'))
    checkEqual('the file stays unit version 1', stored.unit.version, 1)
    check('the stored project kept its empty phase list', Array.isArray(stored.tables.projects?.[projectId]?.phases) && stored.tables.projects[projectId].phases.length === 0)
    check(
      'the stored change history kept the B2 kinds',
      Object.values(stored.tables.plan_changes ?? {}).some((change) => change.kind === 'phase-split'),
    )

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
