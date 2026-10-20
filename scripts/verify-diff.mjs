/**
 * Headless verification of PLAN.md C2 — structured plan diff, affected phases,
 * new proposal kinds, and stale rejection at both propose and apply time.
 *
 * Covered:
 *   1. `diffPlans` field-level project/phase diffs, dependency and evidence
 *      changes, plus empty-diff detection;
 *   2. `affectedPhaseIds`: downstream closure and shared acceptance/decision
 *      matching (unrelated phases stay out);
 *   3. proposals for phase-add, phase-split, dependency and acceptance:
 *      propose writes nothing, hosts compute diff/affected, apply changes the
 *      project once with the right change kind;
 *   4. stale proposals reject at propose time and apply time; no-change
 *      proposals reject; reject leaves the plan untouched;
 *   5. the tool's closed output schema and rendered diff.
 *
 * Usage: node scripts/verify-diff.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'
import { affectedPhaseIds, diffIsEmpty, diffPlans } from '../plan-diff.js'
import { createTodoPlanProposeTool } from '../tool.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'todo_assistant.v1.json')

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

async function call(api, endpoint, payload) {
  const result = await api.handle(endpoint, payload)
  if (result.ok !== true) throw new Error(`${endpoint} failed: ${result.error.code} ${result.error.message}`)
  return result.value
}

async function expectCode(label, api, endpoint, payload, code) {
  const result = await api.handle(endpoint, payload)
  const actual = result.ok === false ? result.error?.code : 'ok'
  check(`${label} → ${code}`, actual === code, `got ${actual}: ${JSON.stringify(result)}`)
}

async function expectToolCode(label, run, code) {
  try {
    await run()
    check(`${label} → ${code}`, false, 'no error was thrown')
  } catch (error) {
    check(`${label} → ${code}`, error?.code === code, `got ${error?.code ?? error?.message}`)
  }
}

function phase(pid, number, title, extra = {}) {
  return {
    pid,
    number,
    title,
    goal: '',
    status: 'pending',
    dependsOn: [],
    acceptance: [],
    mustKeep: [],
    decisions: [],
    sources: [],
    notes: [],
    nextStep: '',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

function makeProject(extra = {}) {
  return {
    id: 'pj_test',
    workspace: '/tmp/c2-ws',
    name: 'P',
    goal: 'G',
    status: 'active',
    currentPhaseId: 'a',
    phases: [],
    decisions: [{ label: 'd', text: 'p1' }],
    risks: [],
    sources: [{ sid: 's1', kind: 'file', label: 'L', where: { file: 'f' } }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
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

  console.log('\nC2 §1 diffPlans and affected phases')
  const before = makeProject({
    phases: [
      phase('a', '1', 'A', {
        status: 'active',
        acceptance: [{ label: 'a', text: 'x' }],
        mustKeep: [{ label: 'm', text: 'm' }],
        decisions: [{ label: 'd', text: 'd' }],
      }),
      phase('b', '2', 'B', { dependsOn: ['a'], acceptance: [{ label: 'a', text: 'y' }] }),
      phase('c', '3', 'C', { dependsOn: ['b'], acceptance: [{ label: 'a', text: 'x' }] }),
      phase('e', '4', 'E'),
      phase('g', '6', 'G', { acceptance: [{ label: 'a', text: 'x2' }] }),
    ],
  })
  const after = JSON.parse(JSON.stringify(before))
  after.name = 'P2'
  after.currentPhaseId = 'c'
  after.phases = after.phases.filter((entry) => entry.pid !== 'e')
  const a = after.phases.find((entry) => entry.pid === 'a')
  a.title = 'A2'
  a.status = 'blocked'
  a.acceptance.push({ label: 'a', text: 'x2' })
  const b = after.phases.find((entry) => entry.pid === 'b')
  b.dependsOn = []
  after.phases.push(phase('f', '5', 'F', { parentPid: 'b', dependsOn: ['b'], acceptance: [{ label: 'a', text: 'y' }] }))

  const diff = diffPlans(before, after)
  checkEqual(
    'project field changes include the current phase number',
    diff.project.map((entry) => [entry.field, entry.before, entry.after]),
    [['name', 'P', 'P2'], ['currentPhaseId', '1', '3']],
  )
  checkEqual('added phases keep their parent', diff.phases.added.map((entry) => [entry.number, entry.title, entry.parent]), [['5', 'F', '2']])
  checkEqual('removed phases are listed', diff.phases.removed.map((entry) => [entry.number, entry.title]), [['4', 'E']])
  checkEqual(
    'modified phases list changed fields',
    diff.phases.modified.map((entry) => [entry.number, entry.fields.map((field) => [field.field, field.before, field.after])]),
    [['1', [['title', 'A', 'A2'], ['status', 'active', 'blocked']]]],
  )
  checkEqual('dependency changes use display numbers', diff.dependencies.map((entry) => [entry.number, entry.added, entry.removed]), [['2', [], ['1']]])
  checkEqual('acceptance changes are field-level', diff.acceptance.map((entry) => [entry.number, entry.field, entry.added]), [['1', 'acceptance', ['x2']]])
  check('an empty diff is detected', diffIsEmpty(diffPlans(before, before)) && !diffIsEmpty(diff))

  const affected = affectedPhaseIds(before, after, diff)
  checkEqual('affected phases follow downstream closure and shared evidence', affected, ['a', 'b', 'c', 'g', 'f'])
  check('the removed phase is not reported as affected', !affected.includes('e'))

  console.log('\nC2 §2 propose kinds change nothing')
  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-c2-'))
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
    const clock = { value: 1_800_600_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })
    const detail = async (id) => (await call(api, 'plan.detail', { id })).item
    const created = await call(api, 'plan.create', { workspace: '/tmp/c2-ws', name: 'C2 计划', goal: '变化与影响' })
    const projectId = created.item.id
    const addA = await call(api, 'plan.phase.add', { id: projectId, title: 'A', number: '1', acceptance: [{ label: 'a', text: 'A 验收' }] })
    const pidA = addA.change.affectedPhaseIds[0]
    const addB = await call(api, 'plan.phase.add', {
      id: projectId,
      title: 'B',
      number: '2',
      dependsOn: [pidA],
      acceptance: [{ label: 'a', text: 'B 验收' }],
    })
    const pidB = addB.change.affectedPhaseIds[0]
    const addC = await call(api, 'plan.phase.add', { id: projectId, title: 'C', number: '3', dependsOn: [pidB] })
    const pidC = addC.change.affectedPhaseIds[0]
    await call(api, 'plan.patch', { id: projectId, patch: { currentPhaseId: pidA } })
    const tool = createTodoPlanProposeTool({ defineTool, store, now: tick })
    const exec = { agent: { session: { id: 's-c2', snapshotEvents: () => [] } } }
    let version = (await detail(projectId)).version

    const addedProposal = await tool.execute(
      {
        projectId,
        baseVersion: version,
        kind: 'phase-add',
        parentNumber: '2',
        number: '2a',
        title: 'B 的子阶段',
        goal: '补一块',
        dependsOn: ['1'],
        acceptance: ['子阶段验收'],
        reason: '执行中发现要补',
      },
      exec,
    )
    checkEqual('phase-add produces a proposal with a diff', [addedProposal.shape, addedProposal.diff.phases.added.length], ['proposal', 1])
    checkOutput(tool, addedProposal, 'todo_plan_propose phase-add')
    checkEqual('proposing does not change the project', (await detail(projectId)).version, version)
    check('the rendered diff names the new phase', tool.output.render({}, addedProposal)[0].text.includes('+ phase 2a B 的子阶段'))
    await call(api, 'plan.proposal.reject', { id: addedProposal.proposalId, reason: '只测提议' })

    console.log('\nC2 §3 apply each kind')
    version = (await detail(projectId)).version
    const addApplied = await call(api, 'plan.proposal.apply', { id: (await tool.execute({
      projectId,
      baseVersion: version,
      kind: 'phase-add',
      parentNumber: '2',
      number: '2a',
      title: 'B 的子阶段',
      dependsOn: ['1'],
    }, exec)).proposalId })
    checkEqual('applying phase-add adds one phase and one change', [addApplied.item.phaseCount, addApplied.change.kind], [4, 'phase-add'])

    version = (await detail(projectId)).version
    const splitProposal = await tool.execute(
      { projectId, baseVersion: version, kind: 'phase-split', phaseId: pidC, children: [{ title: 'C1' }, { title: 'C2' }] },
      exec,
    )
    checkEqual('phase-split diff adds children and marks the parent', [splitProposal.diff.phases.added.length, splitProposal.diff.phases.modified.length], [2, 1])
    const splitApplied = await call(api, 'plan.proposal.apply', { id: splitProposal.proposalId })
    const afterSplit = await detail(projectId)
    checkEqual('split children exist after apply', afterSplit.phases.filter((phase) => phase.parentPid === pidC).length, 2)
    checkEqual('split records the phase-split change', splitApplied.change.kind, 'phase-split')

    version = (await detail(projectId)).version
    const depProposal = await tool.execute(
      { projectId, baseVersion: version, kind: 'dependency', phaseId: pidB, dependsOn: [] },
      exec,
    )
    checkEqual(
      'the dependency diff reports the removed edge',
      depProposal.diff.dependencies.map((entry) => [entry.number, entry.removed]),
      [['2', ['1']]],
    )
    check('the dependency diff marks downstream phases as affected', depProposal.affected.some((entry) => entry.number.startsWith('3')))
    await call(api, 'plan.proposal.apply', { id: depProposal.proposalId })
    checkEqual('the dependency is cleared', (await detail(projectId)).phases.find((phase) => phase.pid === pidB).dependsOn, [])

    version = (await detail(projectId)).version
    const accProposal = await tool.execute(
      { projectId, baseVersion: version, kind: 'acceptance', phaseId: pidA, acceptance: ['A 验收', '新验收'] },
      exec,
    )
    checkEqual(
      'the acceptance diff lists the added item',
      accProposal.diff.acceptance.map((entry) => [entry.field, entry.added]),
      [['acceptance', ['新验收']]],
    )
    await call(api, 'plan.proposal.apply', { id: accProposal.proposalId })
    checkEqual(
      'the new acceptance item is stored',
      (await detail(projectId)).phases.find((phase) => phase.pid === pidA).acceptance.map((item) => item.text),
      ['A 验收', '新验收'],
    )

    console.log('\nC2 §4 stale, no-change and reject')
    version = (await detail(projectId)).version
    await expectToolCode(
      'a stale proposal is rejected at propose time',
      () => tool.execute({ projectId, baseVersion: version - 1, kind: 'dependency', phaseId: pidB, dependsOn: [] }, exec),
      'plan/stale',
    )
    await expectToolCode(
      'a no-change proposal is rejected',
      () => tool.execute({ projectId, baseVersion: version, kind: 'dependency', phaseId: pidB, dependsOn: [] }, exec),
      'plan/no-change',
    )
    const pendingBefore = await call(api, 'plan.proposal.list', { id: projectId, status: 'pending' })
    const rejectedProposal = await tool.execute(
      { projectId, baseVersion: version, kind: 'acceptance', phaseId: pidA, decisions: ['新决定'] },
      exec,
    )
    const rejected = await call(api, 'plan.proposal.reject', { id: rejectedProposal.proposalId, reason: '不采纳' })
    checkEqual('reject records the decision', [rejected.item.status, rejected.item.rejectedReason], ['rejected', '不采纳'])
    checkEqual('reject does not change the version', (await detail(projectId)).version, version)
    checkEqual('the rejected proposal is not left pending', (await call(api, 'plan.proposal.list', { id: projectId, status: 'pending' })).total, pendingBefore.total)

    const card = await call(api, 'create', { workspace: '/tmp/c2-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('ordinary cards are unaffected', [card.item.projectId, card.item.phaseId], [null, null])

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
