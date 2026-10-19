/**
 * Replay the recorded isolated model probes through the real capture tool.
 *
 * The probes themselves were run without tool calls (see
 * docs/GATE1-T5-PROBES.json). This script takes their recorded arguments and
 * shows what the current system does with them: accepted/rejected, warnings,
 * stored brief, and the read projection. It does not re-run a model and it does
 * not turn a green replay into a Gate 1 pass.
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'
import { createTodoAddTool, createTodoReadTool } from '../tool.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const FIXTURE = new URL('./fixtures/todo_assistant.v1.json', import.meta.url)
const PROBES = new URL('../docs/GATE1-T5-PROBES.json', import.meta.url)

const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)

const sequence = [
  { type: 'turn/start', seq: 4, data: { turn: 3 } },
  { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这个旁支任务记一下' }] } },
  { type: 'tool/result', seq: 9, data: {} },
]

function fakeSession(cwd, text) {
  const events = [...sequence.slice(0, 2), { type: 'user/message', seq: 6, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }]
  return { id: 'sess-gate1-probe', header: { cwd }, seq: 10, snapshotEvents: () => events }
}

function execFor(session) {
  return { agent: { id: 'sess-gate1-probe', session }, signal: new AbortController().signal, callId: 'call-gate1-probe' }
}

async function main() {
  const probes = JSON.parse(await readFile(PROBES, 'utf8'))
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { defineTool } = await load('@deepseek-ai/dsh-tools/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-gate1-probes-'))
  const ctx = new Context()
  try {
    await copyFile(FIXTURE, join(root, 'todo_assistant.json'))
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    const domain = await ctx.storageDomain.open(spec)
    const store = createStore(domain)
    let clock = 1_800_000_700_000
    const now = () => (clock += 1000)
    const tool = createTodoAddTool({
      defineTool,
      store,
      now,
      readGit: async () => ({ commit: '', branch: '', symbols: [] }),
      resolveWorkspace: async (cwd) => (cwd === '' ? 'inbox' : cwd),
    })
    const readTool = createTodoReadTool({ defineTool, store })

    console.log(`probe artifact: ${PROBES.pathname}`)
    console.log(`mode: ${probes.meta.mode}`)
    console.log(`caveat: ${probes.meta.caveat}`)

    for (const scenario of probes.scenarios) {
      const id = scenario.id
      console.log(`\n${id} decision=${scenario.decision} wouldCallRecall=${scenario.wouldCallRecall}`)
      if (scenario.decision !== 'create' || scenario.args === null || scenario.args === undefined) {
        console.log(`  no capture replayed (decision=${scenario.decision}); live ask/merge behavior is not exercised by this replay`)
        continue
      }
      const userText = scenario.args.requestExcerpt ?? scenario.context
      const exec = execFor(fakeSession(`/tmp/gate1-probe-${id}`, userText))
      try {
        const created = await tool.execute(scenario.args, exec)
        const stored = store.get(created.id)
        const read = await readTool.execute({ id: created.id }, exec)
        console.log(`  status=${created.status} brief=${created.brief} warnings=${JSON.stringify(created.warnings)}`)
        console.log(`  briefSource=${read.briefSource} briefWarnings=${JSON.stringify(read.briefWarnings)}`)
        console.log(`  goal=${JSON.stringify(read.brief.goal)} nextAction=${JSON.stringify(read.brief.nextAction)}`)
        console.log(`  counts confirmed=${read.brief.confirmed.length} constraints=${read.brief.constraints.length} leads=${read.brief.leads.length} open=${read.brief.openQuestions.length}`)
        console.log(`  bases confirmed=${JSON.stringify(read.brief.confirmed.map((item) => item.basis))} constraints=${JSON.stringify(read.brief.constraints.map((item) => item.basis))} leads=${JSON.stringify(read.brief.leads.map((item) => item.basis))} open=${JSON.stringify(read.brief.openQuestions.map((item) => [item.basis, item.impact ?? null]))}`)
        console.log(`  core.nextStep=${JSON.stringify(stored.core.nextStep)} brief.nextAction=${JSON.stringify(stored.brief.nextAction)}`)
      } catch (error) {
        console.log(`  REJECTED ${error.code}: ${error.message}`)
      }
    }

    console.log('\nThis is a replay of recorded probe outputs, not a model run and not a Gate 1 verdict.')
    console.log('Verdicts and scope limits live in docs/GATE1-T5-ACCEPTANCE.md.')
  } finally {
    await ctx.registry.delete(Storage)
    await rm(root, { recursive: true, force: true })
  }
}

main().then(
  () => {},
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
