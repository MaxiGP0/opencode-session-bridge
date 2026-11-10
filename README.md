# opencode-session-bridge

[![CI](https://github.com/MaxiGP0/opencode-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/MaxiGP0/opencode-session-bridge/actions/workflows/ci.yml)

[English](README.md) | [Español](README.es.md)

An [OpenCode](https://opencode.ai) v2 plugin that lets the agent open, message,
monitor, read, wait for, update, archive, and safely remove other OpenCode
sessions.

Instead of delegating to a child subagent that disappears into the current turn,
this plugin creates **real, independent sessions** that appear in the normal
session list and can be inspected or resumed later.

## Features

- Create or reuse a session and send its first prompt.
- Send follow-up messages to any existing session, with `steer` or `queue`
  delivery.
- Wait for the **exact turn** admitted by `session.prompt`, anchored by the
  message ID returned by the server.
- Wait for a specific queued or background turn with `wait({ messageID })`.
- Event-driven waiting (`session.wait`, `session.idle` / `session.status`, and
  durable `session.execution.*` / `session.retry.scheduled` events) with a
  bounded polling fallback, a short settle phase when the transcript lags
  behind the terminal event, and automatic re-arming when an event belongs to a
  previous turn.
- Live provider retry state: `status` and `wait` report `retrying` with the
  attempt, reason, and the **absolute** next retry timestamp. Content shows the
  remaining seconds; `output.retry` also exposes `retryAt` and `retryInMs`.
- Background queue tracking: FIFO per session with `queuedCount`,
  `queuedMessageIDs`, a TTL, a size limit, and cleanup on `interrupt`/`remove`.
  `interrupt({ resume: true })` preserves the local queue.
- Idempotent retries with an optional `messageID` and `open({ sessionID })`;
  the plugin persists a per-directory `messageID -> sessionID` mapping and
  serializes concurrent `open` calls with the same key. Each caller runs its
  own `permission.assert`, and a different signature for the same key is a
  conflict instead of a silent reuse.
- Idempotent `send`: repeating the same `messageID` and signature does not
  reapply model/agent switches or send a second prompt.
- Output is bounded globally by `maxOutputTotalChars`, not only field by field.
- Untrusted metadata (IDs, titles, permission fields, tool names, file labels,
  and errors in `content`) is reduced to one line; ANSI and newline injection
  cannot create fake status lines.
- Compact a session (`sessions.compact`, opt-in) and inspect plugin
  capabilities (`sessions.diagnostics`).
- Check whether a session is running, queued, retrying, or idle using
  timestamps, relevant transcript messages, and the live session status.
- Read the transcript: user messages, assistant text, tools, files, shell,
  synthetic, compaction, and optional reasoning.
- Read incrementally with `afterMessageID` + `limit` and continue with
  `nextAfterMessageID`.
- Inspect and answer pending permission requests, with conservative defaults.
- Route dangerous actions through the host's `permission.assert` rules.
- Rename and archive sessions without deleting them.
- Delete sessions only with an explicit opt-in and `confirm: true`; foreign
  sessions also require `allowRemoveForeignSessions: true`.
- Restrict `interrupt`/`update`/`remove` to sessions created or adopted by this
  plugin unless the corresponding foreign-session opt-in is enabled.
- Structured `output` values for Code Mode, plus readable `content` that never
  translates assistant, user, or tool content.
- Configurable output budgets that preserve session, state, message IDs,
  permissions, and errors, with `textTruncated`, `textLength`,
  `pendingTotal`, and `pendingTruncated` flags.
- Input size limits for prompts, titles, searches, permission rules, and
  metadata.
- A per-directory LRU/TTL registry for owned sessions and open mappings.
- List sessions with cursor pagination and filters.

## Requirements

- OpenCode v2 (tested with `2.2.5`).
- Node.js 24+ for development and tests (the plugin itself runs inside
  OpenCode).
- A GitHub account only if you want to install from GitHub.

## Install

### From GitHub

```sh
opencode plugin add github:MaxiGP0/opencode-session-bridge
```

### Manual

Copy this directory to one of the plugin locations:

| Scope | Directory |
| --- | --- |
| Global | `~/.config/opencode/plugins/session-bridge/` |
| Project | `.opencode/plugins/session-bridge/` |

The plugin entry point is `index.ts`; pure helpers live in `src/`. OpenCode
reloads plugins from watched configuration directories automatically. If the
tools do not appear, run `/reload` in the TUI.

## Tools

All tools live in the `sessions` namespace.

| Tool | Description |
| --- | --- |
| `sessions.open` | Create or reuse a session, send a prompt, and (by default) wait for the exact turn. |
| `sessions.send` | Send a message to an existing session. Supports `steer`, `queue`, model/agent switches, and `messageID`. |
| `sessions.status` | Immediate snapshot: running/queued/retrying/idle/permission, outcome, last text, recent tools, pending permissions, and message IDs. |
| `sessions.permissions` | List pending permission requests for a session. |
| `sessions.reply` | Approve or reject a pending permission request (`once`, `always`, or `reject`), subject to security opt-ins. |
| `sessions.read` | Read a bounded transcript, including tools and optional tool output/reasoning. Supports incremental pagination. |
| `sessions.wait` | Wait for the current, last started, or explicit `messageID` turn. Returns `state: "permission"` as soon as a request is pending. |
| `sessions.interrupt` | Interrupt the running turn. `resume: true` preserves the local queue. |
| `sessions.compact` | Compact a session's context. Disabled by default (`allowCompact`). |
| `sessions.diagnostics` | Read-only capabilities, registry/live/queue sizes, redacted options, and last live event time. |
| `sessions.list` | List sessions with cursor pagination, filters, and a timestamp snapshot. |
| `sessions.update` | Rename, archive/unarchive, change metadata, or adjust permission rules without deleting. |
| `sessions.remove` | Delete a session. Destructive; requires opt-in, `confirm: true`, and ownership (or `allowRemoveForeignSessions`). |
| `sessions.language` | Get or set the output language (`en` by default, `es` available). |
| `sessions.worktrees` | `create`/`list`/`remove` project worktrees through `ctx.worktree`. Opt-in (`allowWorktreeManagement`); removal needs `confirm: true` and only touches worktrees created by this plugin. |
| `sessions.waitAny` | Wait for one or all sessions (`mode: "any" \| "all"`). Returns partial results on timeout/abort, returns a pending permission quickly, and detects background work from the `experimental.idle` hook when available. |
| `sessions.waitAll` | Alias of `waitAny` with `mode: "all"`. |
| `sessions.race` | Run one prompt in 2–8 candidates (worktrees by default), snapshot commits/patches, optionally run setup/test/teardown serially, and return bounded diffs, tests, and verification flags. Never applies anything. |
| `sessions.bestOf` | Same as `race` plus a heuristic `recommended` candidate and `rankingReasons`. Tests passed first, then smaller diff, then faster. |
| `sessions.applyCandidate` | Apply a race candidate with `apply` (patch) or `cherry-pick`. Dry-run by default; requires `allowApplyCandidates`, `confirm: true`, a clean target, a backup branch, and optional integration verification. |
| `sessions.raceStatus` | Inspect one race or all registered races (candidates, commits/patches, tests, worktrees, cleanup). Read-only. |
| `sessions.raceList` | Compact list of registered races. Read-only. |
| `sessions.raceCleanup` | Remove the worktrees created by a race. Requires `allowWorktreeManagement`, `confirm: true`, and `force: true` for dirty worktrees. Branches are kept. |

`open`, `send`, and `wait` return a compact report containing:

- the prompt that was sent;
- the admitted message ID (`Message ID`);
- the final state (`idle`, `running`, `queued`, `retrying`, `timeout`,
  `aborted`, `permission`, or `error`);
- the outcome and the assistant's final text;
- the tools that were executed, with an omission summary when the budget is
  exceeded;
- any provider/session error and the last message ID;
- pending permission IDs and a reply hint when the turn is blocked.

`delivery: "queue"` does not return until the **queued prompt's own turn**
finishes. An earlier idle from the current turn is not accepted as the result.

Every tool also returns an `output` object. In Code Mode the call resolves to
that object; in text mode the model still receives `content`, whose format has
not changed. The chaining tools expose at least:

| Tool | Useful output fields |
| --- | --- |
| `open`, `send`, `wait` | `sessionID`, `title`, `messageID`, `state`, `outcome`, `lastMessageID`, `text`, `textLength`, `textTruncated`, `elapsedMs`, `fetchCount`, `queued`, `retry` (`next`, `retryAt`, `retryInMs`), `pendingPermissions`, `pendingTotal`, `pendingTruncated`, `permissionCheckedAt`, `error`, `errorTruncated`, `reused`, `alreadySent` |
| `status` | `sessionID`, `state`, `running`, `queued`, `queuedCount`, `queuedMessageIDs`, `queuedTruncated`, `nextQueuedMessageID`, `lastOutcome`, `lastError`, `retry`, `promptMessageID`, `lastMessageID`, `text`, `textLength`, `textTruncated`, `tools`, `toolsTruncated`, `pendingPermissions`, `pendingTotal`, `pendingTruncated`, `contextError`, `permissionError`, `transcriptAvailable`, `permissionsAvailable`, `liveStale`, `statusAt` |
| `read` | `sessionID`, `lastMessageID`, `hasMore`, `nextAfterMessageID`, `truncated`, `count`, `partial`, `partialMessageID`, `state` |
| `list` | `sessions[]`, `nextCursor`, `count`, `sessionsTruncated`, `state` |
| `permissions` | `sessionID`, `pending[]`, `pendingTotal`, `pendingTruncated`, `hasMore`, `state` |

`output` is bounded independently of `content`: text is capped by
`maxTextChars`, titles by `maxTitleChars`, errors by `maxErrorChars`, pending
permission arrays by `maxPermissions` (or the tool's `limit`), and list results
by `limit`. In addition, `JSON.stringify(output)` is capped by
`maxOutputTotalChars`; arrays are trimmed and set `toolsTruncated`,
`queuedTruncated`, `sessionsTruncated`, or `pendingTruncated` as needed.
Critical fields (`sessionID`, `state`, message IDs, permission IDs, totals, and
error) are always kept. Every validation or API error returns
`{ state: "error", error, sessionID? }`; host permission denials still surface
as tool errors instead of successful output. Successful `read`, `list`, and
`permissions` return `state: "ok"`.

Use `created.sessionID`, not `created.id`:

```ts
const created = await tools.sessions.open({ prompt: "Review the auth module." })
if (created.state === "idle") {
  const status = await tools.sessions.status({ sessionID: created.sessionID })
  console.log(status.text)
}
```

## Orchestration: worktrees, races, and safe apply

O-0 to O-5 add an opt-in orchestration layer. Nothing is applied, committed, or
pushed automatically.

### Ownership and workers

- `open({ directory })` creates the session in an existing project directory or
  a registered worktree. The directory is validated with `realpath`, rejects
  `..`, symlink escapes, relative paths, and directories outside the project
  (unless they are opt-in git worktrees), and is case-insensitive on Windows.
- After `session.create`, the plugin reads `session.get()` again and aborts plus
  removes the session if the host put it in another directory.
- The plugin relies on the host to load the worktree's `.opencode`, agents,
  skills, and instructions for `session.create({ location })`. It does not copy
  or symlink configuration itself. If the host does not discover it for a
  sibling worktree, use the host's worktree strategy or copy/symlink the config
  explicitly.
- `copy`/`clone` worktree strategies are host-controlled. The plugin records the
  strategy and uses patch/fetch for apply, but it cannot enforce the host's
  copy exclusions (`node_modules`, `dist`, secrets, etc.). Prefer the `worktree`
  strategy when available.
- The caller that opens a session becomes its owner (`ownerSessionID`). A
  worker in a worktree can be managed from `main` with `status`, `read`, `wait`,
  `reply`, `interrupt`, and `update`.
- A session created with `runID` or in another directory is a worker. Workers
  are denied every `sessions.*` orchestration tool by default. The worker
  permission preset also denies `session_bridge.*`, `git push`, `git worktree`,
  `git checkout`/`switch`, `--force`, and `external_directory`. Enable
  `allowWorkerOrchestration: true` only for trusted workers.
- `open({ messageID })` includes the target directory in the mapping and the
  in-flight key. The same `messageID` in another directory is a conflict, not a
  silent reuse.

### Worktrees

```ts
const created = await tools.sessions.worktrees({
  action: "create",
  count: 3,
  base: "HEAD",
  runID: "run_auth",
})
const listed = await tools.sessions.worktrees({ action: "list" })
```

`create` uses `ctx.worktree.create` (never a shell fallback) when
`allowWorktreeManagement: true` and handles partial creation with rollback.
`list` reports directory, branch, base, strategy, dirty state, and associated
sessions. `remove` only touches tracked worktrees, refuses the project root,
keeps dirty or active worktrees unless `force: true` plus `confirm: true`, and
archives associated sessions first by default. Branches are never deleted.

### Race and bestOf

```ts
const run = await tools.sessions.bestOf({
  prompt: "Implement and verify the auth fix.",
  count: 3,
  mode: "worktrees",        // requires ctx.worktree
  base: "HEAD",
  testCommand: "npm test",  // requires allowTestCommands
  keepWorktrees: true,
  timeoutMs: 600_000,
})
// run.candidates[]: sessionID, directory, commit/patch, diffStats, files,
// tests, verification, applyStrategy; run.recommended is heuristic.
```

- `race`/`bestOf` create unique `messageID`s (`${raceID}:${i}`), snapshot the
  candidate worktree (a local commit when safe, otherwise a patch that includes
  untracked files), and never use the truncated display diff for apply.
- Binaries, renames, mode changes, submodules, and LFS are detected. A candidate
  whose patch cannot represent them is marked `unsupported` and is not applied
  blindly.
- Test/CI changes and disabled tests (`.skip`, `.only`, `xit`, `fit`,
  `--passWithNoTests`, …) set `testFilesChanged`, `ciFilesChanged`,
  `skippedTests`, and `verification: "flagged"`. With `allowTestChanges: false`
  such a candidate is never recommended.
- E2E commands use `execFile` without a shell, an allowlisted environment,
  redacted output, timeouts, bounded buffers, and Windows process-tree kill.
  Tests run serially per candidate. If a command needs secrets or services that
  do not exist locally, the result is `tests: { skipped: true, reason }`; the
  plugin never claims the E2E passed.
- `same-directory` mode is for comparing answers, not for safe apply: the
  candidates share one working tree, so snapshots are marked incomplete and
  `applyStrategy` is `none`.
- `waitAny`/`waitAll` detect background shells/subagents through the
  experimental `experimental.idle` hook when the plugin instance that owns the
  session receives it. For a worker in another location, the orchestrator may
  not see that background hook (it still sees the model idle), so treat that
  signal as best effort.
- `bestOf` is a heuristic recommendation, not an absolute winner. If no
  candidate has passing, trusted tests, `recommended` is `null`. Candidate
  output also includes bounded `cost`/`tokens` when the host reports them.

### Apply

```ts
await tools.sessions.applyCandidate({
  raceID: run.raceID,
  candidateID: run.recommended!,
  strategy: "cherry-pick",  // or "apply" for a patch
  verifyCommand: "npm test",
  dryRun: false,            // dryRun defaults to true
  commit: true,
  confirm: true,            // + allowApplyCandidates + permission.assert
})
```

`applyCandidate` requires a registered race, `allowApplyCandidates`, and
`confirm: true`. It refuses a dirty target, an in-progress merge/rebase/
cherry-pick, a base that is not an ancestor, an incomplete patch, or a
cherry-pick without a commit. It verifies in an integration worktree first when
`verifyCommand` or `dryRun` is used, creates a backup branch before touching the
target, is idempotent (`alreadyApplied`), and rolls back on failure. `commit`
and `push` are separate opt-ins. Push never uses force and requires
`allowPushCandidates`; a rejected push is reported and left for a manual
rebase/retest. The plugin does not rebase automatically.

`raceStatus`, `raceList`, and `raceCleanup` recover and clean orphaned races.
`diagnostics` reports the last race, worktree counts, stream health, storage
availability, and the last cleanup.

**No-goals:** no automatic candidate selection with an LLM, no automatic apply,
no automatic commit or push, no shell fallback for worktrees, no guarantee that
secret-like environment variables or services exist locally, and no attempt to
delete branches with unmerged commits.

## Usage

Talk to the agent in natural language:

- “Open a new session and say hello.”
- “Send this task to session `ses_...` with queue delivery, wait for it, and tell
  me what it did.”
- “Is that session still running? Read its transcript.”
- “Rename it, archive it, and do not delete it.”
- “Interrupt it.”

Or call the tools directly from a plugin or agent:

```ts
const created = await tools.sessions.open({
  prompt: "Review the authentication module and report issues.",
  title: "Auth review",
  wait: false,
  messageID: "msg_auth_review_1", // optional idempotency key
})

const status = await tools.sessions.status({
  sessionID: created.sessionID,
  recent: 8,
  verbose: true,
})

const result = await tools.sessions.wait({
  sessionID: created.sessionID,
  messageID: created.messageID, // optional: exact turn
  timeoutMs: 120_000,
})

const transcript = await tools.sessions.read({
  sessionID: created.sessionID,
  limit: 30,
  includeTools: true,
  includeToolOutput: true,
  includeReasoning: false,
})
```

### Queue delivery and idempotency

```ts
const sent = await tools.sessions.send({
  sessionID: "ses_...",
  prompt: "Run the test suite after the current task.",
  delivery: "queue",
  wait: false,
  messageID: "msg_test_suite_1",
})

// Later, wait for exactly this queued turn.
const result = await tools.sessions.wait({
  sessionID: sent.sessionID,
  messageID: sent.messageID,
  timeoutMs: 120_000,
})
```

Reusing the same `messageID` does not create a second message. The wait anchor
is the ID returned by `session.prompt`, so the call returns only when that
specific queued turn has finished. Without `messageID`, `wait` uses the first
queued prompt tracked for that session (FIFO), then falls back to the last user
message for compatibility.

Background queue state is FIFO per session. `status` reports
`queuedCount`, `queuedMessageIDs`, and `nextQueuedMessageID`; the queue entries
expire after `queueTtlMs`, are capped by `maxQueuedPrompts`, and are cleared by
`interrupt({ resume: false })` and `remove`. `interrupt({ resume: true })`
keeps them because the server resumes the pending messages.

`open` is idempotent in two ways:

- Pass `sessionID` to create that specific ID or reuse an existing session.
  A successful `open({ sessionID })` adopts the session, so later
  `interrupt`/`update` calls are allowed without a foreign-session opt-in.
- Reuse the same `messageID`: the plugin persists a per-directory
  `messageID -> sessionID` mapping for 7 days (up to 500 entries) and reuses
  the mapped session. Concurrent `open` calls with the same `messageID` or
  `sessionID` share one operation, so only one session and one prompt are
  created.

If the prompt fails after the session was created, the error output includes the
`sessionID` so a retry does not leave an orphan session behind.

`send` is idempotent for side effects too: reusing the same `messageID` with the
same signature skips the prompt and any model/agent switches, and returns
`alreadySent: true` / `reused: true`. Reusing the key with a different prompt,
agent, model, or delivery is a conflict. Switches are only applied when the
session's current model/agent differs from the target.

Concurrent `open` callers with the same `messageID`/`sessionID` and signature
share the admission, but each caller still runs its own `permission.assert`,
uses its own abort signal, and renders with its own `wait`/`maxOutputChars`. A
caller that aborts does not cancel the others; a different signature is a
conflict.

### Paginated reads

Without `afterMessageID`, `limit` selects the most recent messages. With
`afterMessageID`, it selects the **first** `limit` messages after that anchor,
which makes polling predictable:

```ts
const page = await tools.sessions.read({
  sessionID: "ses_...",
  afterMessageID: "msg_last_seen",
  limit: 50,
})

if (page.hasMore && page.nextAfterMessageID) {
  const next = await tools.sessions.read({
    sessionID: "ses_...",
    afterMessageID: page.nextAfterMessageID,
    limit: 50,
  })
}
```

If a single message does not fit in the budget, `read` returns `partial: true`
and `partialMessageID`, and `nextAfterMessageID` does **not** advance past it.
Re-read the same anchor with a larger `maxOutputChars`; no message is skipped.

### Rename, archive, and remove

```ts
await tools.sessions.update({
  sessionID: "ses_...",
  title: "Nightly audit",
  archived: true,
})

// Deletion is disabled by default.
await tools.sessions.remove({
  sessionID: "ses_...",
  confirm: true,
})
```

Prefer `archived: true` for normal cleanup. `remove` stops execution and is
destructive. It also requires the session to be owned (created or adopted by
this plugin) unless `allowRemoveForeignSessions: true` is enabled.

### Handling permissions

If a background session hits an interactive permission, `sessions.wait` returns
`state: "permission"` with the pending request IDs instead of waiting for the
full timeout. You can inspect and answer them without leaving the agent:

```ts
const pending = await tools.sessions.permissions({ sessionID: created.sessionID })
// Each entry includes the request ID, action, and resources.

await tools.sessions.reply({
  sessionID: created.sessionID,
  requestID: "per_...",
  decision: "once", // once | always | reject
})
```

`always` requires `allowPersistentPermissions: true`. Replies to sessions not
created by this plugin require `allowReplyToForeignSessions: true`.

New sessions can also receive their own permission rules. By default only
`ask` and `deny` rules are accepted:

```ts
await tools.sessions.open({
  prompt: "Run the test suite and report failures.",
  permissions: [{ action: "shell", resource: "*", effect: "ask" }],
})
```

To allow a rule, opt in explicitly:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": { "allowPermissionRules": true }
    }
  ]
}
```

### Host permission rules

The security opt-ins above are the plugin's own defaults. Dangerous tools also
call the host's `permission.assert` before acting, so OpenCode `deny`/`ask`
rules apply on top:

| Action | Used by |
| --- | --- |
| `session_bridge.open` | `open` |
| `session_bridge.send` | `send` |
| `session_bridge.reply` | `reply` |
| `session_bridge.update` | `update` |
| `session_bridge.remove` | `remove` |
| `session_bridge.interrupt` | `interrupt` |
| `session_bridge.compact` | `compact` |
| `session_bridge.worktrees` | `worktrees` |
| `session_bridge.waitAny` | `waitAny`, `waitAll` |
| `session_bridge.race` | `race` |
| `session_bridge.bestOf` | `bestOf` |
| `session_bridge.apply` | `applyCandidate` |
| `session_bridge.push` | `applyCandidate({ push: true })` |
| `session_bridge.raceCleanup` | `raceCleanup` |

Read-only tools (`status`, `read`, `wait`, `list`, `permissions`, `language`,
`diagnostics`, `raceStatus`, `raceList`) do not ask for permission. A host
denial is returned as a tool error and the action is not executed. Example
conservative configuration:

```jsonc
{
  "permissions": [
    { "action": "session_bridge.reply", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.remove", "resource": "*", "effect": "ask" }
  ]
}
```

### Output language

Tool output is English by default. Switch to Spanish (or back) at runtime:

```ts
await tools.sessions.language({ language: "es" })
await tools.sessions.language({ language: "en" })
```

The setting is persisted in the plugin's storage. The language only affects
plugin labels and fixed phrases. Assistant text, user prompts, and tool output
are returned verbatim. Single-line metadata (titles, IDs, permission fields,
tool names, file labels, and errors in `content`) is sanitized to prevent line
or ANSI injection; `output.error` keeps the raw error text.

## Configuration

All options are optional. Invalid values produce a warning and fall back to the
default.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `"en"` | Initial output language (`es` or `en`). |
| `defaultTimeoutMs` | `120000` | Default wait timeout. |
| `maxOutputChars` | `20000` | Hard ceiling for every tool `content`. |
| `maxOutputTotalChars` | `maxOutputChars` (`20000`) | Hard ceiling for `JSON.stringify(output)`. Arrays are trimmed with truncation flags. |
| `maxTools` | `40` | Tools shown in a summary; the rest are summarized. |
| `maxToolLine` | `500` | Maximum characters per tool line. |
| `maxTextChars` | `4000` | Maximum characters per assistant/user text block and `output.text`. |
| `maxErrorChars` | `1000` | Maximum characters for `output.error` and retry reasons. |
| `maxTitleChars` | `500` | Maximum title length in input and output (control characters are sanitized). |
| `maxPermissions` | `20` | Maximum permission items in `status`/turn output. |
| `maxPromptChars` | `100000` | Maximum **code points** for `prompt` and `reply.message`. |
| `maxSearchChars` | `500` | Maximum code points for `list.search`. |
| `maxPermissionRules` | `100` | Maximum permission rules in `open`/`update`. |
| `maxMetadataBytes` | `32768` | Maximum serialized bytes for `update.metadata`. |
| `maxIdChars` | `256` | Maximum code points for `sessionID`, `messageID`, `requestID`, `cursor`, `parentID`, and `afterMessageID`. |
| `maxAgentChars` | `128` | Maximum code points for `agent`. |
| `maxModelChars` | `256` | Maximum code points for `model`. |
| `maxPathChars` | `4096` | Maximum code points for `directory` and `subpath`. |
| `maxPermissionFieldChars` | `512` | Maximum code points for permission `action`/`resource` fields. |
| `queueTtlMs` | `3600000` | Background queue entry TTL. |
| `livePendingTtlMs` | `600000` | TTL for live inbox/prompt pending entries used as wait anchors. |
| `maxQueuedPrompts` | `100` | Maximum tracked queued prompts per session. |
| `pollIntervalMs` | `500` | Initial polling fallback interval. |
| `maxPollIntervalMs` | `2000` | Maximum polling backoff. |
| `permissionPollMs` | `1500` | Permission check interval when no event is available. |
| `requestTimeoutMs` | `10000` | Per-request timeout for HTTP calls. |
| `progressIntervalMs` | `5000` | Progress reporting interval during waits. |
| `allowPermissionRules` | `false` | Allow `effect: "allow"` rules in `open`/`update`. |
| `allowPersistentPermissions` | `false` | Allow `decision: "always"` in `reply`. |
| `allowReplyToForeignSessions` | `false` | Allow replying to sessions not created by this plugin. |
| `allowInterruptForeignSessions` | `false` | Allow interrupting sessions not created or adopted by this plugin. |
| `allowUpdateForeignSessions` | `false` | Allow renaming/archiving/metadata changes on foreign sessions (also required by `compact` for foreign sessions). |
| `allowSessionRemoval` | `false` | Enable `sessions.remove`. |
| `allowRemoveForeignSessions` | `false` | Allow `remove` on sessions not created or adopted by this plugin. Dangerous. |
| `allowCompact` | `false` | Enable `sessions.compact`. |
| `allowCrossDirectoryManagement` | `true` | Allow an owner/run to manage its workers across directories. Set to `false` to require the same directory. |
| `allowWorkerOrchestration` | `false` | Allow worker sessions to use `sessions.*` tools. Dangerous; keep it off. |
| `allowWorktreeDirectories` | `false` | Accept explicit directories outside the project when they are git worktree roots. |
| `allowWorktreeManagement` | `false` | Enable `worktrees create/remove` and `raceCleanup`. |
| `allowTestCommands` | `false` | Enable `setupCommand`/`testCommand`/`teardownCommand` and `verifyCommand` execution. |
| `allowTestChanges` | `false` | Allow a race candidate that modifies tests or CI to be considered trusted. |
| `allowApplyCandidates` | `false` | Enable `applyCandidate`. |
| `allowPushCandidates` | `false` | Enable the separate `push: true` opt-in. |
| `allowSnapshotCommits` | `true` | Allow race snapshots to create local commits in candidate worktrees when no secret-like paths are present. |
| `maxWorktrees` | `8` | Maximum worktrees per create call. |
| `maxRaceCandidates` | `8` | Maximum candidates in a race. |
| `maxWaitSessions` | `8` | Maximum sessions in `waitAny`/`waitAll`. |
| `maxConcurrentSessions` | `4` | Concurrency cap for candidate waits/session creation. |
| `maxDiffBytes` | `200000` | Maximum displayed diff bytes per candidate. Apply uses the commit or full patch, not this display cap. |
| `maxTestOutputChars` | `20000` | Maximum stdout/stderr characters per test command. |
| `maxRaceWallClockMs` | `600000` | Default race wall-clock timeout. |
| `raceRetentionMs` | `604800000` | Race record retention. |
| `gitTimeoutMs` | `120000` | Timeout for git/verification commands. |
| `debug` | `false` | Reserved for diagnostic logging. |

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": {
        "language": "en",
        "defaultTimeoutMs": 120000,
        "maxOutputChars": 20000
      }
    }
  ]
}
```

### Orchestration opt-in

Worktrees, races, test commands, and apply are disabled by default. This
configuration enables the minimum needed to create worktrees, run test
commands, and apply a candidate, while keeping candidate pushes and worker
orchestration off:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": {
        "allowWorktreeManagement": true,
        "allowTestCommands": true,
        "allowApplyCandidates": true,
        "allowPushCandidates": false,
        "allowTestChanges": false,
        "allowWorkerOrchestration": false
      }
    }
  ],
  "permissions": [
    { "action": "session_bridge.worktrees", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.race", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.bestOf", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.apply", "resource": "*", "effect": "ask" }
  ]
}
```

`allowPushCandidates` is intentionally `false`: `applyCandidate({ commit: true
})` can create a local commit, but pushing remains a separate opt-in. Review
the result and run `git push` manually if that is your workflow.
`allowTestChanges` stays `false` so candidates that modify tests or CI are not
treated as trusted, and `allowWorkerOrchestration` stays `false` so workers
cannot use orchestration tools.

## How it works

1. `session.create` creates a real session, or `session.get` reuses an explicit
   `sessionID` / persisted `messageID` mapping.
2. `session.prompt` admits the message and returns its ID. That ID is the
   anchor for the turn.
3. The plugin waits using `session.wait` and session events
   (`session.idle`, `session.status`, `session.execution.started/succeeded/failed/interrupted`,
   `session.retry.scheduled`, `permission.asked`).
4. After a terminal signal, a bounded settle phase retries the transcript a few
   times (short delays, at most four retries) so an event that arrives before
   the `idle` message is persisted does not cause a false timeout. If the
   terminal signal belongs to a previous turn, `session.wait`/events are
   re-armed a bounded number of times instead of falling back to full polling.
5. A successful turn requires the anchor as a user message, a later `idle`, and
   an assistant/compaction message after the anchor. Idles from the previous
   turn are ignored, including after queued/steered prompts. A failed or
   interrupted idle can complete a turn without assistant text.
6. A provider retry (`session.status` with `type: "retry"` or
   `session.retry.scheduled`) is reported as `retrying` with the attempt,
   reason, and next retry. `next`/`at` are absolute epoch milliseconds;
   `content` shows the remaining seconds (clamped to 0) and `output.retry`
   adds `retryAt` (ISO) and `retryInMs`. It is not an error and does not stop
   the wait.
7. If both event sources are unavailable or fail, the plugin falls back to
   `session.get` (cheap) plus polling with backoff (500 ms → 1 s → 2 s), and
   reads the transcript only when the session becomes idle or every five
   seconds as a safety net. The fallback is bounded by the timeout and by five
   consecutive request errors. A final short read at the deadline can still
   return `idle` when the turn completed just in time.
8. Dangerous actions call the host permission rules before touching the
   session.
9. A normal turn performs at most a few `session.context` reads, normally one
   at the end plus settle retries. The complete transcript is read because
   2.2.5 does not expose paginated message reads from the plugin context.
10. Outputs are built with a budget that reserves session IDs, state, message
    IDs, pending permissions, and errors before optional text/tools. Truncation
    is safe for Unicode surrogate pairs and bounded by the requested limits.
    A second, global pass enforces `maxOutputTotalChars` over the serialized
    `output`, trimming arrays last-to-first and preserving critical fields.
11. A live in-memory cache observes prompt hooks, `session.inbox.*` events, and
    durable execution/retry events (IDs and delivery only, never prompt text)
    to report foreign queued work and execution failures. The subscription
    reconnects with bounded backoff (1 s → 30 s) after a stream failure, and
    `status` only trusts a live status that is fresh relative to the session
    timestamps. Pending anchors expire with `livePendingTtlMs`.
12. Owned sessions and open mappings are stored per directory with a 30-day
    TTL / 7-day TTL, LRU eviction, and cleanup on `remove`. Writes are
    coalesced with a short debounce; `remove` and plugin cleanup flush the
    final state. `open` no longer waits for two full registry writes before
    admitting the prompt.
13. `wait` treats `timeoutMs` as end-to-end: it computes a deadline before the
    preflight, bounds each preflight call by the remaining time, reuses the
    preflight permission list, and gives the final idle/permission read a
    single ~300 ms budget instead of sequential timeouts.

New sessions inherit the **model of the calling session** by default and use the
`build` agent. Both can be overridden with the `model` and `agent` options. An
explicit `model` skips the caller-session and default-model lookups. Model
variants use `provider/model#variant`.

