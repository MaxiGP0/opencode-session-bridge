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

- Create a new session and send its first prompt.
- Send follow-up messages to any existing session, with `steer` or `queue`
  delivery.
- Wait for the **exact turn** admitted by `session.prompt`, anchored by the
  message ID returned by the server.
- Event-driven waiting (`session.wait` + `session.idle` events) with a bounded
  polling fallback.
- Idempotent retries with an optional `messageID`.
- Check whether a session is running or idle using timestamps and relevant
  transcript messages; control messages are ignored.
- Read the transcript: user messages, assistant text, tools, files, shell,
  synthetic, compaction, and optional reasoning.
- Inspect and answer pending permission requests, with conservative defaults.
- Rename and archive sessions without deleting them.
- Delete sessions only with an explicit opt-in and `confirm: true`.
- Structured Spanish/English output that never translates assistant, user, or
  tool content.
- Configurable output budgets and input validation.
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
| `sessions.open` | Create a new session, send a prompt, and (by default) wait for the exact turn. |
| `sessions.send` | Send a message to an existing session. Supports `steer`, `queue`, model/agent switches, and `messageID`. |
| `sessions.status` | Immediate snapshot: running/idle/permission, outcome, last text, recent tools, pending permissions, and last message ID. |
| `sessions.permissions` | List pending permission requests for a session. |
| `sessions.reply` | Approve or reject a pending permission request (`once`, `always`, or `reject`), subject to security opt-ins. |
| `sessions.read` | Read a bounded transcript, including tools and optional tool output/reasoning. |
| `sessions.wait` | Wait for the current or last started turn. Returns `state: "permission"` as soon as a request is pending. |
| `sessions.interrupt` | Interrupt the running turn. |
| `sessions.list` | List sessions with cursor pagination, filters, and a timestamp snapshot. |
| `sessions.update` | Rename, archive/unarchive, change metadata, or adjust permission rules without deleting. |
| `sessions.remove` | Delete a session. Destructive; requires opt-in and `confirm: true`. |
| `sessions.language` | Get or set the output language (`en` by default, `es` available). |

`open`, `send`, and `wait` return a compact report containing:

- the prompt that was sent;
- the admitted message ID (`Message ID`);
- the final state (`idle`, `timeout`, `aborted`, `permission`, or `error`);
- the outcome and the assistant's final text;
- the tools that were executed, with an omission summary when the budget is
  exceeded;
- any provider/session error and the last message ID;
- pending permission IDs and a reply hint when the turn is blocked.

`delivery: "queue"` does not return until the **queued prompt's own turn**
finishes. An earlier idle from the current turn is not accepted as the result.

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
  sessionID: created.id,
  recent: 8,
  verbose: true,
})

const result = await tools.sessions.wait({
  sessionID: created.id,
  timeoutMs: 120_000,
})

const transcript = await tools.sessions.read({
  sessionID: created.id,
  limit: 30,
  includeTools: true,
  includeToolOutput: true,
  includeReasoning: false,
})
```

### Queue delivery and idempotency

```ts
await tools.sessions.send({
  sessionID: "ses_...",
  prompt: "Run the test suite after the current task.",
  delivery: "queue",
  messageID: "msg_test_suite_1",
  timeoutMs: 120_000,
})
```

Reusing the same `messageID` does not create a second message. The wait anchor
is the ID returned by `session.prompt`, so the call returns only when that
specific queued turn has finished.

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
destructive.

### Handling permissions

If a background session hits an interactive permission, `sessions.wait` returns
`state: "permission"` with the pending request IDs instead of waiting for the
full timeout. You can inspect and answer them without leaving the agent:

```ts
const pending = await tools.sessions.permissions({ sessionID: created.id })
// Each entry includes the request ID, action, and resources.

await tools.sessions.reply({
  sessionID: created.id,
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

### Output language

Tool output is English by default. Switch to Spanish (or back) at runtime:

```ts
await tools.sessions.language({ language: "es" })
await tools.sessions.language({ language: "en" })
```

The setting is persisted in the plugin's storage. The language only affects
plugin labels and fixed phrases. Assistant text, user prompts, tool names,
tool input/output, and errors are always returned verbatim.

## Configuration

All options are optional. Invalid values produce a warning and fall back to the
default.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `"en"` | Initial output language (`es` or `en`). |
| `defaultTimeoutMs` | `120000` | Default wait timeout. |
| `maxOutputChars` | `20000` | Hard ceiling for every tool output. |
| `maxTools` | `40` | Tools shown in a summary; the rest are summarized. |
| `maxToolLine` | `500` | Maximum characters per tool line. |
| `maxTextChars` | `4000` | Maximum characters per assistant/user text block. |
| `maxPermissions` | `20` | Maximum permission lines in a report. |
| `pollIntervalMs` | `500` | Initial polling fallback interval. |
| `maxPollIntervalMs` | `2000` | Maximum polling backoff. |
| `permissionPollMs` | `1500` | Permission check interval when no event is available. |
| `requestTimeoutMs` | `10000` | Per-request timeout for HTTP calls. |
| `progressIntervalMs` | `5000` | Progress reporting interval during waits. |
| `allowPermissionRules` | `false` | Allow `effect: "allow"` rules in `open`/`update`. |
| `allowPersistentPermissions` | `false` | Allow `decision: "always"` in `reply`. |
| `allowReplyToForeignSessions` | `false` | Allow replying to sessions not created by this plugin. |
| `allowSessionRemoval` | `false` | Enable `sessions.remove`. |
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

## How it works

1. `session.create` creates a real session.
2. `session.prompt` admits the message and returns its ID. That ID is the
   anchor for the turn.
3. The plugin waits using `session.wait` and session events
   (`session.idle`, `session.execution.failed`,
   `session.execution.interrupted`, `permission.asked`). It accepts completion
   only when the anchor appears as a user message and an `idle` message follows
   it.
4. If both event sources are unavailable or fail, the plugin falls back to
   polling with backoff (500 ms → 1 s → 2 s). The fallback is bounded by the
   timeout and by five consecutive request errors.
5. A normal turn performs at most two `session.context` reads: normally one at
   the end. The complete transcript is read because 2.2.5 does not expose
   paginated message reads from the plugin context.
6. Outputs are built with a budget and truncated safely, without splitting
   Unicode surrogate pairs.

New sessions inherit the **model of the calling session** by default and use the
`build` agent. Both can be overridden with the `model` and `agent` options.

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
- `sessions.remove` is disabled by default and requires `confirm: true`. It
  stops execution and cannot be undone. Use `sessions.update` with
  `archived: true` for normal cleanup.
- The plugin never approves permissions automatically.

## Limits and troubleshooting

- OpenCode 2.2.5 does not expose `session.diff`, `session.inbox`,
  `session.message.list`, `session.active`, or `session.fork` through the
  plugin context. This plugin does not use them.
- `read` always reads the full context once; `limit` selects the tail to render.
  Paginated message reads are not available in 2.2.5.
- `list` state is a timestamp snapshot and may change immediately after the
  response.
- A timeout does not stop the session. Check again with `sessions.status` or
  `sessions.wait`.
- If a permission blocks a turn, reply and then call `sessions.wait` again.
- `model` uses `provider/model`; the model ID may contain `/`.
- If output is truncated, raise `maxOutputChars` or lower `recent`/`limit`.
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
- CI runs typecheck, tests, and `npm pack --dry-run`.

## License

[MIT](LICENSE)
