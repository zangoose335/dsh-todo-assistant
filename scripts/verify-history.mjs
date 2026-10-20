/**
 * Headless verification of PLAN.md C4 — version history, initial/current
 * comparison, decision timeline, pagination and summary export.
 *
 * Covered:
 *   1. create stores the full initial snapshot; later changes store only the
 *      structured summary (`diff.plan`), not copied field values;
 *   2. `plan.change.diff` supports initial→current and one consecutive change,
 *      rejects arbitrary ranges as `plan/replay-unavailable`, and still computes
 *      legacy changes from their old `before`/`after` fields;
 *   3. `plan.version.show` returns v1/current and rejects intermediate versions;
 *   4. `plan.change.list` offset pagination;
 *   5. `plan.decision.list` merges decision/risk deltas with applied/rejected
 *      proposals;
 *   6. JSON export is summary-only by default (with `includeDiff` opt-in) and
 *      Markdown export appends a change summary;
 *   7. the change-history limit rejects with `plan/change-limit`.
 *
 * Usage: node scripts/verify-history.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'

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

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-c4-'))
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
    const clock = { value: 1_800_800_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })

    const created = await call(api, 'plan.create', {
      workspace: '/tmp/c4-ws',
      name: 'C4 计划',
      goal: 'g0',
      decisions: [{ label: 'd', text: 'd0' }],
      phases: [
        { title: 'A', number: '1', decisions: [{ label: 'd', text: 'pd0' }] },
        { title: 'B', number: '2' },
      ],
    })
    const projectId = created.item.id
    const initialChange = (await call(api, 'plan.change.list', { id: projectId, limit: 1 })).items[0]
    const pidA = (await call(api, 'plan.detail', { id: projectId })).item.phases.find((phase) => phase.number === '1').pid
    const pidB = (await call(api, 'plan.detail', { id: projectId })).item.phases.find((phase) => phase.number === '2').pid
    const dep = await call(api, 'plan.phase.update', { id: projectId, phaseId: pidB, patch: { dependsOn: [pidA] }, reason: '建立依赖' })

    console.log('\nC4 §1 create snapshot and summary-only changes')
    checkEqual('create stores the initial project', [initialChange.diff.after.phases.length, initialChange.diff.after.version], [2, 1])
    const v1 = await call(api, 'plan.version.show', { id: projectId, version: 1 })
    checkEqual('version.show returns the initial plan', [v1.item.version, v1.item.phases.length, v1.item.goal], [1, 2, 'g0'])

    const patched = await call(api, 'plan.patch', { id: projectId, patch: { goal: 'g1', decisions: [{ label: 'd', text: 'd0' }, { label: 'd', text: 'd1' }] } })
    checkEqual('a patch bumps the version', patched.item.version, 3)
    checkEqual(
      'later changes store only the summary',
      ['before' in patched.change.diff, 'after' in patched.change.diff, Array.isArray(patched.change.diff.plan.project)],
      [false, false, true],
    )
    checkEqual(
      'the summary carries the goal before/after',
      patched.change.diff.plan.project.find((entry) => entry.field === 'goal').after,
      'g1',
    )

    checkEqual('the dependency change is version 2', dep.item.version, 2)
    const phaseDecision = await call(api, 'plan.phase.update', {
      id: projectId,
      phaseId: pidA,
      patch: { decisions: [{ label: 'd', text: 'pd0' }, { label: 'd', text: 'pd1' }] },
      reason: '阶段决策',
    })
    checkEqual('the phase decision is version 4', phaseDecision.item.version, 4)
    const added = await call(api, 'plan.phase.add', { id: projectId, title: 'C', number: '3', dependsOn: [pidB] })
    checkEqual('the added phase is version 5', added.item.version, 5)

    console.log('\nC4 §2 change diffs and replay limits')
    const initialVsCurrent = await call(api, 'plan.change.diff', { id: projectId, from: 1, to: 5 })
    checkEqual('initial vs current reports both versions', [initialVsCurrent.fromVersion, initialVsCurrent.toVersion], [1, 5])
    check(
      'initial vs current includes the added phase and goal change',
      initialVsCurrent.diff.phases.added.some((phase) => phase.number === '3') &&
        initialVsCurrent.diff.project.some((entry) => entry.field === 'goal' && entry.after === 'g1'),
    )
    const consecutive = await call(api, 'plan.change.diff', { id: projectId, from: 1, to: 2 })
    checkEqual('a consecutive diff is the stored summary', [consecutive.source, consecutive.diff.dependencies[0]?.added], ['stored', ['1']])
    const empty = await call(api, 'plan.change.diff', { id: projectId, from: 1, to: 1 })
    checkEqual('same-version diff is empty', empty.source, 'empty')
    await expectCode('an arbitrary range is unavailable', api, 'plan.change.diff', { id: projectId, from: 2, to: 4 }, 'plan/replay-unavailable')
    await expectCode('an invalid range is rejected', api, 'plan.change.diff', { id: projectId, from: 4, to: 2 }, 'plan/invalid-range')
    await expectCode('an intermediate version view is unavailable', api, 'plan.version.show', { id: projectId, version: 3 }, 'plan/version-unavailable')

    console.log('\nC4 §3 pagination and decision timeline')
    const page1 = await call(api, 'plan.change.list', { id: projectId, limit: 2, offset: 0 })
    const page2 = await call(api, 'plan.change.list', { id: projectId, limit: 2, offset: 2 })
    checkEqual('change pages advance by offset', [page1.items.map((item) => item.version), page2.items.map((item) => item.version), page1.total], [[1, 2], [3, 4], 5])
    checkEqual('nextOffset points at the next page', [page1.nextOffset, page2.nextOffset], [2, 4])

    const decisions = await call(api, 'plan.decision.list', { id: projectId })
    check(
      'decision history includes initial and added project decisions',
      decisions.items.some((item) => item.text === 'd0' && item.action === 'added') &&
        decisions.items.some((item) => item.text === 'd1' && item.action === 'added'),
    )
    check('decision history includes the phase decision', decisions.items.some((item) => item.text === 'pd1' && item.scope === 'phase'))
    const versionOfD1 = decisions.items.find((item) => item.text === 'd1')?.version
    checkEqual('the added decision points at version 3', versionOfD1, 3)

    console.log('\nC4 §4 proposal outcomes stay out of the decision timeline')
    const version = (await call(api, 'plan.detail', { id: projectId })).item.version
    const appliedProposal = await store.addProposal({ projectId, baseVersion: version, patch: { goal: 'g2' }, reason: '应用提议' }, tick())
    await store.applyProposal(appliedProposal.id, tick())
    const rejectedProposal = await store.addProposal({ projectId, baseVersion: version + 1, patch: { goal: 'g3' }, reason: '不采用' }, tick())
    await store.rejectProposal(rejectedProposal.id, '方向不对', tick())
    const timeline = await call(api, 'plan.decision.list', { id: projectId })
    check(
      'the decision timeline contains only real decisions/risks',
      timeline.items.every((item) => item.type === 'change'),
      JSON.stringify(timeline.items.map((item) => item.type)),
    )
    const proposals = await call(api, 'plan.proposal.list', { id: projectId })
    checkEqual(
      'applied/rejected proposals remain in the proposal audit',
      proposals.items.map((item) => item.status).sort(),
      ['applied', 'rejected'],
    )

    console.log('\nC4 §5 export summary')
    const exported = await call(api, 'plan.export', { id: projectId })
    checkEqual('default export omits change diffs', exported.changes.every((change) => change.diff === undefined), true)
    checkEqual('export keeps version/kind/affected fields', [exported.changes.length, exported.changes[0].version, exported.changes.at(-1).version], [6, 1, 6])
    const withDiff = await call(api, 'plan.export', { id: projectId, includeDiff: true })
    checkEqual('includeDiff keeps the stored diff', withDiff.changes[0].diff.after.phases.length, 2)
    const markdown = await call(api, 'plan.export', { id: projectId, format: 'markdown' })
    check(
      'Markdown export appends a change summary',
      markdown.markdown.includes('## 变更摘要') && markdown.markdown.includes('v6') && markdown.markdown.includes('v1'),
    )

    console.log('\nC4 §6 legacy changes and the change limit')
    const legacy = await call(api, 'plan.change.diff', { id: projectId, from: 1, to: 2 })
    checkEqual('a legacy change can still be computed from before/after', legacy.source, 'stored')
    const changeRecord = await domain.table('plan_changes').get(dep.change.id)
    await domain.table('plan_changes').put(dep.change.id, {
      ...changeRecord,
      diff: { before: { goal: 'g0' }, after: { goal: 'g1' } },
    })
    const legacyComputed = await call(api, 'plan.change.diff', { id: projectId, from: 1, to: 2 })
    checkEqual('an overwritten legacy diff is recomputed', legacyComputed.source, 'computed')
    checkEqual('the recomputed legacy diff has the goal', legacyComputed.diff.project[0]?.field, 'goal')

    const limited = createStore(domain, { limits: { changes: 1 } })
    const limitedProject = await limited.createProject({ workspace: '/tmp/c4-ws', name: '限额', goal: 'g' }, tick())
    let limitCode = 'ok'
    try {
      await limited.applyChange(limitedProject.project.id, { goal: 'g2' }, { at: tick() })
    } catch (error) {
      limitCode = error?.code
    }
    checkEqual('the change history limit rejects', limitCode, 'plan/change-limit')

    const card = await call(api, 'create', { workspace: '/tmp/c4-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
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