## Permissions and security

- Each session uses its own tool permissions. A pending permission can block a
  background session; `sessions.wait` returns `state: "permission"` quickly.
- `effect: "allow"` rules are rejected unless `allowPermissionRules: true`.
  Allowing arbitrary actions lets a background session execute shell/edit
  actions without human review. This is a real prompt-injection surface: review
  every rule and prefer `ask`/`deny`.
- `decision: "always"` saves a permission and requires
  `allowPersistentPermissions: true`. `once` is still an approval; it is not an
  innocuous action.
- By default `sessions.reply` only accepts sessions created by this plugin.
  Enabling `allowReplyToForeignSessions` lets the agent approve requests from
  any session, including sessions it did not create. Use it only in trusted
  environments.
- `sessions.interrupt` and `sessions.update` also reject foreign sessions by
  default. Use `open({ sessionID })` to adopt a session, or enable
  `allowInterruptForeignSessions` / `allowUpdateForeignSessions` explicitly.
  `send` does not adopt a session.
- `sessions.remove` is disabled by default and requires `confirm: true`. It
  also requires ownership (created or adopted by this plugin) unless
  `allowRemoveForeignSessions: true`. It stops execution and cannot be undone.
  Use `sessions.update` with `archived: true` for normal cleanup.
- `sessions.compact` is disabled by default (`allowCompact`). For foreign
  sessions it also requires `allowUpdateForeignSessions`.
