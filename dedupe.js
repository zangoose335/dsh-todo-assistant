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
/** Minimum goal similarity when the title alone is not similar. */
export const DUPLICATE_GOAL_THRESHOLD = 0.65
/** If both goals are present and clearly unrelated, a shared file is not enough. */
export const DUPLICATE_GOAL_GUARD = 0.2

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

/** The goal a stored card actually presents, preferring the TaskBrief. */
function cardGoal(card) {
  return card?.brief?.goal ?? card?.core?.symptom ?? card?.core?.intent ?? card?.title ?? ''
}

/** The why a stored card presents, when it has one. */
function cardWhy(card) {
  return card?.brief?.why ?? card?.core?.intent ?? ''
}

/** Round one similarity for stable tool output. */
function rounded(value) {
  return Math.round(value * 100) / 100
}

/**
 * Find the card a new capture would duplicate.
 *
 * The baseline remains narrow: same workspace, an active card, at least one
 * shared touched file, and a similar title. `brief.goal` is an auxiliary signal:
 * it can catch the same task written with a different title, and it can veto a
 * title match when both goals are clearly unrelated. `brief.why` is explanation
 * only and never decides a duplicate on its own.
 *
 * @param cards - every stored card (`store.all()`).
 * @param candidate - `{ workspace, title, touchedFiles, goal?, why? }` of the new capture.
 * @param threshold - title similarity required, defaults to {@link DUPLICATE_TITLE_THRESHOLD}.
 * @returns the best matching card plus why, or undefined.
 */
export function findDuplicate(cards, candidate, threshold = DUPLICATE_TITLE_THRESHOLD) {
  const workspace = typeof candidate?.workspace === 'string' ? candidate.workspace : ''
  const touched = new Set((Array.isArray(candidate?.touchedFiles) ? candidate.touchedFiles : []).map(cleanPath).filter(Boolean))
  if (workspace === '' || touched.size === 0) return undefined
  const candidateTitle = typeof candidate?.title === 'string' ? candidate.title : ''
  const candidateGoal = typeof candidate?.goal === 'string' ? candidate.goal.trim() : ''
  const candidateWhy = typeof candidate?.why === 'string' ? candidate.why.trim() : ''
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

    const titleScore = titleSimilarity(card.title, candidateTitle)
    const goal = cardGoal(card)
    const why = cardWhy(card)
    const goalScore = candidateGoal !== '' && typeof goal === 'string' && goal.trim() !== '' ? titleSimilarity(goal, candidateGoal) : 0
    const whyScore = candidateWhy !== '' && typeof why === 'string' && why.trim() !== '' ? titleSimilarity(why, candidateWhy) : 0

    // A shared file plus a similar title is the legacy baseline. A similar goal
    // can also catch a differently titled duplicate. When both sides provide a
    // goal and they are clearly unrelated, do not let a generic title veto the
    // distinction; prefer a false negative over blocking a legitimate new task.
    if (candidateGoal !== '' && typeof goal === 'string' && goal.trim() !== '' && goalScore < DUPLICATE_GOAL_GUARD) continue
    const titleMatch = titleScore >= threshold
    const goalMatch = goalScore >= DUPLICATE_GOAL_THRESHOLD
    if (!titleMatch && !goalMatch) continue

    const similarity = Math.max(titleScore, goalScore)
    const matchReason = titleMatch && goalMatch
      ? 'shared file + similar title/goal'
      : goalMatch
        ? 'shared file + similar goal'
        : 'shared file + similar title'
    if (best === undefined || similarity > best.similarity) {
      best = {
        card,
        similarity: rounded(similarity),
        titleSimilarity: rounded(titleScore),
        goalSimilarity: rounded(goalScore),
        whySimilarity: rounded(whyScore),
        sharedFiles,
        matchReason,
      }
    }
  }
  return best
}
