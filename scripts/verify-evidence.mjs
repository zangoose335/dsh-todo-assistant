/**
 * Headless verification of PLAN.md C1 — phase results and test evidence.
 *
 * Covered:
 *   1. collecting test evidence from session events (pairing by call id, test
 *      command detection, exit-code/timeout status, ignoring non-shell tools);
 *   2. merging AI claims with observed results: real results win, unmentioned
 *      runs are appended, and result verification is derived;
 *   3. the developer confirmation upgrading non-tool tests to `developer`;
 *   4. `todo_plan_propose` writes a pending proposal only, rejects stale
 *      versions and unknown phases, and never changes the project;
 *   5. applying a proposal (with or without `confirmTests`) records the result,
 *      an optional status, one change, and expected evidence levels;
 *   6. stale/duplicate apply and reject behavior;
 *   7. ordinary cards and durability.
 *
 * Usage: node scripts/verify-evidence.mjs
 * Env:   DSH_INSTALL_ROOT (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi, createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'
import { collectTestEvidence, commandsMatch, confirmTestEvidence, deriveResultVerification, mergeResultEvidence } from '../evidence.js'
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

/** Assert a tool result matches its closed output schema. */
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

function callEvent(seq, callId, command, name) {
  return {
    seq,
    time: 1_800_500_000_000 + seq,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: name ?? 'bash', arguments: JSON.stringify({ command }) },
  }
}

function resultEvent(seq, callId, { isError = false, text = 'ok' } = {}) {
  return {
    seq,
    time: 1_800_500_000_000 + seq,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { toolCallId: callId, isError, content: text === '' ? [] : [{ type: 'text', text }] },
    },
  }
}

function makeExec(events, sessionId = 's-c1') {
  return { agent: { session: { id: sessionId, snapshotEvents: () => events } } }
}

