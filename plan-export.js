/**
 * todo-assistant — write a plan's Markdown export next to its workspace.
 *
 * The browser asks the host to export; the host writes one file inside the
 * project's own workspace folder. This module is kept free of DSH imports so the
 * verification harness can exercise the real filesystem behavior directly.
 *
 * Rules:
 * - only an absolute, existing workspace inside the project is written to;
 * - the file name comes from the project name, with path-hostile characters
 *   replaced, and an existing file is never overwritten (`-2`, `-3`, …);
 * - `inbox` plans have no folder and are rejected with a clear message.
 */
import { access, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** The workspace key for plans that belong to no repository. */
const INBOX = 'inbox'
const FALLBACK_NAME = 'plan'

/**
 * Turn a project name into one safe file name (without the `.md` suffix).
 *
 * @param name - the project name.
 * @returns a non-empty, path-safe base name.
 */
export function planExportFileName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '')
    .slice(0, 80)
  return cleaned === '' ? FALLBACK_NAME : cleaned
}

/**
 * Write `content` as `<name>.md` in the workspace, never overwriting.
 *
 * @param request - `{ workspace, name, content }`.
 * @returns `{ path, fileName }`.
 * @throws {Error} with a user-facing message when the folder is unusable.
 */
export async function writePlanMarkdown({ workspace, name, content }) {
  const dir = typeof workspace === 'string' ? workspace.trim() : ''
  if (dir === '' || dir === INBOX) throw new Error('这个计划在收件箱里，先把它放到一个工作区再导出')
  if (!isAbsolute(dir)) throw new Error('工作区不是绝对路径，无法写文件')
  try {
    await access(dir)
  } catch {
    throw new Error('工作区文件夹不存在，无法写文件')
  }
  const base = planExportFileName(name)
  for (let index = 1; index <= 200; index += 1) {
    const fileName = index === 1 ? `${base}.md` : `${base}-${index}.md`
    const target = join(dir, fileName)
    const fromDir = relative(dir, target)
    if (fromDir === '' || fromDir.startsWith('..') || isAbsolute(fromDir)) throw new Error('导出路径不安全')
    try {
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
      return { path: target, fileName }
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('同名文件太多，请改一下项目名再导出')
}
