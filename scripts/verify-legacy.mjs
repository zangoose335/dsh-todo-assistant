/**
 * T4 downgrade probe — run the *real* pre-brief plugin code against new data.
 *
 * The old schema simulation in verify-brief.mjs proves what zod does to an
 * unknown field; it does not prove what the previously shipped plugin does.
 * This script extracts the last commit before `brief` (`be8ebf4`) from git into
 * a temp directory, opens a new-format storage file with that real old code,
 * lets it write one record back, and then restores the backup with the current
 * code.
 *
 * Scope limits (must stay in the acceptance doc):
 *   - This is real old code + a real storage file, not the old plugin running
 *     inside a DSH UI or an arbitrary published package.
 *   - Only the fields present in this synthetic file are exercised.
 *
 * If the commit is unavailable (shallow clone), the script prints SKIP and must
 * not be reported as a pass.
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createStore } from '../api.js'
import { createTodoSpec } from '../domain.js'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const MODULES = join(INSTALL_ROOT, 'node_modules')
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const FIXTURE = join(HERE, 'fixtures', 'todo_assistant.v1.json')
const OLD_COMMIT = process.env.TODO_LEGACY_COMMIT ?? 'be8ebf4'

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

function commitExists(commit) {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: REPO, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function extractCommit(commit, target) {
  const archive = execFileSync('git', ['archive', commit], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', target], { input: archive, maxBuffer: 64 * 1024 * 1024 })
}

/** The child script: open the new data with the old code and write one card. */
function oldProbeSource() {
  return `
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT
const MODULES = join(INSTALL_ROOT, 'node_modules')
const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)

const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
const { z } = await load('zod/index.js')
const old = await import('./domain.js')

const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root: process.env.GATE1_ROOT })
await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })
const spec = old.createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
const domain = await ctx.storageDomain.open(spec)
const table = domain.table('todos')
const id = process.env.GATE1_CARD
const record = table.get(id)
const result = {
  opened: record !== undefined,
  title: record?.title ?? '',
  hasBrief: record?.brief !== undefined,
  hasSources: record?.sources !== undefined,
  hasRequest: record?.request !== undefined,
  hasHandling: record?.handling !== undefined,
}
if (record !== undefined) {
  await table.put(id, { ...record, title: record.title + ' [old-write]' })
}
await domain.close()
await ctx.registry.delete(Storage)
console.log(JSON.stringify(result))
`
}

async function main() {
  console.log(`repo: ${REPO}`)
  console.log(`old commit: ${OLD_COMMIT}`)
  if (!commitExists(OLD_COMMIT)) {
    console.log(`SKIP: commit ${OLD_COMMIT} is not available; real old-version behavior was NOT verified.`)
    return
  }

  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const Storage = (await load('@deepseek-ai/dsh-storage/lib/index.js')).default
  const storageJson = await load('@deepseek-ai/dsh-storage-json/lib/index.js')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain/lib/index.js')
  const { z } = await load('zod/index.js')

  const root = await mkdtemp(join(tmpdir(), 'todo-assistant-legacy-'))
  const oldDir = join(root, 'old-plugin')
  const dataPath = join(root, 'todo_assistant.json')
  const backupPath = join(root, 'todo_assistant.backup.json')
  console.log(`temp root: ${root}`)

  const ctx = new Context()
  try {
    await copyFile(FIXTURE, dataPath)
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: storageJson.apply, inject: storageJson.inject, Config: storageJson.Config }, { root })
    await ctx.plugin({ apply: storageDomain.apply, inject: storageDomain.inject, Config: storageDomain.Config }, { backend: 'json' })

    const spec = createTodoSpec({ z, defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable })
    const domain = await ctx.storageDomain.open(spec)
    const store = createStore(domain)
    const at = 1_800_000_500_000
    const card = await store.create(
      {
        workspace: '/tmp/gate1-legacy',
        title: '新格式卡片',
        kind: 'defect',
        nextStep: '检查旧版本是否保留新字段',
        brief: {
          goal: '验证旧版本读取新数据',
          confirmed: [{ text: '旧版本不认识 brief 和 sources', basis: 'requirement' }],
          constraints: [{ text: '旧版本只读诊断，不写回', basis: 'decided' }],
          nextAction: '检查旧版本是否保留新字段',
        },
      },
      () => at,
    )
    await store.addSource(
      card.id,
      { sid: 'src_gate1', kind: 'file', label: '旧版本文件', where: { file: 'legacy.swift' }, origin: 'observed' },
      () => at + 1,
    )
    const written = store.get(card.id)
    check('current version stores a brief', written.brief !== undefined && written.brief.goal === '验证旧版本读取新数据', JSON.stringify(written.brief))
    checkEqual('current version stores a source pointer', written.sources?.length, 1)
    await domain.close()
    await copyFile(dataPath, backupPath)

    console.log(`\nReal old code (${OLD_COMMIT}) opens the new data`)
    await mkdir(oldDir, { recursive: true })
    extractCommit(OLD_COMMIT, oldDir)
    const probePath = join(oldDir, 'gate1-old-probe.mjs')
    await writeFile(probePath, oldProbeSource(), 'utf8')
    const stdout = execFileSync(process.execPath, [probePath], {
      cwd: oldDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        DSH_INSTALL_ROOT: INSTALL_ROOT,
        GATE1_ROOT: root,
        GATE1_CARD: card.id,
      },
    })
    const probe = JSON.parse(stdout.trim().split('\n').at(-1))
    check('the old code opens the new file without crashing', probe.opened === true, JSON.stringify(probe))
    check('the old code reads the card but strips brief', probe.hasBrief === false, JSON.stringify(probe))
    check('the old code also strips sources', probe.hasSources === false, JSON.stringify(probe))

    const downgraded = JSON.parse(await readFile(dataPath, 'utf8')).tables.todos[card.id]
    check('an old write permanently drops brief from disk', downgraded.brief === undefined, JSON.stringify(downgraded.brief))
    check('an old write permanently drops sources from disk', downgraded.sources === undefined, JSON.stringify(downgraded.sources))
    check('the old write is otherwise applied', typeof downgraded.title === 'string' && downgraded.title.includes('[old-write]'), downgraded.title)

    console.log('\nRestore the backup and reopen with the current code')
    await copyFile(backupPath, dataPath)
    const reopened = await ctx.storageDomain.open(spec)
    const restoredStore = createStore(reopened)
    const restored = restoredStore.get(card.id)
    check('the restored file has the brief again', restored.brief !== undefined && restored.brief.goal === '验证旧版本读取新数据', JSON.stringify(restored?.brief))
    checkEqual('the restored file has the source pointer again', restored.sources?.length, 1)
    checkEqual('the old write was rolled back', restored.title, '新格式卡片')
    await reopened.close()

    console.log('\nScope limits: this is real old code against a synthetic new file; it is not the old plugin in a DSH UI.')
    console.log(`\n${checks - failures}/${checks} checks passed`)
  } finally {
    await ctx.registry.delete(Storage)
    await rm(root, { recursive: true, force: true })
  }
}

function checkEqual(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
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
