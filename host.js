/**
 * 待办助理 (todo-assistant) — host half.
 *
 * Owns the durable `todo_assistant` storage domain and the browser write channel
 * the right-sidebar tab talks to. See docs/DESIGN.md.
 *
 * Wire choice (recorded from the §10 verification):
 * - `@Remote` namespaces are generated at build time from TypeScript decorators
 *   and mounted by the application's own `ctx.remote` assembly, so a plain-JS
 *   plugin cannot declare one.
 * - `ctx.connection.rpc.handle()` is not usable from a plugin either: while
 *   mounting the route it reads `webServer` off the Connection service's own
 *   fiber, which injects only `webRuntime`, so it throws
 *   "cannot get property webServer without inject".
 * - `ctx.connection.fetch.register()` is the supported path: exact routes live on
 *   the already-authenticated `/api` channel (Host/Origin fence + browser cookie
 *   are applied before dispatch), and the handler is a plain Fetch handler.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { CHANNEL, createApi, createStore } from './api.js'
import { createDetector } from './detect.js'
import { createMarkerQueue, messageText } from './marker.js'
import { INBOX, createTodoSpec } from './domain.js'
import { readCodeCoordinates } from './git.js'
import { recallApprovalDecision } from './approval.js'
import { createRecall } from './recall.js'
import {
  createTodoAddTool,
  createTodoListTool,
  createTodoNoteTool,
  createTodoReadTool,
  createTodoRecallTool,
  createTodoStatusTool,
} from './tool.js'

/** Diagnostics name of this plugin. */
export const name = 'todo-assistant'

/** Durable domain facility this plugin cannot run without. */
export const inject = ['storageDomain']

/** Absolute URL prefix of the browser endpoints, below Connection's `/api` channel. */
export const ROUTE_PREFIX = `/api${CHANNEL}`

/** Declared once at module load; `apply` opens it and owns the handle. */
const spec = createTodoSpec({ z, defineDomain, domainTable })