- Dangerous actions call `permission.assert` with separate
  `session_bridge.*` actions. A host `deny` or rejected `ask` aborts the action
  and surfaces as a tool error; it is never converted into a success report.
- The plugin never approves permissions automatically.

## Limits and troubleshooting

- OpenCode 2.2.5 does not expose `session.diff`, `session.inbox`,
  `session.message.list`, `session.active`, or `session.fork` through the
  plugin context. This plugin does not use them.
- `read` always reads the full context once; the API does not expose paginated
  message reads in 2.2.5. Without `afterMessageID`, `limit` selects the recent
  tail. With `afterMessageID`, it returns the first `limit` messages after the
  anchor and reports `hasMore` / `nextAfterMessageID`.
- `status` with `includeText: false` and `includeTools: false` skips the
  transcript read and returns state/timestamps only. `queued` is inferred from
  the local FIFO queue, the live inbox/prompt cache, and transcript heuristics.
- `list` state is a timestamp snapshot and may change immediately after the
  response. `cost`/`tokens` are included only with `verbose: true`.
- A timeout does not stop the session. Check again with `sessions.status` or
  `sessions.wait`, using the returned `messageID` when the turn was queued.
- If a permission blocks a turn, reply and then call `sessions.wait` again.
- `model` uses `provider/model`; the model ID may contain `/`. A variant is
  appended as `#variant`.
