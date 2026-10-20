/**
 * Headless verification of PLAN.md B1 — Project Plan data model, storage and
 * API projection.
 *
 * This runs the **real** composition pieces out of the local DSH installation
 * (storage hub, JSON backend, storage-domain facility), opens the declared
 * `todo-assistant` domain over a copy of the version-1 fixture, and drives the
 * `plan.*` endpoints through `api.js`. It proves:
 *
 *   1. a version-1 file opens with three empty plan tables and unchanged cards;
 *   2. project create/list/detail/patch and their projections;
 *   3. proposal apply/reject, including the `baseVersion` stale guard;
 *   4. the limits reject with actionable codes and leave the store untouched;
 *   5. change history, `plan.export`, and the cascade on `plan.remove`;
 *   6. ordinary cards behave exactly as before, with an optional weak link;
 *   7. durability: close, reopen, and the on-disk shape stays unit version 1;
 *      a pre-B1 descriptor (todos/rules only) still reads the file.
 *
 * It does not load the plugin through the profile (no `install_bundle`), so it
 * proves the spec/record/API contract, not peer-dependency resolution.
 *
 * Usage: node scripts/verify-plan.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 *        PLAN_FIXTURE      (default: scripts/fixtures/todo_assistant.v1.json)
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { PLAN_LIMITS, createTodoSpec, projectFull, projectL0 } from '../domain.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = process.env.PLAN_FIXTURE ?? join(HERE, 'fixtures', 'todo_assistant.v1.json')

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

/** Expect one store call to throw with `code`. */
async function expectStoreCode(label, run, code) {
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
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-plan-'))
  const dataPath = join(root, 'todo_assistant.json')
  console.log(`temp storage root: ${root}`)

  const ctx = new Context()
  try {
    await copyFile(FIXTURE, dataPath)
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    let domain = await ctx.storageDomain.open(spec)
    let store = createStore(domain)
    let clock = 1_800_100_000_000
    const tick = () => (clock += 1000)
    let api = createApi({ store, now: tick })

    console.log('\nB1 §1 version-1 fixture opens with empty plan tables')
    const diskBefore = JSON.parse(await readFile(dataPath, 'utf8'))
    checkEqual('fixture is unit version 1', diskBefore.unit.version, 1)
    checkEqual('fixture stores only todos/rules before B1 writes', Object.keys(diskBefore.tables).sort(), ['rules', 'todos'])
    checkEqual(
      'new tables start empty',
      [domain.table('projects').size, domain.table('plan_proposals').size, domain.table('plan_changes').size],
      [0, 0, 0],
    )
    const legacyFull = projectFull(store.get('td_old01'))
    checkEqual(
      'legacy card keeps its stored fields',
      [legacyFull.title, legacyFull.status, legacyFull.core.nextStep],
      ['语言列表删除异常', 'open', '检查删除按钮的启用条件和删除后的反馈调用'],
    )
    const legacyRow = projectL0(store.get('td_old01'))
    checkEqual('legacy list row keeps its shape', [legacyRow.label, legacyRow.nextStep, legacyRow.sourceCount], ['1.1', legacyFull.core.nextStep, 0])
    checkEqual('legacy card has no project link', [legacyFull.projectId, legacyFull.phaseId], [null, null])
    checkLossless('legacy full projection is lossless JSON', legacyFull)

    console.log('\nB1 §2 project create / list / detail / patch')
    const created = await call(api, 'plan.create', {
      workspace: '/tmp/plan-ws',
      name: 'B1 计划',
      goal: '引入 Project Plan 数据模型、存储表和 API 投影',
      phases: [
        {
          title: '数据模型',
          goal: 'schema 与表',
          number: '1',
          acceptance: [{ label: '验收', text: '旧文件可开' }],
        },
        { title: 'API 投影', goal: 'plan.* 端点' },
      ],
    })
    const projectId = created.item.id
    check('project id is backend-safe', /^pj_[a-z0-9]{4}$/u.test(projectId), projectId)
    checkEqual('project row carries the counts', [created.item.phaseCount, created.item.version, created.item.pendingProposalCount], [2, 1, 0])
    checkEqual('project row has no current phase yet', [created.item.currentPhaseId, created.item.currentPhaseNumber], [null, null])
    checkLossless('project row is lossless JSON', created.item)

    const detail = await call(api, 'plan.detail', { id: projectId })
    checkEqual('detail returns both phases with stable pids', detail.item.phases.map((phase) => /^ph_[a-z0-9]{4}$/u.test(phase.pid)), [true, true])
    checkEqual(
      'phase defaults are filled',
      [detail.item.phases[0].status, detail.item.phases[0].dependsOn.length, detail.item.phases[0].number, detail.item.phases[1].number],
      ['pending', 0, '1', '2'],
    )
    checkEqual('phase acceptance survives', detail.item.phases[0].acceptance.map((item) => item.text), ['旧文件可开'])
    checkEqual('detail has no current phase while currentPhaseId is unset', detail.item.currentPhase, null)
    checkLossless('project detail is lossless JSON', detail.item)

    const listed = await call(api, 'plan.list', { workspace: '/tmp/plan-ws' })
    checkEqual('workspace list returns the project', [listed.total, listed.items[0].id], [1, projectId])
    checkEqual('another workspace sees nothing', (await call(api, 'plan.list', { workspace: '/tmp/other' })).total, 0)
    checkEqual('all:true sees every workspace', (await call(api, 'plan.list', { all: true })).total, 1)

    const exportedAfterCreate = await call(api, 'plan.export', { id: projectId, includeDiff: true })
    checkEqual(
      'create records the initial change',
      [exportedAfterCreate.changes.length, exportedAfterCreate.changes[0].kind, exportedAfterCreate.changes[0].version],
      [1, 'create', 1],
    )
    check(
      'create diff keeps the whole initial plan',
      exportedAfterCreate.changes[0].diff.after !== null && Array.isArray(exportedAfterCreate.changes[0].diff.after.phases),
      JSON.stringify(exportedAfterCreate.changes[0].diff).slice(0, 160),
    )

    const patched = await call(api, 'plan.patch', {
      id: projectId,
      patch: { goal: '新的总体目标', currentPhaseId: detail.item.phases[0].pid },
      reason: '调整目标',
    })
    checkEqual('patch bumps version and resolves the current phase', [patched.item.version, patched.item.currentPhaseNumber], [2, '1'])
    checkEqual('patch appends a change', [patched.change.kind, patched.change.version, patched.change.reason], ['patch', 2, '调整目标'])
    const goalDiff = patched.change.diff.plan.project.find((entry) => entry.field === 'goal')
    checkEqual(
      'the summary diff stores the changed field only',
      [goalDiff?.before, goalDiff?.after, patched.change.diff.plan.project.some((entry) => entry.field === 'name')],
      ['引入 Project Plan 数据模型、存储表和 API 投影', '新的总体目标', false],
    )
    await expectCode('a stale patch is rejected', api, 'plan.patch', { id: projectId, baseVersion: 1, patch: { goal: 'x' } }, 'plan/stale')
    checkEqual('the rejected patch did not bump the version', (await call(api, 'plan.detail', { id: projectId })).item.version, 2)

    // Replacing the embedded phase array is a B1 write; phase.* operations stay B2.
    const phaseEdit = await call(api, 'plan.create', { workspace: '/tmp/plan-ws', name: '阶段替换', goal: 'x', phases: [{ title: 'a' }] })
    const phaseEditDetail = await call(api, 'plan.detail', { id: phaseEdit.item.id })
    const replaced = await call(api, 'plan.patch', {
      id: phaseEdit.item.id,
      patch: { phases: [{ pid: phaseEditDetail.item.phases[0].pid, title: 'a2' }] },
    })
    const replacedDetail = await call(api, 'plan.detail', { id: phaseEdit.item.id })
    checkEqual(
      'replacing phases keeps the stable pid and bumps the version',
      [replaced.item.version, replacedDetail.item.phases[0].pid, replacedDetail.item.phases[0].title],
      [2, phaseEditDetail.item.phases[0].pid, 'a2'],
    )
    await expectCode(
      'replacing phases without a pid is rejected',
      api,
      'plan.patch',
      { id: phaseEdit.item.id, patch: { phases: [{ title: 'b' }] } },
      'plan/phase-pid-required',
    )
    await call(api, 'plan.remove', { id: phaseEdit.item.id })

    console.log('\nB1 §3 proposal apply / stale / reject')
    const proposal = await store.addProposal(
      { projectId, baseVersion: 2, patch: { status: 'paused' }, reason: '暂停一下', proposedBySession: 's-test' },
      tick(),
    )
    checkEqual(
      'a pending proposal does not change the plan',
      [proposal.status, (await call(api, 'plan.detail', { id: projectId })).item.version],
      ['pending', 2],
    )
    const pending = await call(api, 'plan.proposal.list', { id: projectId, status: 'pending' })
    checkEqual('the pending proposal is listed', [pending.total, pending.items[0].baseVersion], [1, 2])
    const applied = await call(api, 'plan.proposal.apply', { id: proposal.id })
    checkEqual(
      'apply bumps version, records the change, marks the proposal applied',
      [applied.item.version, applied.proposal.status, applied.change.by, applied.item.status],
      [3, 'applied', 'proposal', 'paused'],
    )
    await expectCode('applying twice is rejected', api, 'plan.proposal.apply', { id: proposal.id }, 'plan/proposal-not-pending')

    const stale = await store.addProposal({ projectId, baseVersion: 3, patch: { goal: 'stale goal' }, reason: 'stale' }, tick())
    await call(api, 'plan.patch', { id: projectId, patch: { goal: 'changed after the proposal' } })
    await expectCode('a stale proposal is rejected', api, 'plan.proposal.apply', { id: stale.id }, 'plan/stale')
    checkEqual('the stale rejection leaves the project alone', (await call(api, 'plan.detail', { id: projectId })).item.version, 4)
    const rejected = await call(api, 'plan.proposal.reject', { id: stale.id, reason: '版本过旧' })
    checkEqual('reject records the decision', [rejected.item.status, rejected.item.rejectedReason], ['rejected', '版本过旧'])
    checkEqual('reject does not change the plan', (await call(api, 'plan.detail', { id: projectId })).item.version, 4)
    await expectCode('rejecting twice is rejected', api, 'plan.proposal.reject', { id: stale.id }, 'plan/proposal-not-pending')
    await expectStoreCode(
      'a stale proposal is rejected at propose time',
      () => store.addProposal({ projectId, baseVersion: 3, patch: { goal: 'x' } }, tick()),
      'plan/stale',
    )
    await expectStoreCode(
      'an unusable proposal patch is not stored',
      () => store.addProposal({ projectId, baseVersion: 4, patch: { nope: 1 } }, tick()),
      'plan/unknown-field',
    )
    checkEqual('the bad proposal left the proposal count alone', (await call(api, 'plan.proposal.list', { id: projectId })).total, 2)

    console.log('\nB1 §4 limits reject with actionable codes')
    // The `limits` seam exists so the counter caps are provable without writing
    // hundreds of records; it overrides the same PLAN_LIMITS the builders use.
    const strict = createStore(domain, { limits: { phases: 1, acceptance: 1, changes: 2 } })
    const queue = createStore(domain, { limits: { pendingProposals: 1 } })
    const quota = createStore(domain, { limits: { proposals: 1 } })
    const projectCountBefore = domain.table('projects').size
    await expectStoreCode(
      'too many phases',
      () => strict.createProject({ workspace: '/tmp/plan-ws', name: 'limits', goal: 'limits', phases: [{ title: 'a' }, { title: 'b' }] }, tick()),
      'plan/too-many-phases',
    )
    await expectStoreCode(
      'acceptance over the per-phase limit',
      () =>
        strict.createProject(
          {
            workspace: '/tmp/plan-ws',
            name: 'limits',
            goal: 'limits',
            phases: [{ title: 'a', acceptance: [{ label: 'a', text: 'a' }, { label: 'b', text: 'b' }] }],
          },
          tick(),
        ),
      'plan/too-many-acceptance',
    )
    await expectStoreCode('a missing name', () => store.createProject({ workspace: '/tmp/plan-ws', goal: 'x' }, tick()), 'plan/name')
    await expectStoreCode(
      'an over-long name',
      () => store.createProject({ workspace: '/tmp/plan-ws', name: 'x'.repeat(PLAN_LIMITS.name + 1), goal: 'x' }, tick()),
      'plan/name-too-long',
    )
    await expectStoreCode(
      'an over-long goal',
      () => store.createProject({ workspace: '/tmp/plan-ws', name: 'x', goal: 'x'.repeat(PLAN_LIMITS.goal + 1) }, tick()),
      'plan/goal-too-long',
    )
    await expectStoreCode(
      'too many sources',
      () =>
        store.createProject(
          {
            workspace: '/tmp/plan-ws',
            name: 'x',
            goal: 'x',
            sources: Array.from({ length: 33 }, (_, index) => ({ sid: `s${index}`, kind: 'file', label: `f${index}` })),
          },
          tick(),
        ),
      'plan/source-limit',
    )
    checkEqual('rejected writes leave the project table untouched', domain.table('projects').size, projectCountBefore)

    const strictProject = await strict.createProject({ workspace: '/tmp/plan-ws', name: 'limits', goal: 'limits', phases: [{ title: 'only' }] }, tick())
    await strict.applyChange(strictProject.project.id, { goal: 'g2' }, { at: tick() })
    await expectStoreCode(
      'the change limit stops unbounded history',
      () => strict.applyChange(strictProject.project.id, { goal: 'g3' }, { at: tick() }),
      'plan/change-limit',
    )
    const once = await store.addProposal({ projectId: strictProject.project.id, baseVersion: 2, patch: { goal: 'g3' }, reason: 'one' }, tick())
    check('the first proposal under the pending cap is stored', once.status === 'pending')
    await expectStoreCode(
      'the pending-proposal limit stops the queue',
      () => queue.addProposal({ projectId: strictProject.project.id, baseVersion: 2, patch: { goal: 'g4' } }, tick()),
      'plan/pending-proposal-limit',
    )
    await expectStoreCode(
      'the proposal cap stops the table growing',
      () => quota.addProposal({ projectId: strictProject.project.id, baseVersion: 2, patch: { goal: 'g5' } }, tick()),
      'plan/proposal-limit',
    )

    // B1 stored currentPhaseId without an existence check; B2's
    // validateProjectPlan now rejects it on every write path.
    await expectCode(
      'an unknown currentPhaseId is rejected (B2 rule)',
      api,
      'plan.create',
      { workspace: '/tmp/plan-ws', name: '弱引用', goal: 'B2 要求 currentPhaseId 存在', currentPhaseId: 'ph_missing' },
      'plan/current-phase-missing',
    )

    console.log('\nB1 §5 change list and export')
    const changes = await call(api, 'plan.change.list', { id: projectId })
    checkEqual('changes are ordered by version', changes.items.map((change) => change.version), [1, 2, 3, 4])
    checkEqual('the change list limit is honoured', (await call(api, 'plan.change.list', { id: projectId, limit: 2 })).items.length, 2)
    const snapshot = await call(api, 'plan.export', { id: projectId })
    checkEqual('export carries the project and its whole history', [snapshot.project.id, snapshot.changes.length], [projectId, 4])
    checkEqual('export project is the full projection', [snapshot.project.phaseCount, snapshot.project.currentPhase !== null], [2, true])
    checkLossless('export is lossless JSON', snapshot)

    console.log('\nB1 §6 ordinary cards are unchanged')
    const card = await call(api, 'create', { workspace: '/tmp/plan-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('an ordinary card row has no project link', [card.item.projectId, card.item.phaseId], [null, null])
    const cardDetail = await call(api, 'detail', { id: card.item.id })
    checkEqual('an ordinary card detail has no project link', [cardDetail.item.projectId, cardDetail.item.phaseId], [null, null])
    const linked = await call(api, 'patch', { id: card.item.id, patch: { projectId, phaseId: detail.item.phases[1].pid } })
    checkEqual('the weak link round-trips', [linked.item.projectId, linked.item.phaseId], [projectId, detail.item.phases[1].pid])
    const cleared = await call(api, 'patch', { id: card.item.id, patch: { projectId: null, phaseId: null } })
    checkEqual('null clears the weak link', [cleared.item.projectId, cleared.item.phaseId], [null, null])
    const legacyList = await call(api, 'list', { workspace: '/tmp/legacy-repo' })
    checkEqual('the fixture cards are still listed with no project link', [legacyList.total, legacyList.items.every((row) => row.projectId === null)], [2, true])

    console.log('\nB1 §7 plan.remove cascades proposals and changes')
    const temp = await call(api, 'plan.create', { workspace: '/tmp/plan-ws', name: '临时', goal: '临时' })
    await store.addProposal({ projectId: temp.item.id, baseVersion: 1, patch: { goal: 'x' } }, tick())
    const removed = await call(api, 'plan.remove', { id: temp.item.id })
    checkEqual('remove reports the cascade', [removed.removed.proposals, removed.removed.changes], [1, 1])
    checkEqual('the removed project has no proposals left', store.proposalsFor(temp.item.id).length, 0)
    checkEqual('the removed project has no changes left', store.changesFor(temp.item.id).total, 0)
    await expectCode('the removed project is gone', api, 'plan.detail', { id: temp.item.id }, 'plan/not-found')

    console.log('\nB1 §8 durability and the on-disk format')
    await domain.close()
    const stored = JSON.parse(await readFile(dataPath, 'utf8'))
    checkEqual('a stored file stays unit version 1', stored.unit.version, 1)
    check('the stored file keeps the legacy cards', stored.tables.todos?.td_old01 !== undefined && stored.tables.todos?.td_old02 !== undefined)
    check(
      'the stored file gained the plan tables',
      ['projects', 'plan_proposals', 'plan_changes'].every((table) => stored.tables[table] !== undefined),
    )
    // A pre-B1 descriptor (todos/rules only) must still read the new file: the
    // backend parser walks only the declared tables and the unit version is
    // unchanged. This is the file-format half of the downgrade contract;
    // verify-legacy.mjs covers real old code for the brief-era fields.
    const prePlanSpec = storageDomain.defineDomain({
      name: 'todo_assistant',
      version: 1,
      tables: {
        todos: storageDomain.domainTable(spec.tables.todos.valueSchema),
        rules: storageDomain.domainTable(spec.tables.rules.valueSchema),
      },
    })
    const prePlan = await ctx.storageDomain.open(prePlanSpec)
    checkEqual(
      'a pre-B1 descriptor still reads the version-1 cards',
      [prePlan.table('todos').get('td_old01')?.title, prePlan.table('todos').get('td_old02')?.minor],
      ['语言列表删除异常', 2],
    )
    await prePlan.close()

    domain = await ctx.storageDomain.open(spec)
    store = createStore(domain)
    api = createApi({ store, now: tick })
    const reopened = store.getProject(projectId)
    checkEqual('a reopened project keeps its version and phases', [reopened?.version, reopened?.phases.length], [4, 2])
    checkEqual(
      'a reopened plan keeps its proposal history',
      store.proposalsFor(projectId).map((entry) => entry.status),
      ['rejected', 'applied'],
    )
    checkEqual('reopened legacy cards are intact', [store.get('td_old01')?.title, store.get('td_old02')?.major], ['语言列表删除异常', 1])
    const reopenedList = await call(api, 'plan.list', { workspace: '/tmp/plan-ws' })
    checkEqual('the reopened plan list is projected again', reopenedList.items.some((row) => row.id === projectId && row.version === 4), true)

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
