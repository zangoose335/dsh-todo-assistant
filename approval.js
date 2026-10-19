/**
 * todo-assistant — the `todo_recall` approval request.
 *
 * This module is pure and import-free: the host registers the returned decision
 * on `tools/pre-execute`, and the offline harness can assert its shape without a
 * live approval UI. ToolRuntime owns the actual ask; only `allowed-once`
 * proceeds, and every non-grant fails closed.
 */

/** Build the ask decision for one `todo_recall` call, or undefined for other tools. */
export function recallApprovalDecision(exec) {
  if (exec?.name !== 'todo_recall') return undefined
  const args = exec?.arguments ?? {}
  const current = typeof args?.target === 'string' && args.target.trim() === 'session:current'
  const id = typeof args?.id === 'string' && args.id.trim() !== ''
    ? args.id.trim()
    : current
      ? 'session:current'
      : '(missing card)'
  const source = current
    ? 'current session'
    : typeof args?.sourceId === 'string' && args.sourceId.trim() !== ''
      ? `source ${args.sourceId.trim()}`
      : 'origin source'
  const slice = Array.isArray(args?.slice) && args.slice.length === 2
    ? `, slice ${args.slice[0]}..${args.slice[1]}`
    : ', manifest only'
  const gap = typeof args?.gap === 'string' && args.gap.trim() !== '' ? `; gap: ${args.gap.trim()}` : ''
  const why = typeof args?.reason === 'string' && args.reason.trim() !== '' ? `; reason: ${args.reason.trim()}` : ''
  const reason = `todo_recall ${id}: ${source}${slice}${gap}${why}`
  return {
    kind: 'ask',
    reason,
    displayReason: {
      en: `Allow todo_recall to read history for card ${id} (${source}${slice}${gap}${why})?`,
      zh: `允许 todo_recall 读取卡片 ${id} 的历史（${source}${slice}${gap}${why}）？`,
    },
  }
}
