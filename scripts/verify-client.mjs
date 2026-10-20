/**
 * Load the browser half without a browser and check that it still registers
 * what the right sidebar needs.
 *
 * This is a smoke test, not a UI test: it proves the bundle parses, `apply`
 * does not throw, both tab types register (card + plan), both slot components
 * mount, and both locale dictionaries carry the plan keys. Visual layout and
 * click-through behavior still need the manual checklist in the card.
 *
 * Usage: node scripts/verify-client.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

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

/** Minimal React surface: the components are defined but never rendered. */
const React = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...next }
    }
  },
  Fragment: 'Fragment',
}

function require(name) {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

const registrations = { tabs: [], slots: [], locales: [] }
const styles = []
let loaded = null

global.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded = { id, exports: factory(require) }
    },
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  matchMedia: () => ({ matches: false }),
}
global.document = {
  createElement: (tag) => ({
    tag,
    dataset: {},
    textContent: '',
    remove() {
      const index = styles.indexOf(this)
      if (index >= 0) styles.splice(index, 1)
    },
  }),
  head: { appendChild: (element) => styles.push(element) },
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelectorAll: () => [],
}

const effects = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return () => {}
  },
  locale: {
    register(namespace, language, dictionary) {
      registrations.locales.push({ namespace, language, dictionary })
      return () => {}
    },
    bind: () => (key) => key,
    subscribe: () => () => {},
  },
  slots: {
    inject(name, fn) {
      fn()
    },
    register(options, component) {
      registrations.slots.push({ options, component })
    },
  },
  sidebarRightTabs: {
    register(options) {
      registrations.tabs.push(options)
      return () => {}
    },
  },
  remote: { session: {} },
  uiWorkspace: { openSession: () => {} },
}

async function main() {
  console.log(`client: ${CLIENT}`)
  await import(pathToFileURL(CLIENT).href)
  check('the module registers itself', loaded !== null && loaded.id === 'todo-assistant', JSON.stringify(loaded?.id))
  const exported = loaded?.exports ?? {}
  check('the module exports the sidebar tab dependency', Array.isArray(exported.inject) && exported.inject.includes('sidebarRightTabs'))
  check('apply is a function', typeof exported.apply === 'function')
  if (typeof exported.apply !== 'function') return
  let thrown = null
  try {
    exported.apply(ctx)
  } catch (error) {
    thrown = error
  }
  check('apply runs without throwing', thrown === null, thrown instanceof Error ? thrown.message : String(thrown))
  check('the style sheet is injected once', styles.length === 1 && styles[0].textContent.includes('.tplan-root'), `${styles.length}`)

  const tabIds = registrations.tabs.map((tab) => tab.id)
  checkEqual('both tab types are registered', tabIds, ['todo-assistant', 'todo-assistant-plan'])
  checkEqual(
    'the plan tab is an extension with its own guide entry',
    [registrations.tabs[1]?.priority, registrations.tabs[1]?.guide?.[0]?.order],
    ['extension', 41],
  )
  const slotKeys = registrations.slots
    .filter((slot) => slot.options.name === 'sidebar.right.pane.tab')
    .map((slot) => slot.options.key)
  checkEqual('both tab slots are mounted', slotKeys, ['todo-assistant', 'todo-assistant-plan'])

  const zh = registrations.locales.find((entry) => entry.language === 'zh')
  const en = registrations.locales.find((entry) => entry.language === 'en')
  check('the Chinese dictionary carries the plan keys', zh !== undefined && zh.dictionary['planTab.title'] === '计划')
  check(
    'the English dictionary carries the plan keys',
    en !== undefined && en.dictionary['planTab.title'] === 'Plan',
  )
  check(
    'both dictionaries carry the handoff seed keys',
    zh?.dictionary['plan.seed.header'] !== undefined && en?.dictionary['plan.seed.header'] !== undefined,
  )
  check(
    'the plan page does not reuse the card page id',
    registrations.tabs[0].id !== registrations.tabs[1].id && registrations.slots[0].options.key !== registrations.slots[1].options.key,
  )

  console.log(`\n${checks - failures}/${checks} checks passed`)
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