async function main() {
  console.log(`install root: ${INSTALL_ROOT}`)

  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-c1-'))
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
    const clock = { value: 1_800_500_000_000 }
    const tick = () => (clock.value += 1000)
    const api = createApi({ store, now: tick })
    const detail = async (id) => (await call(api, 'plan.detail', { id })).item

    console.log('\nC1 §1 collect test evidence from session events')
    const events = [
      callEvent(1, 'c1', 'pnpm test'),
      resultEvent(2, 'c1', { text: 'all good' }),
      callEvent(3, 'c2', 'pytest tests/'),
      resultEvent(4, 'c2', { isError: true, text: '2 failed' }),
      callEvent(5, 'c3', 'npm run build'),
      resultEvent(6, 'c3', { text: 'built' }),
      callEvent(7, 'c4', 'pnpm test', 'read_file'),
      resultEvent(8, 'c4', { text: 'ignored' }),
      callEvent(9, 'c5', 'node scripts/verify-domain'),
      resultEvent(10, 'c5', { text: 'checks\n[exit code: 2]' }),
      callEvent(11, 'c6', 'vitest run'),
    ]
    const observed = collectTestEvidence(events)
    checkEqual(
      'only paired, shell-shaped test runs become evidence',
      observed.map((entry) => [entry.command, entry.status, entry.verification]),
      [
        ['pnpm test', 'passed', 'tool-result'],
        ['pytest tests/', 'failed', 'tool-result'],
        ['node scripts/verify-domain', 'failed', 'tool-result'],
      ],
    )
    check('a call without a result is not evidence', observed.every((entry) => entry.command !== 'vitest run'))
    check('commands match by normalized containment', commandsMatch('pnpm test', 'pnpm test --watch') && !commandsMatch('pnpm test', 'npm run build'))

    console.log('\nC1 §2 merge claims with observed evidence')
    const claimed = {
      summary: '接口完成',
      completed: [],
      files: [],
      issues: [],
      risks: [],
      decisionsChanged: [],
      planDelta: '',
      sourceIds: [],
      recordedAt: 1,
      recordedBySession: '',
      tests: [
        { command: 'pnpm test', status: 'failed', verification: 'tool-result', at: 1 },
        { command: 'npm run lint', status: 'passed', verification: 'ai-claim', at: 1 },
      ],
    }
    const merged = mergeResultEvidence(claimed, observed, { at: 2 })
    checkEqual(
      'observed results override claims and unmentioned runs are appended',
      merged.tests.map((test) => [test.command, test.status, test.verification]),
      [
        ['pnpm test', 'passed', 'tool-result'],
        ['npm run lint', 'passed', 'ai-claim'],
        ['pytest tests/', 'failed', 'tool-result'],
        ['node scripts/verify-domain', 'failed', 'tool-result'],
      ],
    )
    checkEqual('a failed tool result makes the result unverified', merged.verification, 'unverified')
    const clean = mergeResultEvidence(
      { ...claimed, tests: [{ command: 'pnpm test', status: 'failed', verification: 'ai-claim', at: 1 }] },
      [observed[0]],
      { at: 2 },
    )
    checkEqual('all passing tool evidence makes the result verified', clean.verification, 'verified')
    const noEvidence = mergeResultEvidence(claimed, [], { at: 2 })
    checkEqual('no observed evidence keeps the result claimed', [noEvidence.verification, noEvidence.tests[0].verification], ['claimed', 'ai-claim'])
    checkEqual('derived verification handles empty evidence', deriveResultVerification([]), 'claimed')

    const limited = mergeResultEvidence(claimed, observed, { at: 2, append: [observed[0]] })
    checkEqual(
      'the append window can verify a claim without re-reporting older runs',
      [limited.tests.map((test) => test.command), limited.verification],
      [['pnpm test', 'npm run lint'], 'verified'],
    )

    const confirmed = confirmTestEvidence(merged)
    checkEqual(
      'developer confirmation upgrades only non-tool tests',
      confirmed.tests.map((test) => test.verification),
      ['tool-result', 'developer', 'tool-result', 'tool-result'],
    )

    console.log('\nC1 §3 todo_plan_propose records a proposal only')
    const created = await call(api, 'plan.create', { workspace: '/tmp/c1-ws', name: 'C1 计划', goal: '结果与证据' })
    const projectId = created.item.id
    const added = await call(api, 'plan.phase.add', { id: projectId, title: '接口', number: '1', goal: '写接口' })
    const phaseId = added.change.affectedPhaseIds[0]
    const baseVersion = (await detail(projectId)).version
    const tool = createTodoPlanProposeTool({ defineTool, store, now: tick })
    const exec = makeExec(events)
    const proposed = await tool.execute(
      {
        projectId,
        phaseId,
        baseVersion,
        status: 'done',
        reason: '测试已跑完',
        result: {
          summary: '接口实现完成',
          completed: ['路由'],
          files: ['api.js'],
          tests: [
            { command: 'pnpm test', status: 'failed' },
            { command: 'npm run lint', status: 'passed' },
          ],
        },
      },
      exec,
    )
    checkEqual('the tool returns a proposal shape', proposed.shape, 'proposal')
    checkOutput(tool, proposed, 'todo_plan_propose')
    checkEqual(
      'the proposal keeps merged evidence and the suggested status',
      [proposed.verification, proposed.suggestedStatus, proposed.tests.length],
      ['unverified', 'done', 4],
    )
    const afterPropose = await detail(projectId)
    checkEqual(
      'proposing changes nothing in the project',
      [afterPropose.version, afterPropose.phases[0].status, afterPropose.phases[0].result === undefined],
      [baseVersion, 'pending', true],
    )
    const boundaryEvents = [
      { seq: 1, time: 1_800_500_000_001, type: 'user/message', data: {} },
      callEvent(2, 'old-1', 'pnpm test'),
      resultEvent(3, 'old-1', { text: 'ok' }),
      { seq: 4, time: 1_800_500_000_004, type: 'user/message', data: {} },
      callEvent(5, 'recent-1', 'vitest run'),
      resultEvent(6, 'recent-1', { text: 'ok' }),
    ]
    const boundary = await tool.execute(
      {
        projectId,
        phaseId,
        baseVersion,
        result: { summary: '只看当轮补充', tests: [{ command: 'pnpm test', status: 'passed' }] },
      },
      makeExec(boundaryEvents),
    )
    checkEqual(
      'claims may cite older runs but only the current turn is appended',
      [boundary.tests.map((test) => test.command), boundary.verification],
      [['pnpm test', 'vitest run'], 'verified'],
    )
    await call(api, 'plan.proposal.reject', { id: boundary.proposalId, reason: '边界测试，不应用' })

    const pending = await call(api, 'plan.proposal.list', { id: projectId })
    const pendingItems = pending.items.filter((item) => item.status === 'pending')
    checkEqual(
      'the proposal is stored as pending phase-result',
      [pendingItems.length, pendingItems[0].kind, pendingItems[0].phaseId, pendingItems[0].status],
      [1, 'phase-result', phaseId, 'pending'],
    )
    const rendered = tool.output.render({}, proposed)
    check('the tool render shows evidence and says nothing changed', rendered[0].text.includes('Evidence: unverified') && rendered[0].text.includes('Nothing has changed yet'), rendered[0].text.slice(0, 160))

    await expectToolCode(
      'a stale base version is rejected',
      () => tool.execute({ projectId, phaseId, baseVersion: baseVersion - 1, result: { summary: 'x' } }, exec),
      'plan/stale',
    )
    await expectToolCode(
      'an unknown phase is rejected',
      () => tool.execute({ projectId, phaseId: 'ph_missing', baseVersion, result: { summary: 'x' } }, exec),
      'plan/phase-not-found',
    )

    console.log('\nC1 §4 apply with developer confirmation')
    const applied = await call(api, 'plan.proposal.apply', { id: proposed.proposalId, confirmTests: false })
    const afterApply = await detail(projectId)
    checkEqual(
      'apply writes the result and the suggested status',
      [afterApply.version, afterApply.phases[0].status, afterApply.phases[0].result.summary, afterApply.phases[0].result.verification],
      [baseVersion + 1, 'done', '接口实现完成', 'unverified'],
    )
    checkEqual('apply records one phase-result change', applied.change.kind, 'phase-result')
    checkEqual(
      'without confirmation the lint test stays an AI claim',
      afterApply.phases[0].result.tests.find((test) => test.command === 'npm run lint')?.verification,
      'ai-claim',
    )
    await expectCode('applying twice is rejected', api, 'plan.proposal.apply', { id: proposed.proposalId }, 'plan/proposal-not-pending')

    const noEvidenceProposal = await tool.execute(
      {
        projectId,
        phaseId,
        baseVersion: afterApply.version,
        result: {
          summary: '无工具证据',
          tests: [{ command: 'make test', status: 'passed' }],
        },
      },
      makeExec([]),
    )
    checkEqual('no observed evidence is claimed', [noEvidenceProposal.verification, noEvidenceProposal.tests[0].verification], ['claimed', 'ai-claim'])
    const confirmedApply = await call(api, 'plan.proposal.apply', { id: noEvidenceProposal.proposalId, confirmTests: true })
    const afterConfirm = await detail(projectId)
    checkEqual(
      'developer confirmation upgrades the test and the result',
      [afterConfirm.phases[0].result.tests[0].verification, afterConfirm.phases[0].result.verification],
      ['developer', 'verified'],
    )
    checkEqual('the confirmed apply also records one change', confirmedApply.change.kind, 'phase-result')

    console.log('\nC1 §5 stale, reject and durability')
    const staleProposal = await tool.execute(
      { projectId, phaseId, baseVersion: afterConfirm.version, result: { summary: '将被过期' } },
      makeExec([]),
    )
    await call(api, 'plan.patch', { id: projectId, patch: { goal: '改一下目标' } })
    await expectCode('a proposal applied after a project change is stale', api, 'plan.proposal.apply', { id: staleProposal.proposalId }, 'plan/stale')
    const rejected = await call(api, 'plan.proposal.reject', { id: staleProposal.proposalId, reason: '版本过旧' })
    checkEqual('reject records the decision', [rejected.item.status, rejected.item.rejectedReason], ['rejected', '版本过旧'])
    const versionBeforeReject = (await detail(projectId)).version
    await expectCode('rejecting twice is rejected', api, 'plan.proposal.reject', { id: staleProposal.proposalId }, 'plan/proposal-not-pending')
    checkEqual('reject does not change the version', (await detail(projectId)).version, versionBeforeReject)

    const card = await call(api, 'create', { workspace: '/tmp/c1-ws', title: '普通卡', kind: 'defect', nextStep: '检查一下' })
    checkEqual('ordinary cards are unaffected', [card.item.projectId, card.item.phaseId], [null, null])
    await domain.close()
    const reopened = await ctx.storageDomain.open(spec)
    const reopenedStore = createStore(reopened)
    checkEqual('a reopened project keeps the result', reopenedStore.getProject(projectId)?.phases[0]?.result?.summary, '无工具证据')
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