/**
 * Host entry: open the domain, then mount one exact Fetch route per endpoint.
 *
 * @param ctx - host context.
 */
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => async () => {
    await domain.close()
  }, 'todo-assistant: storage domain')

  const store = createStore(domain)
  const migrated = await store.migrateLabels()
  if (migrated > 0) ctx.logger?.info?.(`todo-assistant: labelled ${migrated} legacy card(s)`)

  /**
   * Root session of a subagent's session: cards from a child belong to its root,
   * so "same conversation" grouping survives delegation.
   */
  const rootOfSession = (session) => {
    // Optional service: `ctx.get` never throws, unlike a property read on an
    // un-injected service.
    const agents = ctx.get('agents')
    let current = session
    const seen = new Set()
    while (current !== undefined && typeof current?.header?.parentSession === 'string' && !seen.has(current.id)) {
      seen.add(current.id)
      const parent = agents?.get(current.header.parentSession)
      if (parent === undefined) return current.header.parentSession
      current = parent.session
    }
    return typeof current?.id === 'string' ? current.id : ''
  }
  const resolveRoot = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    const agent = ctx.get('agents')?.get(sessionId)
    return agent === undefined ? sessionId : rootOfSession(agent.session)
  }

  const detector = createDetector({ store })
  const markers = createMarkerQueue()
  const api = createApi({
    store,
    hitIds: (sessionId) => detector.hitIds(sessionId),
    resolveRoot,
    resolveSessionWorkspace: async (sessionId) => {
      const agent = ctx.get('agents')?.get(sessionId)
      const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
      return resolveWorkspace(cwd)
    },
  })

  ctx.on('session/event', (session, event) => detector.onSessionEvent(session, event))
  // `#DB … #/db` must reach the step that ANSWERS the message, and the loop
  // appends `user/message` only after that step's prompt assembly — so scan the
  // inbox claim, which happens before assembly.
  ctx.on('agent/inbox/claimed', (payload) => {
    const message = payload?.message
    if (message?.source?.kind !== 'user') return
    const sessionId = typeof payload?.agent?.id === 'string' ? payload.agent.id : ''
    if (sessionId === '') return
    markers.onUserMessage(sessionId, messageText(message), typeof message.id === 'string' ? message.id : '')
  })
  ctx.on('session/disposed', (session) => {
    detector.forget(session?.id)
    markers.forget(session?.id)
  })

  // One ordered runtime-context line, consumed by the assembly that follows a
  // step whose tool calls matched a card this session created.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.context({
          name: 'todo-assistant/reminder',
          order: 130,
          text: (assembly) => {
            const agent = assembly?.agent ?? assembly?.scope
            const sessionId =
              typeof agent?.id === 'string'
                ? agent.id
                : typeof agent?.session?.id === 'string'
                  ? agent.session.id
                  : ''
            return sessionId === '' ? '' : detector.takeReminder(sessionId)
          },
        }),
      'todo-assistant: reminder context',
    )

    // One-shot instruction for marked blocks; ordered just before the reminder.
    promptCtx.systemPrompt.context({
      name: 'todo-assistant/marker',
      order: 129,
      text: (assembly) => {
        const agent = assembly?.agent ?? assembly?.scope
        const sessionId =
          typeof agent?.id === 'string' ? agent.id : typeof agent?.session?.id === 'string' ? agent.session.id : ''
        if (sessionId === '') return ''
        const blocks = markers.take(sessionId)
        if (blocks.length === 0) return ''
        const lines = [
          'The developer marked part of their message as a todo (#DB … #/db, or the English #MEMO … #/memo). That marker is their explicit consent: record the marked text with todo_add and keep their wording; do not ask again.',
        ]
        for (const block of blocks) lines.push(block)
        return lines.join('\n\n')
      },
    })
  })

  /** Map a session cwd to the canonical workspace key the UI filters by. */
  const resolveWorkspace = async (cwd) => {
    if (cwd === '') return INBOX
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return cwd
    try {
      const workspace = await registry.resolveByPath(cwd)
      return workspace === undefined ? cwd : workspace.path
    } catch {
      return cwd
    }
  }

  // Session history is read through the query service; the token meter only
  // improves the manifest estimate and may be absent.
  const recall = createRecall({
    readSession: (sessionId) => {
      const query = ctx.get('sessionQuery')
      if (query === undefined) throw new Error('sessionQuery is not mounted in this composition')
      return query.readSession(sessionId)
    },
    readSurface: (sessionId) => {
      const query = ctx.get('sessionQuery')
      if (query === undefined || typeof query.readSurface !== 'function') {
        throw new Error('sessionQuery.readSurface is not mounted in this composition')
      }
      return query.readSurface(sessionId)
    },
    estimateTokens: (message) => ctx.get('tokenMeter')?.estimateMessage(message),
  })

  const tools = [
    createTodoAddTool({
      defineTool,
      store,
      readGit: (cwd) => readCodeCoordinates(cwd, ctx.get('subprocess')),
      resolveWorkspace,
      resolveRootSession: rootOfSession,
    }),
    createTodoReadTool({ defineTool, store }),
    createTodoNoteTool({ defineTool, store }),
    createTodoListTool({ defineTool, store, resolveWorkspace }),
    createTodoRecallTool({ defineTool, store, recall }),
    createTodoStatusTool({ defineTool, store }),
  ]

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      // Every recall call asks; ToolRuntime resolves the ask through the
      // approval service (allowed-once only) and fails closed otherwise.
      const disposeApproval = toolCtx.on('tools/pre-execute', (exec, next) => {
        const decision = recallApprovalDecision(exec)
        return decision === undefined ? next() : decision
      })
      const disposers = tools.map((definition) => toolCtx.tools.register(definition))
      return () => {
        disposeApproval()
        for (const dispose of disposers) dispose()
      }
    }, 'todo-assistant: todo tools')
  })

  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const disposers = api.endpoints.map((endpoint) =>
        connCtx.connection.fetch.register({
          path: `${ROUTE_PREFIX}/${endpoint}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let payload = {}
            try {
              payload = await request.json()
            } catch {
              // An empty body is a valid empty payload; the endpoint validates fields.
            }
            return Response.json(await api.handle(endpoint, payload))
          },
        }),
      )
      return async () => {
        for (const dispose of disposers) await dispose()
      }
    }, 'todo-assistant: browser endpoints')
  })

  ctx.logger?.info?.(`todo-assistant: domain ready at ${ROUTE_PREFIX} (${api.endpoints.join(', ')})`)
}
