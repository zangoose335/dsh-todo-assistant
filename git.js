/**
 * todo-assistant — git coordinates for a captured card (DESIGN.md §3.10).
 *
 * The commit is the "dirty fingerprint": even after a rename, `git show
 * <commit>` still reconstructs the tree, and `git blame` can follow an old
 * symbol to its new home. So the host resolves it at capture time and the model
 * never has to produce it.
 *
 * Best effort only: a missing repo, a detached worktree, a missing `.git`, or an
 * unavailable subprocess all degrade to empty coordinates instead of failing the
 * capture. `subprocess` is preferred because it understands worktrees and
 * packed refs; the file reader is the documented fallback.
 *
 * No bare package imports, so `scripts/verify-domain.mjs` can exercise the file
 * path against a temporary repository.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** The coordinate block a card starts with when nothing can be resolved. */
function emptyCoordinates() {
  return { commit: '', branch: '', symbols: [] }
}

/**
 * Run one git command through the host subprocess service.
 *
 * @param subprocess - `ctx.subprocess`.
 * @param executable - resolved git path.
 * @param cwd - repository working directory.
 * @param args - git arguments.
 * @returns trimmed stdout.
 */
async function runGit(subprocess, executable, cwd, args) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  timer.unref?.()
  try {
    const handle = subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 2048 } },
      graceMs: 2000,
      signal: controller.signal,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited with ${outcome.exitCode}`)
    return handle.collected.stdout?.readFrom(0).text.trim() ?? ''
  } finally {
    clearTimeout(timer)
  }
}

/** Read coordinates through `git rev-parse`. */
async function coordinatesFromGit(subprocess, cwd) {
  const executable = await subprocess.resolveExecutable('git')
  const commit = await runGit(subprocess, executable, cwd, ['rev-parse', '--verify', 'HEAD'])
  if (commit === '') throw new Error('empty HEAD')
  let branch = ''
  try {
    branch = await runGit(subprocess, executable, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    branch = ''
  }
  if (branch === 'HEAD') branch = ''
  return { commit, branch, symbols: [] }
}

/**
 * Locate the git directory of a working tree, following a `.git` file
 * (submodule / linked worktree) to its target.
 *
 * @param cwd - working directory.
 * @returns the git directory, or undefined when absent.
 */
async function gitDirectoryOf(cwd) {
  const dotGit = join(cwd, '.git')
  try {
    const text = await readFile(dotGit, 'utf8')
    const line = text.trim()
    if (!line.startsWith('gitdir:')) return undefined
    const target = line.slice('gitdir:'.length).trim()
    return isAbsolute(target) ? target : resolve(cwd, target)
  } catch (error) {
    if (error?.code === 'EISDIR') return dotGit
    return undefined
  }
}

/** Resolve one ref to a commit, falling back to `packed-refs`. */
async function commitOfRef(gitDir, ref) {
  try {
    return (await readFile(join(gitDir, ref), 'utf8')).trim()
  } catch {
    // Packed refs keep the same value in `<sha> <ref>` lines.
  }
  try {
    const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') continue
      const [sha, name] = line.trim().split(/\s+/u)
      if (name === ref) return sha
    }
  } catch {
    // No packed refs either.
  }
  return ''
}

/** Read coordinates straight out of the git files. */
async function coordinatesFromFiles(cwd) {
  const gitDir = await gitDirectoryOf(cwd)
  if (gitDir === undefined) throw new Error('no git directory')
  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
  if (!head.startsWith('ref:')) {
    // Detached HEAD stores the commit directly.
    return { commit: head, branch: '', symbols: [] }
  }
  const ref = head.slice('ref:'.length).trim()
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
  const commit = await commitOfRef(gitDir, ref)
  return { commit, branch, symbols: [] }
}

/**
 * Resolve the code coordinates of one working directory.
 *
 * @param cwd - the session working directory.
 * @param subprocess - optional `ctx.subprocess`; without it the files are read directly.
 * @returns coordinates, never throwing and never partially filled by accident.
 */
export async function readCodeCoordinates(cwd, subprocess) {
  if (typeof cwd !== 'string' || cwd === '') return emptyCoordinates()
  if (subprocess !== undefined && subprocess !== null) {
    try {
      return await coordinatesFromGit(subprocess, cwd)
    } catch {
      // Fall through to the file reader.
    }
  }
  try {
    return await coordinatesFromFiles(cwd)
  } catch {
    return emptyCoordinates()
  }
}
