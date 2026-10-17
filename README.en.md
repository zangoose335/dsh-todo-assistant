[中文](README.md) | **English**

# Todo Assistant (todo-assistant)

A cross-session workspace for side tasks: record the "not now, but don't forget" findings of a session as cards, and handle each one in its own session later.
Design notes: [docs/DESIGN.md](docs/DESIGN.md) (Chinese). Install: [Install](#install). License: [MIT](LICENSE).

What it does today:

- **Right-sidebar tab**: five views (Unfinished / To fix / To add / Done / All), card CRUD, detail expansion, workspace scope that follows the current session;
- **Capture**: `todo_add` (full schema + git coordinates + mustRead/park + the developer's verbatim request + path normalization), near-duplicate interception,
  `#DB … #/db` / `#MEMO … #/memo` markers, a "Record todo" paragraph panel on assistant replies, `#db` completion and a `#` reference picker in the composer;
- **Reading**: `todo_read` / `todo_note` / `todo_status` / `todo_list` / `todo_recall` (two-step original-log read-back);
- **Reminders**: a model-free path-relevance check every step, one reminder line in the next step, a "related" badge in the sidebar;
- **Handoff**: "Start task" opens a new session seeded with the card, or inserts it into the current composer; per-workspace rules travel with new sessions.

## Layout

| File | Purpose |
|---|---|
| `host.js` | Host entry: opens the `todo_assistant` storage domain, registers the `/api` routes and the tools |
| `domain.js` | Domain declaration (zod record schema) and pure logic: build, validate, patch, ids, L0 projection |
| `api.js` | Data operations and wire protocol: `list` / `create` / `patch` / `remove` / `note.add` / `note.remove` / `handle` / `rules.get` / `rules.set` |
| `tool.js` | The six tool definitions: `todo_add` / `todo_read` / `todo_note` / `todo_status` / `todo_list` / `todo_recall` |
| `git.js` | Code coordinates at capture time: `git rev-parse` via subprocess, `.git/HEAD` + refs as fallback |
| `detect.js` | Path-relevance detector: tool calls → paths → card match → reminder line / badge set |
| `recall.js` | L2 read-back: raw journal → manifest (seq / turn / role / first line / tokens) → one requested slice |
| `dedupe.js` | Near-duplicates: same workspace + shared touched file + title similarity |
| `marker.js` | `#DB … #/db` / `#MEMO … #/memo` extraction (skips code fences and inline code) |
| `client.js` | Browser half: sidebar tab type + card UI (no build step, baseline `react` only) |
| `scripts/verify-domain.mjs` | Headless verification: opens the domain with the installed storage stack and drives the whole wire protocol |

`domain.js` / `api.js` deliberately import no packages so the harness can drive them outside a profile; real dependencies are injected.

## `#DB` markers (typing is consent)

In any message:

```
#DB CSV export writes the header twice
the second line counts too
#/db
```

- Start marker `#DB` / `#db`, or the English `#MEMO` / `#memo` (same path); end marker `#/db` / `#/memo` may be omitted (to the end of the message) and the two end forms are interchangeable;
- **Fenced and inline code are skipped** — otherwise a message *explaining* this syntax would capture itself;
- The host scans `agent/inbox/claimed` (only human `user/message`, `source.kind === 'user'`), before prompt assembly;
- The next assembly injects a one-shot instruction: "the developer marked this; the marker is their consent, record it with `todo_add` and do not ask again";
- The card's developer request stores the marked block only, markers stripped.

The composer also completes `#db` into `#DB  #/DB` (and `#memo` into `#MEMO  #/MEMO`) with the caret between the two spaces, using only the published `useInput` + `inputActions`.

## Capture panel

Click "Record todo" on an assistant reply:

- paragraphs of that reply are listed, keyword/path hits preselected;
- **"Insert into composer"** puts the selection into the composer without sending — handy for several todos at once;
- **"Send to agent"** queues it as one user message; the agent then calls `todo_add`;
- the panel uses the official modal material (`--dsw-alias-bg-mask-1` + `--dsw-radius-panel` + `--dsw-elevation-prominent`).

## Developer request (verbatim)

When `todo_add` stores a card, the host copies the human message of the current turn (`source.kind === 'user'`, system injections skipped) into `request.text` verbatim (≤8000 chars, `truncated` beyond), without the model touching it.

- The sidebar detail shows it first; card meta shows "request" only when there are no touched files;
- `todo_read` includes it under "developer request (verbatim)";
- New-session seeds carry it as a section, so the handling agent sees your exact words.

## Workspace rules

A collapsible "Workspace rules" editor in the panel, stored per workspace (the `rules` table, keyed by workspace path):

- shown next to the workspace selector; the hint line appears only when expanded;
- when a card starts a new session, that card's workspace rules are prepended to the seed;
- clearing the text removes the rules; only applies to sessions the plugin itself creates.

## Completion loop

`todo_status(id, status)` is the only way the agent may change a status (`open` / `doing` / `done` / `dropped`), and its description requires explicit developer confirmation.
Seeds and the "insert into current composer" line both ask the agent to ask whether to mark the card done when the work is finished.

## Numbering

Every card has a short label `#3.2` next to its internal id (`td_x7k2`):

- **major = which session**: cards from the same root session share a major, allocated at that session's first card (global max + 1);
- **minor = which card in that session**: max minor of the group + 1;
- **subagents count as their root**: the chain is walked up via `header.parentSession`;
- **session-less cards** get a fresh major and `minor = 0`;
- numbers are computed once at creation and stored; deleting never renumbers;
- pre-label cards were migrated to `1.<old number>`; tool inputs accept `3.2`, `#3.2` and `td_x7k2`.

## Where data lives

- Domain name `todo_assistant` (`/^[a-z][a-z0-9_]*$/` is enforced by the storage layer);
- default `json` backend, so cards live in `~/.dsh/storages/todo_assistant.json`;
- `workspace` is the normalized workspace path; cards that belong nowhere live in `inbox`.

## Capture (`todo_add`)

A **form**, not a free-form summary:

- required: `title / kind / nextStep / touchedFiles / mustRead`; optional: `symptom / cause / intent / park / symbols`;
- limits enforced in the handler (`title` ≤40, `mustRead` ≤3 × ≤200, `park.label` ≤30, `park.why` ≤60); empty `touchedFiles` warns;
- the description requires **explicit consent**, forbids writing the main task's context, and forbids reading back compacted content on its own;
- `touchedFiles` and `symbols[].file` are normalized on write: absolute paths under the workspace become relative, `./` and trailing slashes are dropped, backslashes become slashes, duplicates removed; dedupe compares the same normalized form;
- `origin` (sessionId / turn / seqRange / cwd) and `code` (commit / branch) are filled by the host, never by the model.

## Reading

- `todo_list(workspace?, status?)`: index only (label / title / status / kind); defaults to this session's workspace and `open`+`doing`; `workspace: '*'` goes across;
- `todo_read(id, part?)`: the card body (core + mustRead text + park labels + coordinates + touched files + note count); `part: 'notes'`, `part: 'park:n'`;
- `todo_note(id, text, kind?)`: append-only, ≤300 chars, never rewrites the card.

## Detection and reminders

Model-free, all in the host:

- signals: `tool/call` arguments (`read`/`write`/`edit`/`read_image` `file_path`, `grep`/`glob` `path`), accumulated per turn;
- scope: cards created by this session that are `open`/`doing`;
- hit: an exact path, or ≥2 shared leading directory segments;
- at most one reminder per card per turn; injection through `ctx.systemPrompt.context`, consumed by the next assembly;
- the sidebar marks hits with `hit: true`.

Not wired (decided against in DESIGN §7): commit changes and symbol extraction — both are model-free too, but the data quality is poor (`code.symbols` is often empty, symbol names are common words) and they add local I/O to every step.

## Original-log read-back (`todo_recall`)

The most expensive read (text stays in context and is paid every step):

1. no `slice` → a manifest (seq / turn / role / first 40 chars / token estimate) for the card's captured range;
2. `slice: [from, to]` → that slice of text (2000 chars per message, 12000 total).

Data comes from `ctx.sessionQuery.readSession(id)` (the raw journal), so compacted history is still readable. The description forbids calling it without the developer's approval; first the manifest, then a chosen slice.

## Dedupe (`todo_add`)

Before storing: same workspace, `open`/`doing` cards, at least one identical `touchedFiles` entry **and** title similarity ≥ 0.55 (character-bigram Dice). A hit returns `status: 'duplicate'` with the candidate, so the agent asks; on agreement the facts go in via `todo_note`. Captures without `touchedFiles` skip dedupe.

## Handoff

- **Start task** → `remote.session.create` → `prompt` with the card's L1 seed (title, symptom/cause/intent, next step, touched files, must-read text, parked labels, capture commit, note count) → open the session;
- **Insert into composer** → one line into the current composer, never sent automatically;
- status changes use the radio on the card (done/reopen); `×` offers Delete / Archive / Cancel; kind sits bottom-left, `×` top-right.

## Client → Host channel

Exact Fetch routes on the `/api` prefix:

- host: `ctx.connection.fetch.register({ path: '/api/todo-assistant/<endpoint>', methods: ['POST'], requestBody: 'buffered', fetch })` — the Host/Origin fence and cookie auth happen before the handler;
- client: same-origin `fetch('api/todo-assistant/<endpoint>')`;
- not `@Remote` (built at TypeScript build time) and not `rpc.handle` (it reads the Connection service's own fiber, which lacks `webServer`).

Wire protocol (bare JSON):

```
POST /api/todo-assistant/<endpoint>
{ ...payload }
→ { "ok": true, "value": ... }
→ { "ok": false, "error": { "code": "todo/title-required", "message": "...", "details": {} } }
```

## Verification

Headless, no GUI and no profile:

```bash
node scripts/verify-domain.mjs
```

It opens the domain with the real installed `storage` / `storage-json` / `storage-domain`, drives every endpoint and tool, then closes and reopens to prove persistence.

## Install

Three ways; all go through `plugin_manager install_bundle` (approval required) and need a **dsh restart** afterwards.

**1. From a local checkout (development)** — keep the source out of `~/.dsh`:

```
plugin_manager install_bundle  target = <absolute path to this repo>
```

**2. Straight from GitHub** — no clone needed:

```
plugin_manager install_bundle  target = https://github.com/zangoose335/dsh-todo-assistant.git
```

Pin a commit with `#<commit>`, e.g. `...#77215f3`.

**3. From npm (once published)**:

```
plugin_manager install_bundle  target = todo-assistant@0.1.0
```

`install_bundle` needs pnpm on PATH. All three install the **same package name**, so remove the old bundle before switching.

**Restart dsh** to load the host half: the linked package's imports (`zod`, `@deepseek-ai/dsh-storage-domain`) depend on the profile resolution table built at startup. After that, every host change needs a restart; `client.js` changes only need a page refresh.

## Opening the tab

Right sidebar → the `+` (Add) picker → "Todo Assistant". The tab layout is remembered per session in localStorage.

## License

[MIT](LICENSE) © 2026 黑桃伍
