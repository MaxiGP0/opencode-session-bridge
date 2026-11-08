# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### 2026-11-08 hardening

#### Fixed

- `retry.next` is an absolute epoch timestamp, not a duration. Content now
  shows the remaining seconds (`next in 0s` when already past), and
  `output.retry` adds `retryAt` (ISO) and `retryInMs`. The old tests using
  `next: 5000` were replaced with real timestamps.
- Concurrent `open` calls now run `permission.assert` for every caller before
  deduplicating. The shared admission is keyed by a signature; a different
  prompt/agent/model/delivery/permissions/sessionID is an actionable conflict.
  Each caller keeps its own abort signal, `wait`, language, and budget; aborting
  one caller does not cancel the others.
- `send` is idempotent for side effects: the same `messageID` and signature
  skips the prompt and model/agent switches and returns `alreadySent: true`.
  Switches are only applied when the current model/agent differs. Different
  signatures are a conflict.
- `remove` requires ownership (created or adopted) unless the new
  `allowRemoveForeignSessions: true` opt-in is enabled.
- `read` no longer advances `nextAfterMessageID` past a message that was only
  partially rendered. `partial` and `partialMessageID` tell the caller to
  re-read with a larger budget.
- Tool `output` values are recursively JSON-safe: nested `undefined` fields
  (for example `diagnostics.live.lastEventAt`) are omitted so Code Mode can
  validate the result.
- `interrupt({ resume: true })` preserves the local queue instead of clearing
  it; `resume: false` clears it. Output adds `queueCleared`, `queueResumed`, and
  `queuedCount`.
- `status` no longer turns a transcript failure into `state: "error"` while the
  session is running/queued/retrying. A permission-list failure is not reported
  as clean idle.
- Durable execution success events and `retry.scheduled` are consumed by
  `wait`; a queued-turn error no longer sticks to a later successful turn.
- Live event consumption reconnects with bounded backoff (1 s → 30 s). Stale
  live status is ignored in favor of fresh session timestamps.

#### Added

- Global output budget: `maxOutputTotalChars` (defaults to the configured
  `maxOutputChars`, `20000` out of the box) caps `JSON.stringify(output)`, with
  `toolsTruncated`, `queuedTruncated`, and `sessionsTruncated` flags in
  addition to `pendingTruncated`.
- `state: "ok"` in successful `read`, `list`, and `permissions`.
- Input limits `maxIdChars`, `maxAgentChars`, `maxModelChars`, `maxPathChars`,
  and `maxPermissionFieldChars`, enforced by schema and runtime.
- `oneLine` sanitization for untrusted metadata in `content` (IDs, titles,
  permission fields, tool names, file labels, and errors); assistant/user text
  and tool output remain verbatim.
- `wait` options `initialPermissions` / `initialPermissionCheckAt` and a single
  ~300 ms final read budget.
- `sessions.compact` (opt-in `allowCompact`) and `sessions.diagnostics`
  (capabilities, registry/live/queue sizes, redacted options, last live event).
- Live snapshots expose `statusAt`, `lastOutcome`, `lastError`; pending anchors
  expire with `livePendingTtlMs`.

#### Changed

- `maxOutputChars` and `maxText` schemas use `anyOf` (`0` or a value at/above
  the runtime minimum) so schema and runtime agree: `500` and `50` are now
  rejected, while `0`, `1000`, and `100` are accepted.
- Length checks count Unicode code points instead of UTF-16 code units.
- Registry writes are coalesced with a debounce; `open` no longer waits for two
  full writes before the prompt, and `remove`/cleanup flush the final state.
- `wait.timeoutMs` is end-to-end: the preflight is bounded by the deadline, the
  preflight permission list is reused, and at most two `permission.list` calls
  are made in the timeout path.
- `update.title` is sanitized before `session.update`, matching `open`.

#### Security / no-goals

- Foreign-session defaults are stricter for `remove`.
- No worktree orchestration, `open({ directory })`, `waitAny`/`waitAll`,
  `race`/`bestOf`, or `applyCandidate` in this release. There is no automatic
  apply, commit, or push.

This work is additive in tool names and fields, but it changes several
security/behavior defaults. A strict SemVer reading requires a major release
(`3.0.0`) because `interrupt`/`update` now reject foreign sessions by default
and `list` only includes `cost`/`tokens` with `verbose: true`. If those changes
are accepted as a security correction, a minor (`2.2.0`) is also defensible;
the package version is intentionally not bumped here. The `read`/`status`/
`wait` behavior corrections are documented because callers may observe
different results.

### Breaking (security/behavior)

- `interrupt` and `update` reject sessions not created or adopted by this
  plugin unless `allowInterruptForeignSessions` /
  `allowUpdateForeignSessions` is enabled. Adopt a session with
  `open({ sessionID })`.
- `list` omits `cost`/`tokens` unless `verbose: true`.
- `maxOutputChars`/`maxText` schema maxima are tied to the configured plugin
  budgets; values above the configured budget are rejected instead of silently
  capped.

### Added

- Bounded `output` metadata: `textLength`, `textTruncated`, `pendingTotal`,
  `pendingTruncated`, and `errorTruncated`. Text, errors, titles, permission
  arrays, and list results are capped independently of `content`.
- `status` reports `queuedCount`, `queuedMessageIDs`, and
  `nextQueuedMessageID`; the background queue is FIFO per session with a TTL,
  a size limit, and cleanup on `interrupt`/`remove`.