- `output.text`, `output.error`, titles, pending permissions, and list results
  are bounded; check `textTruncated`, `textLength`, `pendingTotal`,
  `pendingTruncated`, `errorTruncated`, `toolsTruncated`, `queuedTruncated`,
  and `sessionsTruncated`. The serialized output is also capped by
  `maxOutputTotalChars`. Raise the relevant limit or lower `recent`/`limit`.
- Input limits are configurable (`maxPromptChars`, `maxTitleChars`,
  `maxSearchChars`, `maxPermissionRules`, `maxMetadataBytes`, `maxIdChars`,
  `maxAgentChars`, `maxModelChars`, `maxPathChars`,
  `maxPermissionFieldChars`) and are enforced both by JSON Schema and runtime
  validation. Lengths count Unicode code points.
- A partial transcript read returns `partial: true`; re-read the same
  `afterMessageID` with a larger `maxOutputChars` instead of advancing.
- Worktree orchestration is opt-in and disabled by default:
  `allowWorktreeManagement`, `allowTestCommands`, `allowApplyCandidates`, and
  `allowPushCandidates` are `false`. There is no automatic candidate selection
  with an LLM, and no automatic apply, commit, or push.
- `localize` is a deprecated legacy helper. New code should use `t()`; the
  helper copies multiline assistant content and non-permission tool lines
  verbatim. Removal is planned for a future major release.
- The `open` mapping expires after 7 days and stores at most 500 entries per
  directory. Owned sessions expire after 30 days. Use an explicit `sessionID`
  when the retry window is longer.
- The plugin does not delete sessions unless `allowSessionRemoval` is enabled.

## Development

```sh
npm install
npm run typecheck
npm test
npm run pack:check
```

- `index.ts` registers the plugin and tools.
- `src/i18n.ts` contains the structured dictionaries and the legacy
  `localize` compatibility wrapper.
- `src/format.ts` contains message formatting, state detection, budgets, and
  transcript rendering.
- `src/validation.ts`, `src/options.ts`, `src/wait.ts`, `src/registry.ts`, and
  `src/types.ts` contain the pure/runtime helpers.
- `tests/` covers i18n, formatting, validation, event-driven waiting, queue
  anchoring, permissions, budgets, and the tool surface with a fake context.
- CI runs typecheck, tests, and `npm pack --dry-run` on Ubuntu and Windows.

## License

[MIT](LICENSE)
