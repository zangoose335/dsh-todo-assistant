/**
 * todo-assistant — duplicate detection before one card becomes two (DESIGN.md §6.5).
 *
 * The case this protects against: the developer glances at a card, concludes
 * "not it", and adds the same thing again. So the check is narrow on purpose —
 * same workspace, still open, at least one shared touched file, and a similar
 * title. Anything looser would refuse legitimate new cards.
 *
 * Pure and import-free so the offline harness can drive it directly.
 */

/** Minimum title similarity (character-bigram Dice) that counts as a duplicate. */
export const DUPLICATE_TITLE_THRESHOLD = 0.55

/** Lowercase, drop whitespace and punctuation, keep letters and numbers. */
function normalizeTitle(title) {
  if (typeof title !== 'string') return ''
  return title
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}

/** Character bigrams of one normalized title. */
function bigrams(text) {
  const chars = [...text]
  if (chars.length <= 1) return chars.length === 1 ? [chars[0]] : []
  const grams = []
  for (let index = 0; index < chars.length - 1; index += 1) grams.push(chars[index] + chars[index + 1])
  return grams
}

/**
 * Similarity of two titles as the Dice coefficient over character bigrams.
 *
 * @param a - one title.
 * @param b - another title.
 * @returns 0..1.
 */
export function titleSimilarity(a, b) {
  const left = bigrams(normalizeTitle(a))
  const right = bigrams(normalizeTitle(b))
  if (left.length === 0 || right.length === 0) return normalizeTitle(a) === normalizeTitle(b) ? 1 : 0
  const counts = new Map()
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let shared = 0
  for (const gram of right) {
    const count = counts.get(gram)
    if (count === undefined || count === 0) continue
    counts.set(gram, count - 1)
    shared += 1
  }
  return (2 * shared) / (left.length + right.length)
}

/** Normalize one touched path for comparison. */
function cleanPath(path) {
  return typeof path === 'string' ? path.trim().replace(/^\.\//u, '').replace(/\/+$/u, '') : ''
}

/**
 * Find the card a new capture would duplicate.
 *
 * @param cards - every stored card (`store.all()`).
 * @param candidate - `{ workspace, title, touchedFiles }` of the new capture.
 * @param threshold - title similarity required, defaults to {@link DUPLICATE_TITLE_THRESHOLD}.
 * @returns the best matching card plus why, or undefined.
 */
export function findDuplicate(cards, candidate, threshold = DUPLICATE_TITLE_THRESHOLD) {
  const workspace = typeof candidate?.workspace === 'string' ? candidate.workspace : ''
  const touched = new Set((Array.isArray(candidate?.touchedFiles) ? candidate.touchedFiles : []).map(cleanPath).filter(Boolean))
  if (workspace === '' || touched.size === 0) return undefined
  let best
  for (const card of cards) {
    if (card.workspace !== workspace) continue
    if (card.status !== 'open' && card.status !== 'doing') continue
    const sharedFiles = []
    for (const file of Array.isArray(card.touchedFiles) ? card.touchedFiles : []) {
      const path = cleanPath(file)
      if (path !== '' && touched.has(path)) sharedFiles.push(path)
    }
    if (sharedFiles.length === 0) continue
    const similarity = titleSimilarity(card.title, candidate.title)
    if (similarity < threshold) continue
    if (best === undefined || similarity > best.similarity) {
      best = { card, similarity: Math.round(similarity * 100) / 100, sharedFiles }
    }
  }
  return best
}
