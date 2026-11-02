# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-02

### Breaking changes

- Permission rules with `effect: "allow"` are rejected by default. Enable
  `allowPermissionRules: true` to opt in.
- `sessions.reply` with `decision: "always"` requires
  `allowPersistentPermissions: true`.
- `sessions.reply` only accepts sessions created by this plugin unless
  `allowReplyToForeignSessions: true` is set. `once` is an approval too.
- `sessions.remove` requires `allowSessionRemoval: true` and `confirm: true`.
  Prefer `sessions.update` with `archived: true`.
- `sessions.status` and `sessions.wait` use session timestamps and ignore
  control messages (`agent-switched`, `model-switched`, `system`, `skill`,
  `shell`) when deciding whether a turn is open.

### Added

- Event-driven waiting with `session.wait` and `session.idle` /
  `session.execution.*` / `permission.asked` events, plus a bounded polling
  fallback. A normal turn uses at most two `session.context` reads.
- Exact turn anchoring by the `id` returned from `session.prompt`, including
  `delivery: "queue"`. Optional `messageID` on `open` and `send` provides
  idempotency.
- `sessions.update` (rename, archive, metadata, permissions) and
  `sessions.remove` (destructive, opt-in and confirmation required).
- Output budgets: `maxOutputChars`, `maxText`, `maxTools`, `maxToolLine`,
  `maxPermissions`; omitted tools are summarized.
- Runtime validation for `timeoutMs`, `limit`, `recent`, `prompt`,
  `maxOutputChars`, `maxText`, model format, and permission rules.
- `state: "permission"` and `state: "error"`, `lastError`, `elapsedMs`,
  `fetchCount`, and `promptMessageID` in turn results.
- `context.progress` reporting during long waits, without prompt content.
- `status` runs `session.get`, `session.context`, and `permission.list` in
  parallel, supports `verbose`, `includeText`, and `maxText`.
- `read` includes files, shell, synthetic, compaction, optional reasoning, and
  an explicit warning when `afterMessageID` is unknown.
- `list` supports `cursor`, `order`, `archived`, `parentID`, `subpath`, and
  `verbose`.
- Structured Spanish/English dictionaries with key parity; assistant, user, and
  tool content is never translated.
- Pure helper modules under `src/`; `index.ts` is now an orchestrator.
- `engines.node >= 24`, pinned `@opencode/plugin` 2.2.5, `CHANGELOG.md`, and a
  `npm pack --dry-run` CI check.

### Fixed

- `localize` no longer rewrites assistant or user content.
- `(desconocida)` is translated to `(unknown)`.
- `isRunning` no longer reports an idle session as running after a control
  message.
- `recent: 0` and `limit: 0` now use their defaults instead of meaning "no
  limit".
- `compact` no longer throws on circular objects.
- `modelRef` requires a provider and a non-empty model ID.
- `parseModel` trims input and rejects internal whitespace.
- `formatError` handles strings, structured errors, and nested response bodies.
- `titleFromPrompt` and all truncation helpers are safe for surrogate pairs.
- Orphaned sessions created by a failed `open` prompt are reported with their
  session ID.

### Security

- New sessions reject `allow` permission rules unless explicitly opted in.
- Persistent permissions and replies to foreign sessions require explicit
  opt-ins.
- Session deletion is disabled by default.
- README security sections document the prompt-injection and background
  execution risks.

## [1.1.0] - 2026-10-30

### Added

- Configurable output language with persisted `sessions.language`.
- Permission listing and replies (`once`, `always`, `reject`).
- Session list, read, wait, interrupt, status, open, and send tools.

## [1.0.0] - 2026-10-20

- Initial public release.