- Live provider retry state: `session.status` events produce `state:
  "retrying"` with `retry.attempt`, `retry.message`, and `retry.next`, without
  converting a retry into an error.
- A live in-memory admissions/inbox cache fed by `session.hook("prompt")` and
  `session.inbox.*` events. It stores IDs and delivery only, and is used for
  foreign sessions and exact queue reporting when the experimental APIs exist.
- `allowInterruptForeignSessions` and `allowUpdateForeignSessions` opt-ins.
  `open({ sessionID })` adopts a session; `send` does not.
- Input limits: `maxPromptChars`, `maxTitleChars`, `maxSearchChars`,
  `maxPermissionRules`, `maxMetadataBytes`, `maxErrorChars`, `queueTtlMs`, and
  `maxQueuedPrompts`.
- Per-directory storage namespaces, a 30-day owned-session TTL, true LRU
  refresh, and `forgetOpenSessionsBySessionID` cleanup.
- Bounded extraction and rendering (`assistantText`, `reasoningText`,
  `summarizeTurn`, `renderTranscriptDetailed`, and `compact`) so large turns
  are not materialized in full before truncation.
- Structured `output` schemas and values for every tool (`open`, `send`,
  `status`, `wait`, `list`, `permissions`, `read`, `reply`, `update`, `remove`,
  `interrupt`, `language`). `content` keeps its readable format.
- `open({ sessionID })` creates or reuses that specific session, and a
  persisted `messageID -> sessionID` mapping prevents duplicate sessions on
  retry. Failed prompts report the recoverable session ID.
- `wait({ messageID })` waits for one specific admitted turn, including queued
  and background turns started with `send({ wait: false })`.
- `status` reports `queued`, `promptMessageID`, `lastOutcome`, and
  `includeTools`. With `includeText: false` and `includeTools: false` it skips
  the transcript read.
- `read` pagination: `afterMessageID` + `limit` returns the first `limit`
  messages after the anchor and reports `hasMore` / `nextAfterMessageID`.
- Host permission integration through `permission.assert` for `open`, `send`,
  `reply`, `update`, `remove`, and `interrupt`.
- A bounded settle phase after terminal events and `session.wait` to bridge the
  gap before the `idle` message is persisted.
- `provider/model#variant` model references, including `switchModel`.
- Linear code-point truncation, incremental transcript length tracking, and
  bounded tool collection in turn summaries.

### Changed

- JSON Schemas now accept `0` as "use the default" for `limit`, `recent`,
  `listLimit`, `maxOutputChars`, `maxText`, and the permissions `limit`;
  `timeoutMs` still requires at least 1. Schema maxima for output/text budgets
  now match the configured plugin budget.
- `list` includes `cost`/`tokens` only with `verbose: true`.
- `open` serializes concurrent calls with the same `messageID` or `sessionID`
  and recovers from an "already exists" create race with `session.get`.
- Wait re-arms `session.wait`/events when a terminal signal belongs to a
  previous turn, uses `session.get` for cheap fallback checks, and performs a
  short final read at the deadline.
- `isRunning` combines missing `busy`/`idle` timestamps with transcript
  timestamps instead of trusting a single timestamp.
- `localize` is deprecated: it preserves multiline content and non-permission
  tool lines verbatim.

### Fixed

- Every validation and API error now returns a structured `output` with
  `state: "error"`, `error`, and known IDs instead of `undefined` or an empty
  object. Host `permission.assert` denials still propagate as tool errors.
- The `output` object no longer duplicates unlimited assistant text, titles,
  permission arrays, or list entries in Code Mode.
- Concurrent `open` calls no longer create orphan sessions or duplicate
  prompts.
- A foreign idle no longer leaves a wait without its primary signal or forces
  full transcript polling for the rest of the turn.
- Background queue entries no longer overwrite each other, leak forever, or
  survive `interrupt`/`remove`.
- A provider retry is visible instead of appearing as an opaque running state.
- Foreign `interrupt`/`update` no longer act on sessions the plugin did not
  create or adopt by default.
- The owned-session registry now refreshes LRU order, expires entries, isolates
  directories, and cleans open mappings on `remove`.
- Multiline assistant content and tool lines are no longer rewritten by the
  legacy `localize` helper.
- False timeouts when `session.idle` or `session.wait` arrived before the idle
  message was visible in `session.context`.
- An idle from a previous turn could complete a queued or steered prompt; a
  successful turn now requires the anchor, a later idle, and an
  assistant/compaction message (or a failed/interrupted idle).
- `read({ afterMessageID, limit })` ignored `limit` and could return the whole
  remainder of the transcript.
- Critical session IDs, state, message IDs, pending permission IDs, and errors
  could be lost when output was truncated. They are now reserved before text
  and tools.
- `status` could show an old outcome as the current result while a session was
  running, and `promptMessageID` was omitted for idle sessions.
- Host permission denials were not represented as tool errors; they now abort
  the action and propagate.
- Abort listeners could miss a signal aborted between the initial check and
  listener registration.
- `t` could reinterpret placeholder-like text inside interpolated values.
- `open` with an explicit model no longer calls the caller session or
  `model.default`, and failed prompts no longer encourage an orphan retry.

### Security

- Dangerous actions now call the host's `permission.assert` rules in addition
  to the plugin opt-ins, with separate `session_bridge.*` actions.
- Permission denials and rejected `ask` requests are never converted into a
  successful `content` report.
- Foreign `interrupt`/`update` require explicit opt-ins, and prompt-inbox cache
  entries never include prompt text.

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
