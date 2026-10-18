[中文](README.md) | **English**

# Todo Assistant

**Capture side tasks from a DSH session, keep the context that matters,
and hand the task off when you're ready.**

While working on a feature, you may spot an unrelated bug, realize a
companion feature is also needed, or discover something that should be
handled later. You don't want to interrupt the main task---but you also
don't want to investigate everything again or explain the situation to
an AI from scratch later.

Todo Assistant lets you capture that work as a card. The AI organizes
the relevant information, and you can revisit the card, add notes, or
bring it into a new session or the current composer.

It is not just a list of things left to do. It helps preserve **why a
task matters, what is already known, and what to do next**.

## When is it useful?

### You spot a bug but can't fix it now

You're in the middle of a large feature and notice a problem elsewhere.
Capture the issue and relevant clues, finish the main task, and handle
the bug separately later.

### You discover a companion feature

While implementing something, you realize it also needs a setting, an
editing action, or a supporting workflow. Record the idea without
derailing the current task, then return to it later.

### You want to hand a task to another session

Start a new session with the card as its opening context, or insert a
handoff prompt into the current composer and decide when to send it.

### You want to avoid repeated investigation

Cards can preserve the developer's original request, task-specific
details, file paths, next steps, must-read information, and follow-up
notes. When necessary, you can inspect an index of the original session
and read only selected excerpts instead of loading the entire history up
front.

## How it works

-   **Capture now, handle later.** Recording a side task does not
    require leaving the main task immediately.
-   **Keep relevant context.** A card focuses on the captured task
    rather than copying the entire main-task conversation
    indiscriminately.
-   **Read original context on demand.** You can inspect a manifest and
    choose specific excerpts. This is more expensive than reading a
    card, so it is not treated like a routine reminder.
-   **You control the handoff.** Start a new session or insert a prompt
    into the current composer. Insertion never sends automatically.
-   **Creation requires consent.** The AI must not create cards on its
    own. Using a marker is explicit consent to capture.
-   **Keep reminders lightweight.** The plugin compares file paths
    accessed in the current session with unfinished cards created in
    that session, without a model call on every step.

## Quick start

### 1. Install

Run this in DSH:

``` text
plugin_manager install_bundle  target = https://github.com/zangoose335/dsh-todo-assistant.git
```

Installation requires approval and a DSH restart. You can also install
from a local checkout or pin a Git commit. See
[Installation](#installation) below.

### 2. Open the sidebar

In the right sidebar, click `+` and select **Todo Assistant**.

Cards can be filtered by workspace or viewed in the global Inbox. The
sidebar includes Unfinished, To fix, To add, Done, and All views.

### 3. Capture a side task

You can ask the AI to record a task and explicitly approve its creation,
or use a marker:

``` text
#MEMO Add the ability to edit a meeting title after the meeting is recorded. Finish the current main feature first, then implement title editing and verify that the updated title is saved and displayed correctly.
#/MEMO
```

`#DB` and `#MEMO` are equivalent capture markers; they do **not**
represent different task types. `DB` comes from the pinyin initials for
the Chinese word for "todo," while `MEMO` is an alternative that may be
more familiar to international users. The AI should infer whether the
captured item is a bug fix, a feature idea, or another kind of task from
its content.

Marker rules:

-   `#db`, `#DB`, `#memo`, and `#MEMO` are case-insensitive.
-   Use `#DB … #/DB` or `#MEMO … #/MEMO` to delimit the text. The
    closing marker is optional; if omitted, capture continues to the end
    of the message.
-   Markers inside fenced or inline code are ignored.
-   A marker is explicit consent to create the card, so the AI does not
    need to ask again.
-   Without a marker, the AI must still obtain the developer's explicit
    consent before creating a card.

The composer provides lightweight completion for `#db` and `#memo`. A
"Record todo" panel on assistant replies can also help select paragraphs
and send them through the capture flow.

## What's in a card?

A card organizes the information needed to resume the task, such as:

-   A title and the task type inferred by the AI;
-   Symptoms, cause, or intent, where relevant;
-   The next step;
-   Related files and code coordinates;
-   Concise must-read information;
-   The developer's original request;
-   Follow-up notes;
-   Git commit and branch information at capture time, when available.

The Host stores the developer's original request directly from the user
message rather than relying on the AI to paraphrase it. This makes it
easier to spot and correct misunderstandings.

## Handoff and follow-through

From a card, you can:

-   **Start in a new session:** create a new session seeded with the
    card's context.
-   **Insert into the current composer:** prefill a handoff prompt
    without sending it automatically.

When the work is finished, the AI should ask whether you want to mark
the card complete. The status is updated only after you confirm.

You can also append notes to preserve new evidence, progress, or facts
without silently rewriting the original card.

## Context retrieval and reminders

### Layered retrieval

-   **Index:** quickly see titles, statuses, and task types.
-   **Card:** read the task details, next step, must-read text, files,
    and notes.
-   **Original session:** inspect a manifest of available messages, then
    retrieve selected excerpts.

Reading original session text can consume significant tokens. The tool
instructions require the AI to ask for developer approval before
inspecting the manifest and reading selected excerpts. Cards created
manually without an original session range may not support read-back.

### Relevance reminders

The plugin collects selected file paths from tool calls in the current
session and compares them with unfinished cards created by that session.
An exact path match or a sufficiently long shared directory prefix can
trigger a "related" badge and a reminder in a subsequent step.

This is a **lightweight path signal**, not semantic task understanding,
and it cannot detect every relevant change. Its purpose is to prompt the
AI to add useful new evidence to a card when appropriate.

## More features

-   Workspace-scoped cards and a global Inbox;
-   Near-duplicate detection;
-   Short card labels such as `#3.2` for referencing cards in
    conversation;
-   Per-workspace rules, included in new sessions created by the plugin;
-   Tools for reading cards, appending notes, updating status, listing
    tasks, and retrieving original-session excerpts.

## Installation

All installation methods use `plugin_manager install_bundle` and require
approval.

**From GitHub:**

``` text
plugin_manager install_bundle  target = https://github.com/zangoose335/dsh-todo-assistant.git
```

**From a local checkout:**

``` text
plugin_manager install_bundle  target = <absolute path to this repository>
```

**Pin a commit:**

``` text
plugin_manager install_bundle  target = https://github.com/zangoose335/dsh-todo-assistant.git#<commit>
```

If published to npm in the future, it can also be installed by package
name and version. `install_bundle` requires `pnpm` on PATH.

Restart DSH after installing or updating Host-side code. Changes limited
to `client.js` usually only require a page refresh.

After installation, open the right sidebar's `+` menu and select **Todo
Assistant**.

## Development and design

The repository includes implementation and verification code. For
details about the data model, tool definitions, marker parsing, path
reminders, original-session read-back, and Host/Client communication,
see:

-   [`docs/DESIGN.md`](docs/DESIGN.md): design principles and
    implementation decisions
-   [`scripts/verify-domain.mjs`](scripts/verify-domain.mjs): headless
    verification script

## License

[MIT](LICENSE) © 2026 黑桃伍
