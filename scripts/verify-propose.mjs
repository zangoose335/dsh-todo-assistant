/**
 * Headless verification of PLAN.md C3 — project-level proposals, developer
 * confirmation boundaries, and the audit trail.
 *
 * Covered:
 *   1. `todo_plan_propose` with `kind=project-patch` changes only the six
 *      whitelisted project fields, host-computes the diff/affected phases, and
 *      writes nothing;
 *   2. applying a project proposal bumps the version once, records a `patch`
 *      change by `proposal`, and updates the fields; rejecting leaves the
 *      project untouched;
 *   3. stale proposals reject at propose time and at apply time; no-change and
 *      unknown phases reject;
 *   4. the proposal list keeps applied/rejected records for the audit view;
 *   5. ordinary cards are unaffected.
 *
 * Usage: node scripts/verify-propose.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'
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

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-c3-'))
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
    const clock = { value: 1_800_700_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })
    const detail = async (id) => (await call(api, 'plan.detail', { id })).item
    const created = await call(api, 'plan.create', { workspace: '/tmp/c3-ws', name: 'C3 计划', goal: '项目级提议' })
    const projectId = created.item.id
    const addA = await call(api, 'plan.phase.add', { id: projectId, title: 'A', number: '1' })
    const pidA = addA.change.affectedPhaseIds[0]
    const addB = await call(api, 'plan.phase.add', { id: projectId, title: 'B', number: '2' })
    const pidB = addB.change.affectedPhaseIds[0]
    await call(api, 'plan.patch', { id: projectId, patch: { currentPhaseId: pidA } })
    const tool = createTodoPlanProposeTool({ defineTool, store, now: tick })
    const exec = { agent: { session: { id: 's-c3', snapshotEvents: () => [] } } }
    let version = (await detail(projectId)).version

    console.log('\nC3 §1 project-patch proposes without writing')
    const proposal = await tool.execute(
      {
        projectId,
        baseVersion: version,
        kind: 'project-patch',
        name: 'C3 计划（改名）',
        goal: '新的项目目标',
        projectStatus: 'paused',
        currentPhaseNumber: '2',
        projectDecisions: ['采用项目级提议'],
        projectRisks: ['并发提议'],
        reason: '执行中调整项目方向',
      },
      exec,
    )
    checkEqual('the tool returns a project-patch proposal', [proposal.shape, proposal.kind], ['proposal', 'project-patch'])
    checkOutput(tool, proposal, 'todo_plan_propose project-patch')
    checkEqual(
      'the diff lists the six project fields',
      proposal.diff.project.map((entry) => entry.field).sort(),
      ['currentPhaseId', 'goal', 'name', 'status'],
    )
    checkEqual('decisions and risks are diffed as text', [proposal.diff.decisions.added, proposal.diff.risks.added], [['采用项目级提议'], ['并发提议']])
    checkEqual('the new current phase is affected', proposal.affected.map((entry) => entry.number), ['2'])
    checkEqual(
      'proposing changes nothing',
      [(await detail(projectId)).version, (await detail(projectId)).name, (await detail(projectId)).currentPhaseId],
      [version, 'C3 计划', pidA],
    )
    check('the render shows the project diff and waits for the developer', tool.output.render({}, proposal)[0].text.includes('Project name:') && tool.output.render({}, proposal)[0].text.includes('Nothing has changed yet'))

    console.log('\nC3 §2 apply / reject and the audit trail')
    const applied = await call(api, 'plan.proposal.apply', { id: proposal.proposalId })
    const after = await detail(projectId)
    checkEqual(
      'apply writes all six fields and bumps once',
      [after.version, after.name, after.goal, after.status, after.currentPhaseId, after.decisions[0]?.text, after.risks[0]?.text],
      [version + 1, 'C3 计划（改名）', '新的项目目标', 'paused', pidB, '采用项目级提议', '并发提议'],
    )
    checkEqual('the change is a proposal-applied patch', [applied.change.kind, applied.change.by, applied.change.affectedPhaseIds], ['patch', 'proposal', [pidB]])
    checkEqual(
      'the applied proposal is kept for audit',
      (await call(api, 'plan.proposal.list', { id: projectId })).items.find((item) => item.id === proposal.proposalId)?.status,
      'applied',
    )

    version = (await detail(projectId)).version
    const rejectedProposal = await tool.execute(
      { projectId, baseVersion: version, kind: 'project-patch', goal: '不采纳的目标' },
      exec,
    )
    const rejected = await call(api, 'plan.proposal.reject', { id: rejectedProposal.proposalId, reason: '方向不对' })
    checkEqual('reject records the reason', [rejected.item.status, rejected.item.rejectedReason], ['rejected', '方向不对'])
    checkEqual('reject leaves the project alone', [(await detail(projectId)).version, (await detail(projectId)).goal], [version, '新的项目目标'])
    checkEqual(
      'the proposal list keeps both applied and rejected records',
      (await call(api, 'plan.proposal.list', { id: projectId })).items.map((item) => item.status).sort(),
      ['applied', 'rejected'],
    )

    console.log('\nC3 §3 stale, no-change and unknown phases')
    await expectToolCode(
      'a stale project proposal is rejected at propose time',
      () => tool.execute({ projectId, baseVersion: version - 1, kind: 'project-patch', goal: '旧版本' }, exec),
      'plan/stale',
    )
    await expectToolCode(
      'a no-change project proposal is rejected',
      () => tool.execute({ projectId, baseVersion: version, kind: 'project-patch', goal: '新的项目目标' }, exec),
      'plan/no-change',
    )
    await expectToolCode(
      'an unknown current phase is rejected',
      () => tool.execute({ projectId, baseVersion: version, kind: 'project-patch', currentPhaseNumber: '99' }, exec),
      'plan/phase-not-found',
    )

    const staleProposal = await tool.execute(
      { projectId, baseVersion: version, kind: 'project-patch', name: '稍后过期' },
      exec,
    )
    await call(api, 'plan.patch', { id: projectId, patch: { goal: '中间又改了' } })
    await expectCode('a proposal applied after another change is stale', api, 'plan.proposal.apply', { id: staleProposal.proposalId }, 'plan/stale')

    version = (await detail(projectId)).version
    const partial = await tool.execute({ projectId, baseVersion: version, kind: 'project-patch', goal: '只改目标' }, exec)
    await call(api, 'plan.proposal.apply', { id: partial.proposalId })
    const partialAfter = await detail(projectId)
    checkEqual(
      'a partial project proposal leaves the other fields alone',
      [partialAfter.goal, partialAfter.name, partialAfter.status],
      ['只改目标', 'C3 计划（改名）', 'paused'],
    )

    const card = await call(api, 'create', { workspace: '/tmp/c3-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('ordinary cards are unaffected', [card.item.projectId, card.item.phaseId], [null, null])
    check('the only write tool is todo_plan_propose (no AI apply)', tool.name === 'todo_plan_propose')

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
