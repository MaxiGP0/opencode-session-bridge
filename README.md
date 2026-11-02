# opencode-session-bridge

[English](README.md) | [Español](README.es.md)

An [OpenCode](https://opencode.ai) v2 plugin that lets the agent open, message,
monitor, read, wait for, and interrupt other OpenCode sessions.

Instead of delegating to a child subagent that disappears into the current turn,
this plugin creates **real, independent sessions** that appear in the normal
session list and can be inspected or resumed later.

## Features

- Create a new session and send its first prompt.
- Send follow-up messages to any existing session.
- Check whether a session is running or idle, plus its final outcome.
- Read the transcript: user messages, assistant text, tool calls, and tool output.
- Wait for a turn to finish, with a configurable timeout.
- Interrupt a running session.
- List sessions in a directory with status and outcome.

## Requirements

- OpenCode v2 (tested with `2.2.5`).
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

The plugin is a single `index.ts` file plus `package.json`. OpenCode reloads
plugins from watched configuration directories automatically. If the tools do
not appear, run `/reload` in the TUI.

## Tools

All tools live in the `sessions` namespace.

| Tool | Description |
| --- | --- |
| `sessions.open` | Create a new session, send a prompt, and (by default) wait for the turn to finish. |
| `sessions.send` | Send a message to an existing session. Can switch its agent or model first. |
| `sessions.status` | Immediate snapshot: running/idle, outcome, last text, recent tools, last message ID. |
| `sessions.read` | Read the transcript, including tool calls and optional tool output. |
| `sessions.wait` | Wait for the current turn to finish and return the result. |
| `sessions.interrupt` | Interrupt the running turn. |
| `sessions.list` | List sessions in the current directory with status and outcome. |

`open`, `send`, and `wait` return a compact report containing:

- the prompt that was sent;
- the final state and outcome;
- the assistant's final text;
- the tools that were executed;
- any error from the provider or the session;
- the last message ID, useful as a cursor for `sessions.read`.

## Usage

Talk to the agent in natural language:

- “Open a new session and say hello.”
- “Send this task to session `ses_...`, wait for it, and tell me what it did.”
- “Is that session still running? Read its transcript.”
- “Interrupt it.”

Or call the tools directly from a plugin or agent:

```ts
const created = await tools.sessions.open({
  prompt: "Review the authentication module and report issues.",
  title: "Auth review",
  wait: false,
})

const status = await tools.sessions.status({ sessionID: created.id })
const result = await tools.sessions.wait({ sessionID: created.id, timeoutMs: 120_000 })
const transcript = await tools.sessions.read({
  sessionID: created.id,
  includeTools: true,
  includeToolOutput: true,
})
```

## How it works

The plugin uses the OpenCode server session API through the plugin context:

1. `session.create` creates a real session.
2. `session.prompt` admits the first message.
3. The plugin polls `session.context` until an `idle` message appears after the
   prompt, which marks the end of the turn.
4. Assistant text, tool calls, and errors are extracted from the projected
   messages and returned as a compact report.

New sessions inherit the **model of the calling session** by default and use the
`build` agent. Both can be overridden with the `model` and `agent` options.

## Permissions and limitations

- Each session uses its own tool permissions. If a background session asks for
  an interactive permission, it can stay blocked until you approve it in that
  session or the timeout expires.
- Waiting defaults to 120 seconds (`timeoutMs`). If the timeout is reached, the
  session keeps running and can be checked again with `sessions.status`.
- The plugin does not delete sessions. Remove old sessions from the UI or the
  API if you create many of them.
- Tool descriptions are in English, but tool output is currently written in
  Spanish. The underlying session API is language-agnostic.

## Development

- Edit `index.ts`; there is no build step.
- Load the directory with `opencode plugin add /absolute/path/to/this/repo` or
  copy it to a plugin directory.
- Test the tools by asking the agent to open a session and interact with it.

## License

[MIT](LICENSE)
