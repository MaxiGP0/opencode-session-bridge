import path from "node:path"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  isPathInside,
  resolveGitDir,
  sameDirectory,
  validateTargetDirectory,
} from "./directories.ts"
import {
  capOutput,
  codePointLength,
  formatError,
  isRunning,
  lastUser,
  oneLine,
  parseModel,
  summarizeTurn,
  truncateCodePoints,
  type Summary,
} from "./format.ts"
import {
  parseCommand,
  removeRacePatches,
  runCommand,
  safePatchSegment,
  writePatchFile,
  type CommandResult,
  type GitRunner,
} from "./git.ts"
import type { LiveBackground, LiveState } from "./live.ts"
import type { BridgeOptions } from "./options.ts"
import {
  analyzeDiffs,
  candidateByID,
  createRaceID,
  rankCandidates,
  rememberRace,
  shapeRace,
  verificationFor,
  parsePatchFiles,
  type CandidateDiffFile,
  type CandidateRecord,
  type CandidateTests,
  type CommandSummary,
  type RaceCleanup,
  type RaceRecord,
  type RaceRegistry,
  type SnapshotMode,
  type VcsFileDiff,
} from "./races.ts"
import { type RaceInput } from "./validation.ts"
import {
  rememberOpenSession,
  rememberOwnedSession,
  rememberWorkerSession,
  type OpenSessionMapping,
  type OwnedSessions,
  type RegistryPersistence,
  type WorkerSessions,
} from "./registry.ts"
import { assertPermission, promptMessageID, throwIfAborted, withRequest } from "./runtime.ts"
import type {
  Lang,
  MessageLike,
  PermissionLike,
  PluginContext,
  ToolExecuteContext,
  TurnResult,
} from "./types.ts"
import { attachAndPersistSession, createWorktrees, removeWorktrees, worktreeFor, type WorktreeRegistry, type WorktreeStrategy } from "./worktrees.ts"
import { evaluateTurn, sleep, waitForTurn } from "./wait.ts"

export type DirectoryValidator = typeof validateTargetDirectory

export type OrchestrationDeps = {
  ctx: PluginContext
  options: BridgeOptions
  getLanguage: () => Lang
  ownedSessions: OwnedSessions
  openSessions: OpenSessionMapping
  workerSessions: WorkerSessions
  worktrees: WorktreeRegistry
  races: RaceRegistry
  liveState?: LiveState
  registry?: RegistryPersistence
  git: GitRunner
  validateDirectory?: DirectoryValidator
}

function registeredWorktreeDirectories(deps: OrchestrationDeps): string[] {
  const projectID = deps.ctx.location?.project?.id
  return [...deps.worktrees.values()]
    .filter((record) => !record.projectID || !projectID || record.projectID === String(projectID))
    .map((record) => record.directory)
}

export type WaitOneResult = {
  sessionID: string
  state: "idle" | "timeout" | "aborted" | "permission" | "error" | "running"
  messageID?: string
  lastMessageID?: string
  outcome?: string
  elapsedMs: number
  /** Diagnostic: the visible transcript anchor predates the busy turn. */
  anchorStale?: boolean
  waitingFor?: "next-turn"
  retry?: {
    attempt: number
    message: string
    next: number
    retryAt?: string
    retryInMs?: number
  }
  pendingPermissions?: Array<{ id: string; action: string; resources?: string[]; message?: string }>
  error?: string
  background?: LiveBackground[]
  settled: boolean
  text?: string
}

export type WaitManyResult = {
  mode: "any" | "all"
  state: "ok" | "running" | "timeout" | "aborted" | "permission"
  results: WaitOneResult[]
  pending: string[]
  elapsedMs: number
  timedOut: boolean
  aborted: boolean
}

const HARD_PATCH_LIMIT = 2_000_000

function summarize(
  turn: TurnResult,
  options: BridgeOptions,
): Summary {
  return summarizeTurn(
    turn.messages,
    turn.startIndex,
    false,
    turn.endIndex,
    options.maxTools,
    options.maxTextChars,
  )
}

function retryOutput(
  retry: TurnResult["retry"],
): WaitOneResult["retry"] | undefined {
  if (!retry) return undefined
  return {
    attempt: retry.attempt,
    message: oneLine(retry.message, 1_000),
    next: retry.next,
    retryAt: typeof retry.next === "number" ? new Date(retry.next).toISOString() : undefined,
    retryInMs: retry.inMs,
  }
}

function pendingOutput(pending: PermissionLike[] | undefined): WaitOneResult["pendingPermissions"] {
  if (!pending?.length) return undefined
  return pending.map((request) => ({
    id: oneLine(request.id, 256),
    action: oneLine(request.action, 120),
    resources: request.resources?.slice(0, 10).map((value) => oneLine(value, 200)),
    message: request.message ? oneLine(request.message, 200) : undefined,
  }))
}

function backgroundOutput(background: LiveBackground[] | undefined): LiveBackground[] | undefined {
  if (!background?.length) return undefined
  return background.map((entry) => ({
    kind: entry.kind,
    sessionID: entry.sessionID,
    shellID: entry.shellID,
    childSessionID: entry.childSessionID,
    agent: entry.agent,
    description: entry.description,
    command: entry.command,
    path: entry.path,
    model: entry.model,
  }))
}

async function waitBackground(
  deps: OrchestrationDeps,
  sessionID: string,
  deadline: number,
  signal: AbortSignal,
  intervalMs: number,
): Promise<LiveBackground[] | undefined> {
  if (!deps.liveState) return undefined
  // Do not block the whole global timeout on background work. A short grace
  // lets a shell/subagent finish; otherwise report that it is still running so
  // the orchestrator can wait again.
  const graceUntil = Math.min(deadline, Date.now() + 500)
  let live = deps.liveState.get(sessionID)
  while (live.background?.length && Date.now() < graceUntil && !signal.aborted) {
    await sleep(Math.min(intervalMs, Math.max(1, graceUntil - Date.now())), signal)
    live = deps.liveState.get(sessionID)
  }
  return live.background
}

async function waitOne(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  sessionID: string,
  messageID: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WaitOneResult> {
  const started = Date.now()
  const timeout = Math.max(1, Math.min(timeoutMs, 600_000))
  const deadline = started + timeout
  const remaining = () => Math.max(1, deadline - Date.now())
  const preflight = () => Math.max(1, Math.min(deps.options.requestTimeoutMs, remaining()))
  const [sessionResult, messagesResult, pendingResult] = await Promise.allSettled([
    withRequest(signal, preflight(), (request) =>
      deps.ctx.session.get({ sessionID }, { signal: request }),
    ),
    withRequest(signal, preflight(), (request) =>
      deps.ctx.session.context({ sessionID }, { signal: request }),
    ),
    withRequest(signal, preflight(), (request) =>
      deps.ctx.permission.list({ sessionID }, { signal: request }),
    ),
  ])

  if (signal.aborted) {
    return {
      sessionID,
      state: "aborted",
      elapsedMs: Date.now() - started,
      settled: false,
      error: "aborted",
    }
  }
  if (sessionResult.status === "rejected") {
    return {
      sessionID,
      state: "error",
      elapsedMs: Date.now() - started,
      settled: true,
      error: formatError(sessionResult.reason),
    }
  }

  const session = sessionResult.value
  const messages = messagesResult.status === "fulfilled" ? messagesResult.value : []
  const pending = pendingResult.status === "fulfilled" ? pendingResult.value : []
  const permissionCheckedAt = Date.now()
  const live = deps.liveState?.get(sessionID)
  const lastVisibleUser = lastUser(messages)
  const busySince =
    typeof session.time?.busy === "number" &&
    (typeof session.time?.idle !== "number" || session.time.busy > session.time.idle)
      ? session.time.busy
      : undefined
  // A busy session whose newest visible user predates the current busy turn
  // means the transcript is behind. Returning idle here would hand the caller
  // the previous turn's result.
  const staleAnchor =
    !messageID &&
    busySince !== undefined &&
    (lastVisibleUser?.time?.created ?? 0) < busySince
  const liveAnchor = staleAnchor ? undefined : live?.pending[0]?.messageID
  const anchorID = messageID ?? liveAnchor ?? lastVisibleUser?.id
  const minimumAnchorCreatedAt = staleAnchor ? busySince : undefined
  const evaluation = anchorID
    ? evaluateTurn(messages, {
        sessionID,
        anchorID,
        requireAnchor: Boolean(messageID),
        timeoutMs: timeout,
        ...(minimumAnchorCreatedAt !== undefined ? { minimumAnchorCreatedAt } : {}),
      })
    : undefined

  if (pending.length) {
    return {
      sessionID,
      state: "permission",
      messageID: anchorID,
      lastMessageID: messages[messages.length - 1]?.id,
      elapsedMs: Date.now() - started,
      pendingPermissions: pendingOutput(pending),
      settled: false,
      ...(staleAnchor ? { anchorStale: true, waitingFor: "next-turn" as const } : {}),
    }
  }

  if (
    evaluation?.done ||
    (!evaluation?.staleAnchor && !anchorID && !isRunning(session, messages))
  ) {
    let background: LiveBackground[] | undefined
    if (deps.liveState) {
      background = deps.liveState.get(sessionID).background
      if (background?.length) {
        background = await waitBackground(deps, sessionID, deadline, signal, 250)
      }
    }
    const summary = evaluation
      ? summarizeTurn(messages, evaluation.startIndex, false, evaluation.endIndex, deps.options.maxTools, deps.options.maxTextChars)
      : undefined
    return {
      sessionID,
      state: background?.length ? "running" : "idle",
      messageID: anchorID,
      lastMessageID: messages[messages.length - 1]?.id,
      outcome: evaluation?.idle?.outcome ?? session.outcome,
      elapsedMs: Date.now() - started,
      settled: !background?.length,
      ...(background?.length ? { background: backgroundOutput(background) } : {}),
      ...(summary?.text ? { text: summary.text } : {}),
    }
  }

  const turn = await waitForTurn(deps.ctx, {
    sessionID,
    anchorID: staleAnchor ? undefined : anchorID,
    promptText: messageID || staleAnchor ? undefined : lastVisibleUser?.text,
    admittedAt: messageID || staleAnchor ? undefined : lastVisibleUser?.time?.created,
    timeoutMs: remaining(),
    signal,
    initialMessages: messagesResult.status === "fulfilled" ? messages : undefined,
    initialFetchCount: messagesResult.status === "fulfilled" ? 1 : 0,
    initialPermissions: pending,
    initialPermissionCheckAt: permissionCheckedAt,
    requireAnchor: !staleAnchor && Boolean(anchorID),
    promptMessageID: staleAnchor ? undefined : anchorID,
    ...(minimumAnchorCreatedAt !== undefined ? { minimumAnchorCreatedAt } : {}),
    pollIntervalMs: deps.options.pollIntervalMs,
    maxPollIntervalMs: deps.options.maxPollIntervalMs,
    permissionPollMs: deps.options.permissionPollMs,
    requestTimeoutMs: deps.options.requestTimeoutMs,
    progressIntervalMs: deps.options.progressIntervalMs,
  })

  if (turn.state === "aborted") {
    return {
      sessionID,
      state: "aborted",
      messageID: anchorID,
      elapsedMs: Date.now() - started,
      settled: false,
      error: "aborted",
    }
  }

  let state: WaitOneResult["state"] =
    turn.state === "permission"
      ? "permission"
      : turn.state === "timeout"
        ? "timeout"
        : turn.state === "error"
          ? "error"
          : "idle"
  let background: LiveBackground[] | undefined
  if (state === "idle" && deps.liveState) {
    background = await waitBackground(deps, sessionID, deadline, signal, 250)
    if (background?.length) state = "running"
  }
  const summary =
    turn.state === "idle" || turn.state === "timeout"
      ? summarize(turn, deps.options)
      : undefined
  const error =
    turn.lastError ??
    (messagesResult.status === "rejected" ? formatError(messagesResult.reason) : undefined)

  return {
    sessionID,
    state,
    messageID: staleAnchor ? (turn.anchorMessage?.id ?? anchorID) : anchorID,
    lastMessageID: summary?.lastMessageID ?? turn.messages[turn.messages.length - 1]?.id,
    outcome: summary?.outcome ?? turn.idle?.outcome,
    elapsedMs: Date.now() - started,
    retry: retryOutput(turn.retry),
    pendingPermissions: pendingOutput(turn.pendingPermissions),
    ...(staleAnchor ? { anchorStale: true, waitingFor: "next-turn" as const } : {}),
    ...(error ? { error } : {}),
    ...(background ? { background: backgroundOutput(background) } : {}),
    settled: state === "idle" || state === "error",
    ...(summary?.text ? { text: summary.text } : {}),
  }
}

export async function waitMany(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  input: {
    sessionIDs: string[]
    messageIDs?: Record<string, string>
    timeoutMs: number
    perSessionTimeoutMs?: number
    mode: "any" | "all"
    returnOnPermission: boolean
  },
): Promise<WaitManyResult> {
  const started = Date.now()
  const controller = new AbortController()
  const parent = context.signal
  let aborted = false
  let timedOut = false
  const onAbort = () => {
    aborted = true
    controller.abort(parent?.reason)
  }
  if (parent) {
    if (parent.aborted) onAbort()
    else parent.addEventListener("abort", onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("waitAny timed out", "TimeoutError"))
  }, Math.max(1, input.timeoutMs))

  const perSessionTimeout = input.perSessionTimeoutMs ?? input.timeoutMs
  const results: Array<WaitOneResult | undefined> = input.sessionIDs.map(() => undefined)
  let permissionSeen = false
  let resolvePermission: (() => void) | undefined
  const permissionSignal = new Promise<void>((resolve) => {
    resolvePermission = resolve
  })
  const waiters = input.sessionIDs.map(async (sessionID, index) => {
    const timeout = Math.max(
      1,
      Math.min(perSessionTimeout, input.timeoutMs - (Date.now() - started)),
    )
    let result: WaitOneResult
    try {
      result = await waitOne(
        deps,
        context,
        sessionID,
        input.messageIDs?.[sessionID],
        timeout,
        controller.signal,
      )
    } catch (error) {
      result = {
        sessionID,
        state: controller.signal.aborted ? "aborted" : "error",
        elapsedMs: Date.now() - started,
        settled: false,
        error: formatError(error),
      }
    }
    results[index] = result
    if (result.state === "permission") {
      permissionSeen = true
      resolvePermission?.()
    }
    void context.progress({
      status: "waiting",
      sessionID,
      elapsedMs: result.elapsedMs,
      state: result.state,
    }).catch(() => undefined)
    return result
  })

  const all = Promise.allSettled(waiters)
  try {
    if (input.mode === "any") {
      // The first settled result is enough. Abort the rest so no request or
      // timer survives the tool call.
      const first = await Promise.race(waiters)
      if (!controller.signal.aborted) controller.abort()
      const pending = input.sessionIDs.filter((_, index) => !results[index])
      return {
        mode: "any",
        state:
          first.state === "permission"
            ? "permission"
            : first.state === "running"
              ? "running"
              : first.state === "timeout"
                ? "timeout"
                : first.state === "aborted"
                  ? "aborted"
                  : "ok",
        results: results.filter((result): result is WaitOneResult => Boolean(result)),
        pending,
        elapsedMs: Date.now() - started,
        timedOut,
        aborted: aborted || first.state === "aborted",
      }
    }

    let earlyPermission = false
    if (input.returnOnPermission) {
      await Promise.race([all.then(() => undefined), permissionSignal])
      earlyPermission = permissionSeen && results.some((result) => result?.state === "permission")
      if (earlyPermission && !controller.signal.aborted) controller.abort()
    }
    await all
    const finalResults = results.map((result, index) => {
      if (result) {
        if (timedOut && !aborted && result.state === "aborted") {
          return { ...result, state: "timeout" as const, settled: false }
        }
        // After an early permission return, sessions cancelled by our own
        // abort are still running from the orchestrator's point of view.
        if (earlyPermission && result.state === "aborted" && !timedOut && !aborted) {
          return { ...result, state: "running" as const, settled: false }
        }
        return result
      }
      return {
        sessionID: input.sessionIDs[index],
        state: timedOut ? "timeout" : aborted ? "aborted" : ("running" as const),
        elapsedMs: Date.now() - started,
        settled: false,
        ...(earlyPermission ? { error: "returned early on permission; call waitAll again" } : {}),
      } satisfies WaitOneResult
    })
    const anyTimeout = finalResults.some((result) => result.state === "timeout")
    const anyPermission = finalResults.some((result) => result.state === "permission")
    const anyRunning = finalResults.some((result) => result.state === "running")
    return {
      mode: "all",
      state: anyPermission
        ? "permission"
        : anyTimeout || timedOut
          ? "timeout"
          : aborted
            ? "aborted"
            : anyRunning
              ? "running"
              : "ok",
      results: finalResults,
      pending: finalResults
        .filter((result) => result.state === "running" || result.state === "permission")
        .map((result) => result.sessionID),
      elapsedMs: Date.now() - started,
      timedOut,
      aborted,
    }
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener("abort", onAbort)
  }
}

function gitOk(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.error && !result.timedOut
}

async function resolveCommit(
  deps: OrchestrationDeps,
  directory: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await deps.git(["rev-parse", "--verify", `${ref}^{commit}`], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  return gitOk(result) ? result.stdout.trim() : undefined
}

function statusPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3).trim()
      const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value
      return (renamed ?? value).replace(/^"|"$/g, "")
    })
}

const SECRET_PATH =
  /(^|\/)(\.env(\.|$)|[^/]+\.(pem|key|p12|pfx)$|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials|secrets?\.(json|ya?ml))$/i

const ARTIFACT_PATH =
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|target|vendor)\//i

function hasSecretPaths(paths: string[]): boolean {
  return paths.some((value) => SECRET_PATH.test(value.replace(/\\/g, "/")))
}

function secretPathsOf(paths: string[]): string[] {
  return [...new Set(paths.filter((value) => SECRET_PATH.test(value.replace(/\\/g, "/"))))]
    .slice(0, 20)
}

function hasArtifactPaths(paths: string[]): boolean {
  return paths.some((value) => ARTIFACT_PATH.test(value.replace(/\\/g, "/")))
}

const ARTIFACT_ROOTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "vendor",
])

/**
 * Pathspec exclusions keep generated trees out of the snapshot patch. The
 * candidate is still marked unsupported for apply; this only avoids storing
 * megabytes of build output that cannot be applied safely.
 */
function artifactExclusions(paths: string[]): string[] {
  const roots = new Set<string>()
  for (const value of paths) {
    const parts = value.replace(/\\/g, "/").split("/")
    const index = parts.findIndex((part) => ARTIFACT_ROOTS.has(part))
    if (index >= 0) roots.add(parts.slice(0, index + 1).join("/"))
  }
  return [...roots].slice(0, 20)
}

function patchSecretPaths(patch: string): string[] {
  return secretPathsOf(parsePatchFiles(patch).map((file) => file.file))
}

function strategyOf(record: { strategy: WorktreeStrategy } | undefined): WorktreeStrategy {
  return record?.strategy ?? "unknown"
}

function pick<T>(values: T[] | undefined, index: number): T | undefined {
  if (!values?.length) return undefined
  return values[index % values.length]
}

function candidateApplyStrategy(
  candidate: CandidateRecord,
  options: BridgeOptions,
): "cherry-pick" | "patch" | "none" {
  if (candidate.unsupported) return "none"
  if (candidate.commit && candidate.strategy === "worktree") return "cherry-pick"
  if (candidate.patchFile || (candidate.patch && candidate.diffComplete)) return "patch"
  if (candidate.commit) return "cherry-pick"
  if (options.allowApplyCandidates && candidate.patch) return "patch"
  return "none"
}

async function capturePatch(
  deps: OrchestrationDeps,
  directory: string,
  commit: string | undefined,
  base: string | undefined,
  signal: AbortSignal,
  exclude: string[] = [],
): Promise<{ patch: string; source: CandidateRecord["snapshotSource"]; complete: boolean }> {
  const excludeSpecs = exclude.map((entry) => `:(exclude)${entry}`)
  if (commit && base) {
    const result = await deps.git(
      [
        "diff",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        `${base}..${commit}`,
        "--",
        ".",
        ...excludeSpecs,
      ],
      directory,
      { timeoutMs: deps.options.gitTimeoutMs, signal, maxBuffer: HARD_PATCH_LIMIT * 2 },
    )
    if (gitOk(result)) {
      return { patch: result.stdout, source: "git-commit", complete: !result.stdoutTruncated }
    }
  }

  // Intent-to-add makes untracked files visible to `git diff` without
  // committing them. The reset only clears the index flag.
  const add = await deps.git(["add", "-N", "--", ".", ...excludeSpecs], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (!gitOk(add)) {
    return { patch: "", source: "none", complete: false }
  }
  try {
    const result = await deps.git(
      ["diff", "--binary", "--no-color", "--no-ext-diff", "--", ".", ...excludeSpecs],
      directory,
      { timeoutMs: deps.options.gitTimeoutMs, signal, maxBuffer: HARD_PATCH_LIMIT * 2 },
    )
    if (gitOk(result)) {
      return { patch: result.stdout, source: "git-patch", complete: !result.stdoutTruncated }
    }
  } finally {
    await deps.git(["reset", "--", "."], directory, {
      timeoutMs: deps.options.gitTimeoutMs,
      signal,
    }).catch(() => undefined)
  }

  if (typeof deps.ctx.vcs?.diff === "function") {
    try {
      const result = await deps.ctx.vcs.diff(
        {
          location: { directory },
          mode: "working",
          ...(base ? { base } : {}),
          context: 3,
          untracked: "files",
        },
        { signal },
      )
      const files = Array.isArray(result?.data) ? result.data : []
      return {
        patch: files.map((file) => file.patch ?? "").join("\n"),
        source: "vcs",
        complete: false,
      }
    } catch {
      // Fall through.
    }
  }
  return { patch: "", source: "none", complete: false }
}

async function changedPaths(
  deps: OrchestrationDeps,
  directory: string,
  base: string | undefined,
  commit: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  if (!commit || !base || commit === base) return []
  const result = await deps.git(
    ["diff", "--name-only", "--no-color", `${base}..${commit}`],
    directory,
    { timeoutMs: deps.options.gitTimeoutMs, signal },
  )
  if (!gitOk(result)) return []
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

async function snapshotCandidate(
  deps: OrchestrationDeps,
  race: RaceRecord,
  candidate: CandidateRecord,
  input: { snapshot: SnapshotMode; maxDiffBytes: number },
  signal: AbortSignal,
): Promise<CandidateRecord> {
  const directory = candidate.directory
  const status = await deps.git(["status", "--porcelain=v1"], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  const dirty = gitOk(status) && status.stdout.trim().length > 0
  const paths = gitOk(status) ? statusPaths(status.stdout) : []
  const base = race.base
  let commit: string | undefined
  let branch: string | undefined
  let patch = ""
  let source: CandidateRecord["snapshotSource"] = "none"
  let complete = false

  const branchResult = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (gitOk(branchResult)) {
    const value = branchResult.stdout.trim()
    if (value && value !== "HEAD") branch = value
  }

  const unsafeSecrets = secretPathsOf(paths)
  let artifacts = hasArtifactPaths(paths)
  const wantCommit =
    (input.snapshot === "commit" ||
      (input.snapshot === "auto" && deps.options.allowSnapshotCommits)) &&
    !artifacts

  // Never capture, persist, or apply a snapshot that contains a secret file.
  // The worker's tree and commit are left untouched for manual review.
  const markUnsupported = (secrets: string[]): CandidateRecord => {
    candidate.commit = commit
    candidate.branch = branch
    candidate.base = base
    candidate.patch = undefined
    candidate.patchFile = undefined
    candidate.patchBytes = 0
    candidate.diffComplete = false
    candidate.snapshotSource = "none"
    candidate.files = []
    candidate.diffStats = { files: 0, additions: 0, deletions: 0 }
    candidate.testFilesChanged = false
    candidate.ciFilesChanged = false
    candidate.skippedTests = false
    candidate.unsupported = true
    candidate.secretPaths = secrets
    candidate.verification = "unknown"
    candidate.strategy = strategyOf(worktreeFor(deps.worktrees, candidate.directory))
    candidate.applyStrategy = "none"
    return candidate
  }

  if (unsafeSecrets.length) {
    commit = await resolveCommit(deps, directory, "HEAD", signal)
    return markUnsupported(unsafeSecrets)
  }

  if (dirty && wantCommit) {
    const add = await deps.git(["add", "-A", "--", "."], directory, {
      timeoutMs: deps.options.gitTimeoutMs,
      signal,
    })
    if (gitOk(add)) {
      const message = `session-bridge snapshot ${race.raceID} ${candidate.candidateID}`
      const committed = await deps.git(
        [
          "-c",
          "user.name=session-bridge",
          "-c",
          "user.email=session-bridge@localhost",
          "commit",
          "--no-verify",
          "-m",
          message,
        ],
        directory,
        { timeoutMs: deps.options.gitTimeoutMs, signal },
      )
      if (gitOk(committed)) commit = await resolveCommit(deps, directory, "HEAD", signal)
    }
  }

  if (!commit) {
    commit = await resolveCommit(deps, directory, "HEAD", signal)
  }

  const committedPaths =
    commit && base && commit !== base ? await changedPaths(deps, directory, base, commit, signal) : []
  const committedSecrets = secretPathsOf(committedPaths)
  if (committedSecrets.length) {
    return markUnsupported(committedSecrets)
  }
  const changed = [...new Set([...committedPaths, ...paths])]
  artifacts ||= hasArtifactPaths(changed)
  const exclude = artifactExclusions(changed)

  if (dirty || (commit && base && commit !== base)) {
    const captured = await capturePatch(
      deps,
      directory,
      commit && base && commit !== base ? commit : undefined,
      base,
      signal,
      exclude,
    )
    patch = captured.patch
    source = captured.source
    complete = captured.complete
  }

  const capturedSecrets = patchSecretPaths(patch)
  if (capturedSecrets.length) {
    return markUnsupported(capturedSecrets)
  }

  const fallbackFiles: VcsFileDiff[] = []
  if (!patch && typeof deps.ctx.vcs?.diff === "function") {
    try {
      const result = await deps.ctx.vcs.diff(
        {
          location: { directory },
          mode: "working",
          ...(base ? { base } : {}),
          context: 3,
          untracked: "files",
        },
        { signal },
      )
      for (const file of result?.data ?? []) {
        if (hasSecretPaths([file.file])) continue
        if (hasArtifactPaths([file.file])) continue
        fallbackFiles.push({
          file: file.file,
          patch: file.patch ?? "",
          additions: file.additions,
          deletions: file.deletions,
          status: file.status,
          ...(file.more ? { more: true as const } : {}),
        })
      }
    } catch {
      // Diff is best effort; the candidate still reports its state.
    }
  }
  const files = fallbackFiles.length ? fallbackFiles : parsePatchFiles(patch)
  const analysis = analyzeDiffs(files, patch, input.maxDiffBytes)
  const patchBytes = Buffer.byteLength(patch, "utf8")
  let patchFile: string | undefined
  let storedPatch: string | undefined = patch
  if (patchBytes > HARD_PATCH_LIMIT) {
    try {
      patchFile = await writePatchFile(race.raceID, candidate.candidateID, patch)
      storedPatch = undefined
    } catch {
      complete = false
      storedPatch = patch.slice(0, HARD_PATCH_LIMIT)
    }
  }

  const testsSkipped = !candidate.tests || candidate.tests.skipped
  candidate.commit = commit
  candidate.branch = branch
  candidate.base = base
  candidate.patch = storedPatch
  candidate.patchFile = patchFile
  candidate.patchBytes = patchBytes
  candidate.diffComplete = complete
  candidate.snapshotSource = source
  candidate.files = analysis.files
  candidate.diffStats = analysis.diffStats
  candidate.testFilesChanged = analysis.testFilesChanged
  candidate.ciFilesChanged = analysis.ciFilesChanged
  candidate.skippedTests = analysis.skippedTests
  candidate.unsupported = analysis.unsupported || artifacts
  candidate.verification = verificationFor({
    testsSkipped,
    testsPassed: candidate.tests?.passed,
    testFilesChanged: analysis.testFilesChanged,
    ciFilesChanged: analysis.ciFilesChanged,
    skippedTests: analysis.skippedTests,
    allowTestChanges: deps.options.allowTestChanges,
  })
  candidate.strategy = strategyOf(worktreeFor(deps.worktrees, candidate.directory))
  candidate.applyStrategy = candidateApplyStrategy(candidate, deps.options)
  if (race.mode === "same-directory") {
    // Several sessions shared one working tree, so the captured diff is not
    // attributable to a single candidate. Keep it for review but never apply
    // it automatically.
    candidate.diffComplete = false
    candidate.applyStrategy = "none"
  }
  return candidate
}

function commandSummary(
  result: CommandResult,
  command: string,
  maxChars: number,
): CommandSummary {
  return {
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncateCodePoints(result.stdout, maxChars, "…"),
    stderr: truncateCodePoints(result.stderr, maxChars, "…"),
    stdoutTruncated: result.stdoutTruncated || codePointLength(result.stdout) > maxChars,
    stderrTruncated: result.stderrTruncated || codePointLength(result.stderr) > maxChars,
    ...(result.envSkipped.length ? { envSkipped: result.envSkipped } : {}),
    ...(result.error ? { reason: result.error } : {}),
  }
}

async function runCandidateTests(
  deps: OrchestrationDeps,
  candidate: CandidateRecord,
  input: {
    testCommand?: string
    setupCommand?: string
    teardownCommand?: string
    env?: Record<string, string>
    cwd?: string
    timeoutMs: number
    maxOutputChars: number
  },
  signal: AbortSignal,
): Promise<CandidateTests> {
  if (!input.testCommand) {
    return { skipped: true, reason: "no testCommand was provided" }
  }
  if (!deps.options.allowTestCommands) {
    return {
      skipped: true,
      reason: "test commands are disabled; enable allowTestCommands: true",
    }
  }
  const parsedTest = parseCommand(input.testCommand)
  if (!parsedTest.ok) {
    return { skipped: true, reason: parsedTest.error }
  }
  if (input.setupCommand) {
    const parsedSetup = parseCommand(input.setupCommand)
    if (!parsedSetup.ok) {
      return { skipped: true, reason: `setupCommand: ${parsedSetup.error}` }
    }
  }
  if (input.teardownCommand) {
    const parsedTeardown = parseCommand(input.teardownCommand)
    if (!parsedTeardown.ok) {
      return { skipped: true, reason: `teardownCommand: ${parsedTeardown.error}` }
    }
  }
  const maxChars = input.maxOutputChars
  let cwd = candidate.directory
  if (input.cwd) {
    const resolved = path.resolve(candidate.directory, input.cwd)
    if (!isPathInside(resolved, candidate.directory)) {
      return { skipped: true, reason: "cwd escapes the candidate worktree" }
    }
    cwd = resolved
  }

  const setup = input.setupCommand
    ? await runCommand(input.setupCommand, {
        cwd,
        timeoutMs: input.timeoutMs,
        maxBuffer: maxChars,
        env: input.env,
        signal,
      })
    : undefined
  if (setup && (!gitOk(setup) || setup.error)) {
    return {
      skipped: false,
      passed: false,
      reason: "setupCommand failed",
      setup: commandSummary(setup, input.setupCommand ?? "", maxChars),
      ...(setup.envSkipped.length ? { envSkipped: setup.envSkipped } : {}),
    }
  }

  const test = await runCommand(input.testCommand, {
    cwd,
    timeoutMs: input.timeoutMs,
    maxBuffer: maxChars,
    env: input.env,
    signal,
  })
  const teardown = input.teardownCommand
    ? await runCommand(input.teardownCommand, {
        cwd,
        timeoutMs: input.timeoutMs,
        maxBuffer: maxChars,
        env: input.env,
        signal,
      })
    : undefined

  if (test.error && /not found|enoent/i.test(test.error)) {
    return {
      skipped: true,
      reason: `test command is not available: ${test.error}`,
      command: input.testCommand,
      ...(teardown
        ? { teardown: commandSummary(teardown, input.teardownCommand ?? "", maxChars) }
        : {}),
    }
  }

  return {
    skipped: false,
    passed: gitOk(test),
    exitCode: test.exitCode,
    timedOut: test.timedOut,
    durationMs: test.durationMs,
    command: input.testCommand,
    stdout: truncateCodePoints(test.stdout, maxChars, "…"),
    stderr: truncateCodePoints(test.stderr, maxChars, "…"),
    stdoutTruncated: test.stdoutTruncated || codePointLength(test.stdout) > maxChars,
    stderrTruncated: test.stderrTruncated || codePointLength(test.stderr) > maxChars,
    ...(setup ? { setup: commandSummary(setup, input.setupCommand ?? "", maxChars) } : {}),
    ...(teardown
      ? { teardown: commandSummary(teardown, input.teardownCommand ?? "", maxChars) }
      : {}),
    ...(test.envSkipped.length ? { envSkipped: test.envSkipped } : {}),
  }
}

export type WorkerPermissionRule = {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

const WORKER_PROTECTED_ACTIONS = [
  "session_bridge.open",
  "session_bridge.send",
  "session_bridge.reply",
  "session_bridge.interrupt",
  "session_bridge.update",
  "session_bridge.remove",
  "session_bridge.list",
  "session_bridge.read",
  "session_bridge.status",
  "session_bridge.wait",
  "session_bridge.waitAny",
  "session_bridge.waitAll",
  "session_bridge.permissions",
  "session_bridge.language",
  "session_bridge.compact",
  "session_bridge.diagnostics",
  "session_bridge.worktrees",
  "session_bridge.race",
  "session_bridge.bestOf",
  "session_bridge.applyCandidate",
  "session_bridge.apply",
  "session_bridge.push",
  "session_bridge.raceStatus",
  "session_bridge.raceList",
  "session_bridge.raceCleanup",
]

const WORKER_PROTECTED_RESOURCES = [
  "*git push*",
  "*git worktree*",
  "*git checkout*",
  "*git switch*",
  "*--force*",
]

/** Caller-provided allow rules must never widen the worker preset. */
function isProtectedAllowRule(rule: WorkerPermissionRule): boolean {
  if (rule.effect !== "allow") return false
  if (rule.action === "external_directory") return true
  if (rule.action.startsWith("session_bridge.")) return true
  return WORKER_PROTECTED_RESOURCES.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
    return new RegExp(`^${escaped}$`, "i").test(rule.resource)
  })
}

export function workerPermissionRules(
  options: BridgeOptions,
  inputPermissions?: WorkerPermissionRule[],
): WorkerPermissionRule[] {
  const denials: WorkerPermissionRule[] = []
  for (const action of WORKER_PROTECTED_ACTIONS) {
    denials.push({ action, resource: "*", effect: "deny" })
  }
  for (const resource of WORKER_PROTECTED_RESOURCES) {
    denials.push({ action: "shell", resource, effect: "deny" })
  }
  denials.push({ action: "external_directory", resource: "*", effect: "deny" })
  const extra = (inputPermissions ?? []).filter(
    (rule) => options.allowPermissionRules || rule.effect !== "allow",
  )
  // OpenCode evaluates rules in order and the last matching rule wins.
  // Denials must therefore be appended after every caller rule.
  return [...extra.filter((rule) => !isProtectedAllowRule(rule)), ...denials]
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

export type RaceRunResult = {
  race: RaceRecord
  ranking?: ReturnType<typeof rankCandidates>
}

export async function runRace(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  input: RaceInput,
  signal: AbortSignal,
): Promise<RaceRunResult> {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })
  const startedAt = Date.now()
  const deadline = startedAt + input.timeoutMs
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("race wall clock exceeded", "TimeoutError"))
  }, Math.max(1, input.timeoutMs))
  const handle = timer as unknown as { unref?: () => void }
  if (typeof handle.unref === "function") handle.unref()
  try {
    return await runRaceBody(
      deps,
      context,
      input,
      controller.signal,
      deadline,
      () => timedOut,
      () => signal.aborted,
    )
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

async function runRaceBody(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  input: RaceInput,
  signal: AbortSignal,
  deadline: number,
  timedOut: () => boolean,
  callerAborted: () => boolean,
): Promise<RaceRunResult> {
  const targetDirectory = deps.ctx.location?.directory
  if (!targetDirectory) throw new Error("ctx.location.directory is not available")
  const raceID = input.runID ?? createRaceID()
  if (deps.races.has(raceID)) {
    throw new Error(`raceID already exists: ${raceID}`)
  }
  const base = await resolveCommit(deps, targetDirectory, input.base ?? "HEAD", signal)
  if (!base) {
    throw new Error(`base ref is not a commit: ${input.base ?? "HEAD"}`)
  }

  if (input.mode === "worktrees" && !deps.ctx.worktree?.create) {
    throw new Error(
      "worktrees mode requires ctx.worktree; use mode: same-directory or update the host",
    )
  }

  const race: RaceRecord = {
    raceID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(deps.ctx.location?.project?.id
      ? { projectID: String(deps.ctx.location.project.id) }
      : {}),
    targetDirectory,
    mode: input.mode,
    prompt: input.prompt,
    base,
    keepWorktrees: input.keepWorktrees,
    status: "running",
    candidates: [],
    worktrees: [],
    ...(context.sessionID ? { ownerSessionID: context.sessionID } : {}),
    ownerDirectory: targetDirectory,
  }
  await rememberRace(deps.ctx, deps.races, race)

  if (context.sessionID) {
    await rememberOwnedSession(
      deps.ctx,
      deps.ownedSessions,
      context.sessionID,
      targetDirectory,
      {
        runID: raceID,
        role: "orchestrator",
        ownerDirectory: targetDirectory,
        targetDirectory,
      },
    )
  }

  let worktrees: Awaited<ReturnType<typeof createWorktrees>> = []
  let candidates: CandidateRecord[] = []
  try {
    if (input.mode === "worktrees") {
      worktrees = await createWorktrees(
        {
          ctx: deps.ctx,
          options: deps.options,
          worktrees: deps.worktrees,
          git: deps.git,
          liveState: deps.liveState,
        },
        {
          count: input.count,
          base,
          namePrefix: "race",
          branch: base,
        },
        {
          runID: raceID,
          ...(context.sessionID ? { ownerSessionID: context.sessionID } : {}),
          ownerDirectory: targetDirectory,
        },
        signal,
      )
      race.worktrees = worktrees.map((record) => record.directory)
    }

    const caller = context.sessionID
      ? await deps.ctx.session.get({ sessionID: context.sessionID }, { signal }).catch(() => undefined)
      : undefined
    const permissions = workerPermissionRules(deps.options, input.permissions)
    candidates = []
    for (let index = 0; index < input.count; index++) {
      const directory = worktrees[index]?.directory ?? targetDirectory
      const messageID = `${raceID}:${index + 1}`
      const agent = pick(input.agents, index) ?? caller?.agent ?? "build"
      const model =
        parseModel(pick(input.models, index)) ??
        (caller?.model
          ? {
              providerID: caller.model.providerID,
              id: caller.model.id,
              ...(caller.model.variant ? { variant: caller.model.variant } : {}),
            }
          : undefined)
      const candidate: CandidateRecord = {
        candidateID: `candidate-${index + 1}`,
        index,
        messageID,
        directory,
        strategy: strategyOf(worktrees[index]),
        base,
        state: "running",
        elapsedMs: 0,
        diffStats: { files: 0, additions: 0, deletions: 0 },
        files: [],
        patchBytes: 0,
        diffComplete: false,
        snapshotSource: "none",
        testFilesChanged: false,
        ciFilesChanged: false,
        skippedTests: false,
        verification: "unknown",
        applyStrategy: "none",
      }
      if (signal.aborted || Date.now() >= deadline) {
        candidate.state = timedOut() ? "timeout" : "aborted"
        candidate.error = timedOut()
          ? "race wall clock exceeded before this candidate started"
          : "race aborted before this candidate started"
        candidate.verification = "unknown"
        candidate.applyStrategy = "none"
        candidates.push(candidate)
        continue
      }
      try {
        const created = await withRequest(signal, deps.options.requestTimeoutMs, (request) =>
          deps.ctx.session.create(
            {
              title: `Race ${raceID} candidate ${index + 1}`,
              agent,
              ...(model ? { model } : {}),
              location: { directory },
              permissions,
            },
            { signal: request },
          ),
        )
        const verified = await withRequest(signal, deps.options.requestTimeoutMs, (request) =>
          deps.ctx.session.get({ sessionID: created.id }, { signal: request }),
        )
        if (
          verified.location?.directory &&
          !sameDirectory(verified.location.directory, directory)
        ) {
          await deps.ctx.session
            .remove({ sessionID: created.id }, { signal })
            .catch(() => undefined)
          throw new Error(
            `session was created in ${verified.location.directory}, expected ${directory}`,
          )
        }
        candidate.sessionID = created.id
        await rememberOwnedSession(
          deps.ctx,
          deps.ownedSessions,
          created.id,
          directory,
          {
            ownerSessionID: context.sessionID,
            runID: raceID,
            ownerDirectory: targetDirectory,
            targetDirectory: directory,
            role: "worker",
          },
        )
        await rememberWorkerSession(deps.ctx, deps.workerSessions, {
          sessionID: created.id,
          targetDirectory: directory,
          ...(context.sessionID ? { ownerSessionID: context.sessionID } : {}),
          runID: raceID,
          ownerDirectory: targetDirectory,
        })
        deps.registry?.rememberOpen(messageID, created.id, directory, {
          ...(context.sessionID ? { ownerSessionID: context.sessionID } : {}),
          runID: raceID,
          targetDirectory: directory,
        })
        if (!deps.registry) {
          await rememberOpenSession(deps.ctx, deps.openSessions, messageID, created.id, directory, {
            ...(context.sessionID ? { ownerSessionID: context.sessionID } : {}),
            runID: raceID,
            targetDirectory: directory,
          })
        }
        await attachAndPersistSession(deps.ctx, deps.worktrees, directory, created.id)
        if (worktrees[index]) {
          race.worktrees = [...new Set([...race.worktrees, directory])]
        }
        const admitted = await withRequest(signal, deps.options.requestTimeoutMs, (request) =>
          deps.ctx.session.prompt(
            {
              sessionID: created.id,
              text: input.prompt,
              id: promptMessageID(messageID, `race:${raceID}:${index + 1}`),
              delivery: "steer",
            },
            { signal: request },
          ),
        )
        candidate.messageID = admitted.id
        candidate.state = "running"
      } catch (error) {
        candidate.state = signal.aborted
          ? timedOut()
            ? "timeout"
            : "aborted"
          : "error"
        candidate.error = formatError(error)
      }
      candidates.push(candidate)
    }
    race.candidates = candidates
    await rememberRace(deps.ctx, deps.races, race)

    await runWithConcurrency(candidates, deps.options.maxConcurrentSessions, async (candidate) => {
      if (!candidate.sessionID || candidate.state === "error") return
      if (signal.aborted || Date.now() >= deadline) {
        candidate.state = timedOut() ? "timeout" : "aborted"
        candidate.error = timedOut()
          ? "race wall clock exceeded while waiting for this candidate"
          : "race aborted while waiting for this candidate"
        return
      }
      const remaining = Math.max(1, deadline - Date.now())
      const result = await waitOne(
        deps,
        context,
        candidate.sessionID,
        candidate.messageID,
        remaining,
        signal,
      )
      candidate.state = result.state
      candidate.outcome = result.outcome
      candidate.elapsedMs = result.elapsedMs
      candidate.error = result.error
      candidate.text = result.text
      candidate.retry = result.retry
      candidate.pendingPermissions = result.pendingPermissions
      candidate.background = result.background
    })
    race.candidates = candidates
    await rememberRace(deps.ctx, deps.races, race)

    for (const candidate of candidates) {
      if (!candidate.sessionID) continue
      if (signal.aborted || Date.now() >= deadline) break
      try {
        const info = await deps.ctx.session.get({ sessionID: candidate.sessionID }, { signal })
        candidate.cost = info.cost as unknown as RaceRecord["candidates"][number]["cost"]
        candidate.tokens = info.tokens as unknown as RaceRecord["candidates"][number]["tokens"]
      } catch {
        // Cost/tokens are informational; a missing read must not fail the race.
      }
    }

    // Snapshot each candidate before running any tests. The diff is the
    // authoritative artifact for apply; the display stays bounded. A failed,
    // timed-out, or permission-blocked candidate is not a finished tree and
    // must not be committed or offered for apply.
    for (const candidate of candidates) {
      if (!candidate.sessionID || candidate.state !== "idle") continue
      if (signal.aborted || Date.now() >= deadline) {
        candidate.state = timedOut() ? "timeout" : "aborted"
        candidate.error = timedOut()
          ? "race wall clock exceeded before snapshot"
          : "race aborted before snapshot"
        candidate.diffComplete = false
        candidate.applyStrategy = "none"
        continue
      }
      try {
        await snapshotCandidate(
          deps,
          race,
          candidate,
          { snapshot: input.snapshot, maxDiffBytes: input.maxDiffBytes },
          signal,
        )
      } catch (error) {
        candidate.error = formatError(error)
        candidate.diffComplete = false
        candidate.applyStrategy = "none"
      }
    }

    // E2E commands are serialized across candidates to avoid port/DB clashes.
    for (const candidate of candidates) {
      if (!candidate.sessionID || candidate.state !== "idle") continue
      if (signal.aborted) {
        candidate.tests = {
          skipped: true,
          reason: timedOut() ? "race wall clock exceeded" : "race aborted",
        }
        candidate.verification = "unknown"
        candidate.applyStrategy = candidateApplyStrategy(candidate, deps.options)
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        candidate.tests = { skipped: true, reason: "race wall clock exceeded" }
        candidate.verification = "unknown"
        candidate.applyStrategy = candidateApplyStrategy(candidate, deps.options)
        continue
      }
      candidate.tests = await runCandidateTests(
        deps,
        candidate,
        {
          testCommand: input.testCommand,
          setupCommand: input.setupCommand,
          teardownCommand: input.teardownCommand,
          env: input.env,
          cwd: input.cwd,
          timeoutMs: Math.min(input.testTimeoutMs, remaining),
          maxOutputChars: input.maxTestOutputChars,
        },
        signal,
      )
      candidate.verification = verificationFor({
        testsSkipped: candidate.tests.skipped,
        testsPassed: candidate.tests.passed,
        testFilesChanged: candidate.testFilesChanged,
        ciFilesChanged: candidate.ciFilesChanged,
        skippedTests: candidate.skippedTests,
        allowTestChanges: deps.options.allowTestChanges,
      })
      candidate.applyStrategy = candidateApplyStrategy(candidate, deps.options)
    }

    race.candidates = candidates
    const idle = candidates.filter((candidate) => candidate.state === "idle").length
    race.status = idle === candidates.length ? "completed" : idle > 0 ? "partial" : "failed"
    race.updatedAt = Date.now()
    await rememberRace(deps.ctx, deps.races, race)

    if (!input.keepWorktrees && race.worktrees.length) {
      const cleanupController = new AbortController()
      const removed = await removeWorktrees(
        {
          ctx: deps.ctx,
          options: deps.options,
          worktrees: deps.worktrees,
          git: deps.git,
          liveState: deps.liveState,
        },
        race.worktrees,
        { force: false, archiveSessions: true },
        cleanupController.signal,
      )
      const cleanup: RaceCleanup = {
        at: Date.now(),
        removed: removed.filter((entry) => entry.removed).map((entry) => entry.directory),
        orphans: removed.filter((entry) => entry.orphan).map((entry) => entry.directory),
        kept: removed
          .filter((entry) => !entry.removed && !entry.orphan)
          .map((entry) => entry.directory),
      }
      race.cleanup = cleanup
      await rememberRace(deps.ctx, deps.races, race)
    }

    const ranking = rankCandidates(candidates)
    return { race, ranking }
  } catch (error) {
    for (const candidate of candidates) {
      if (candidate.state !== "running") continue
      candidate.state = timedOut() ? "timeout" : "aborted"
      candidate.error ??= timedOut()
        ? "race wall clock exceeded"
        : "race aborted"
      candidate.verification = "unknown"
      candidate.applyStrategy = "none"
    }
    race.status = "failed"
    race.updatedAt = Date.now()
    race.candidates = candidates
    race.worktrees = [...deps.worktrees.values()]
      .filter((record) => record.runID === race.raceID && record.state !== "removed")
      .map((record) => record.directory)
    await rememberRace(deps.ctx, deps.races, race).catch(() => undefined)
    if (worktrees.length && !input.keepWorktrees) {
      const cleanup = new AbortController()
      await removeWorktrees(
        {
          ctx: deps.ctx,
          options: deps.options,
          worktrees: deps.worktrees,
          git: deps.git,
          liveState: deps.liveState,
        },
        worktrees.map((record) => record.directory),
        { force: false, archiveSessions: true },
        cleanup.signal,
      ).catch(() => undefined)
    }
    if (signal.aborted) {
      const idle = candidates.filter((candidate) => candidate.state === "idle").length
      race.status = idle === candidates.length ? "completed" : idle > 0 ? "partial" : "failed"
      race.updatedAt = Date.now()
      await rememberRace(deps.ctx, deps.races, race).catch(() => undefined)
      return { race, ranking: rankCandidates(candidates) }
    }
    throw error
  }
}

export type ApplyVerification = {
  command?: string
  skipped?: boolean
  passed?: boolean
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  stdout?: string
  stderr?: string
  reason?: string
}

export type ApplyResult = {
  state: "ok" | "error"
  applied: boolean
  alreadyApplied: boolean
  dryRun: boolean
  strategy: "apply" | "cherry-pick"
  targetDirectory: string
  integrationDirectory?: string
  base?: string
  backup?: string
  commit?: string
  pushed?: boolean
  pushError?: string
  verification?: ApplyVerification
  reason?: string
  error?: string
}

const APPLY_LOCKS = new Set<string>()

async function inProgressOperation(gitDir: string): Promise<string | undefined> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    try {
      await access(path.join(gitDir, name))
      return name
    } catch {
      // Not in progress.
    }
  }
  return undefined
}

async function targetIsClean(
  deps: OrchestrationDeps,
  directory: string,
  signal: AbortSignal,
): Promise<{ clean: boolean; reason?: string }> {
  const status = await deps.git(["status", "--porcelain=v1"], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (!gitOk(status)) {
    return { clean: false, reason: status.stderr.trim() || "git status failed" }
  }
  if (status.stdout.trim()) {
    return { clean: false, reason: "target has uncommitted or untracked changes" }
  }
  const gitDir = await resolveGitDir(directory)
  if (!gitDir) return { clean: false, reason: "target is not a git worktree" }
  const operation = await inProgressOperation(gitDir)
  if (operation) {
    return { clean: false, reason: `target has an operation in progress: ${operation}` }
  }
  return { clean: true }
}

async function applyCommitOrPatch(
  deps: OrchestrationDeps,
  directory: string,
  input: { strategy: "apply" | "cherry-pick"; commit?: string; patch?: string; patchFile?: string },
  signal: AbortSignal,
): Promise<{ ok: boolean; reason?: string; patchFile?: string }> {
  if (input.strategy === "cherry-pick") {
    if (!input.commit) return { ok: false, reason: "cherry-pick requires a candidate commit" }
    const picked = await deps.git(["cherry-pick", "-n", input.commit], directory, {
      timeoutMs: deps.options.gitTimeoutMs,
      signal,
    })
    if (gitOk(picked)) return { ok: true }
    await deps.git(["cherry-pick", "--abort"], directory, {
      timeoutMs: deps.options.gitTimeoutMs,
      signal,
    }).catch(() => undefined)
    return {
      ok: false,
      reason: picked.stderr.trim() || picked.stdout.trim() || "cherry-pick failed",
    }
  }

  let patchFile = input.patchFile
  if (!patchFile) {
    if (!input.patch) return { ok: false, reason: "candidate has no complete patch" }
    patchFile = path.join(
      tmpdir(),
      `session-bridge-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
    )
    await writeFile(patchFile, input.patch, "utf8")
  }
  const check = await deps.git(["apply", "--check", "--binary", patchFile], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (!gitOk(check)) {
    return { ok: false, reason: check.stderr.trim() || "git apply --check failed", patchFile }
  }
  const applied = await deps.git(["apply", "--index", "--binary", patchFile], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (!gitOk(applied)) {
    return { ok: false, reason: applied.stderr.trim() || "git apply failed", patchFile }
  }
  return { ok: true, patchFile }
}

async function isAlreadyApplied(
  deps: OrchestrationDeps,
  directory: string,
  candidate: CandidateRecord,
  strategy: "apply" | "cherry-pick",
  signal: AbortSignal,
): Promise<boolean> {
  if (strategy === "cherry-pick" && candidate.commit) {
    const result = await deps.git(
      ["merge-base", "--is-ancestor", candidate.commit, "HEAD"],
      directory,
      { timeoutMs: deps.options.gitTimeoutMs, signal },
    )
    if (gitOk(result)) return true
  }
  if (candidate.patchFile || candidate.patch) {
    let patchFile = candidate.patchFile
    if (!patchFile && candidate.patch) {
      patchFile = path.join(
        tmpdir(),
        `session-bridge-check-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
      )
      await writeFile(patchFile, candidate.patch, "utf8")
    }
    if (patchFile) {
      const result = await deps.git(
        ["apply", "--reverse", "--check", "--binary", patchFile],
        directory,
        { timeoutMs: deps.options.gitTimeoutMs, signal },
      )
      if (gitOk(result)) return true
    }
  }
  return false
}

async function rollbackTarget(
  deps: OrchestrationDeps,
  directory: string,
  backup: string,
  before: string[],
  signal: AbortSignal,
): Promise<void> {
  await deps.git(["reset", "--hard", backup], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  }).catch(() => undefined)
  const after = await deps.git(["status", "--porcelain=v1"], directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  }).catch(() => undefined)
  if (!after || !gitOk(after)) return
  const known = new Set(before)
  for (const file of statusPaths(after.stdout)) {
    if (known.has(file)) continue
    if (!isPathInside(path.resolve(directory, file), directory)) continue
    await rm(path.resolve(directory, file), { recursive: true, force: true }).catch(() => undefined)
  }
}

async function createIntegrationWorktree(
  deps: OrchestrationDeps,
  raceID: string,
  base: string,
  signal: AbortSignal,
): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const ctx = deps.ctx
  if (typeof ctx.worktree?.create === "function") {
    const projectID = String(ctx.location?.project?.id ?? "")
    if (projectID) {
      try {
        const created = await ctx.worktree.create(
          {
            projectID,
            name: `apply-${safePatchSegment(raceID)}`.slice(0, 64),
            branch: base,
          },
          { signal },
        )
        return {
          directory: created.directory,
          cleanup: async () => {
            await ctx.worktree
              .remove({ projectID, directory: created.directory, force: true }, { signal })
              .catch(() => undefined)
          },
        }
      } catch {
        // Fall through to the temporary git worktree when allowed.
      }
    }
  }

  // Fallback: a detached git worktree in the temp directory. This branch is
  // only reached when the host has no worktree API and the user opted into
  // worktree management.
  if (!deps.options.allowWorktreeManagement) {
    throw new Error(
      "could not create an integration worktree; enable allowWorktreeManagement to use a temporary git worktree",
    )
  }
  const directory = await mkdtemp(path.join(tmpdir(), "session-bridge-apply-"))
  const added = await deps.git(["worktree", "add", "--detach", directory, base], deps.ctx.location.directory, {
    timeoutMs: deps.options.gitTimeoutMs,
    signal,
  })
  if (!gitOk(added)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(added.stderr.trim() || "git worktree add failed")
  }
  return {
    directory,
    cleanup: async () => {
      await deps.git(["worktree", "remove", "--force", directory], deps.ctx.location.directory, {
        timeoutMs: deps.options.gitTimeoutMs,
        signal,
      }).catch(() => undefined)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export function canManageRace(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  race: RaceRecord,
): boolean {
  if (!race.ownerSessionID) return true
  if (race.ownerSessionID === context.sessionID) return true
  const caller = deps.ownedSessions.get(context.sessionID)
  return caller?.runID === race.raceID && caller.role === "orchestrator"
}

export async function applyCandidate(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  input: {
    raceID: string
    candidateID: string
    targetDirectory?: string
    strategy: "apply" | "cherry-pick"
    verifyCommand?: string
    dryRun: boolean
    commit: boolean
    commitMessage?: string
    confirm: boolean
    push: boolean
  },
  signal: AbortSignal,
): Promise<ApplyResult> {
  const race = deps.races.get(input.raceID)
  if (!race) throw new Error(`race not found: ${input.raceID}`)
  if (!canManageRace(deps, context, race)) {
    throw new Error("race belongs to another session/run")
  }
  const candidate = candidateByID(race, input.candidateID)
  if (!candidate) throw new Error(`candidate not found: ${input.candidateID} in ${input.raceID}`)
  if (!input.confirm) throw new Error("confirm: true is required to apply a candidate")
  if (!deps.options.allowApplyCandidates) {
    throw new Error("allowApplyCandidates is false; enable it to apply a candidate")
  }
  if (input.verifyCommand) {
    if (!deps.options.allowTestCommands) {
      throw new Error(
        "verifyCommandDisabled: verifyCommand requires allowTestCommands: true",
      )
    }
    const parsed = parseCommand(input.verifyCommand)
    if (!parsed.ok) {
      throw new Error(`verifyCommand is invalid: ${parsed.error}`)
    }
  }
  await assertPermission(deps.ctx, context, "session_bridge.apply", [
    input.raceID,
    input.candidateID,
    input.targetDirectory ?? race.targetDirectory,
  ])
  if (input.push) {
    if (!deps.options.allowPushCandidates) {
      throw new Error("allowPushCandidates is false; push is disabled")
    }
    await assertPermission(deps.ctx, context, "session_bridge.push", [
      input.raceID,
      input.candidateID,
    ])
  }

  const targetDirectory = input.targetDirectory ?? race.targetDirectory
  const validation = await (deps.validateDirectory ?? validateTargetDirectory)(targetDirectory, {
    projectDirectory: deps.ctx.location?.project?.directory,
    projectCanonical: deps.ctx.location?.project?.canonical,
    registeredDirectories: registeredWorktreeDirectories(deps),
    allowWorktreeDirectories: deps.options.allowWorktreeDirectories,
  })
  if (!validation.ok) throw new Error(`targetDirectory is invalid: ${validation.error}`)
  const target = validation.realDirectory

  if (input.strategy === "cherry-pick" && !candidate.commit) {
    throw new Error("cherry-pick requires a candidate commit")
  }
  if (input.strategy === "apply" && !candidate.patchFile && !candidate.patch) {
    throw new Error("candidate has no patch to apply")
  }
  if (input.strategy === "apply" && !candidate.diffComplete) {
    throw new Error("candidate diff is incomplete; refusing to apply a partial patch")
  }
  if (candidate.unsupported) {
    throw new Error(
      "candidate contains binary/submodule/artifact changes that cannot be represented safely; inspect it manually",
    )
  }

  const lockKey = target.toLowerCase()
  if (APPLY_LOCKS.has(lockKey)) {
    throw new Error("another apply is already running for this target")
  }
  APPLY_LOCKS.add(lockKey)
  try {
    const clean = await targetIsClean(deps, target, signal)
    if (!clean.clean) throw new Error(clean.reason ?? "target is not clean")

    let integrationBase = race.base
    if (race.base) {
      const exists = await deps.git(
        ["cat-file", "-e", `${race.base}^{commit}`],
        target,
        { timeoutMs: deps.options.gitTimeoutMs, signal },
      )
      if (!gitOk(exists)) {
        if (input.strategy === "cherry-pick") {
          throw new Error(
            "the candidate commit/base is not present in the target repository; use strategy: apply with a patch",
          )
        }
        // A clone/copy candidate may come from another repository. Try the
        // patch against the target's current HEAD instead of the missing base.
        integrationBase = await resolveCommit(deps, target, "HEAD", signal)
      } else {
        const ancestor = await deps.git(
          ["merge-base", "--is-ancestor", race.base, "HEAD"],
          target,
          { timeoutMs: deps.options.gitTimeoutMs, signal },
        )
        if (!gitOk(ancestor)) {
          throw new Error("the race base is not an ancestor of the target branch")
        }
      }
    } else {
      integrationBase = await resolveCommit(deps, target, "HEAD", signal)
    }

    const beforeStatus = await deps.git(["status", "--porcelain=v1"], target, {
      timeoutMs: deps.options.gitTimeoutMs,
      signal,
    })
    const before = gitOk(beforeStatus) ? statusPaths(beforeStatus.stdout) : []

    if (await isAlreadyApplied(deps, target, candidate, input.strategy, signal)) {
      return {
        state: "ok",
        applied: false,
        alreadyApplied: true,
        dryRun: input.dryRun,
        strategy: input.strategy,
        targetDirectory: target,
        base: race.base,
        ...(candidate.commit ? { commit: candidate.commit } : {}),
        reason: "candidate is already applied",
      }
    }

    let integrationDirectory: string | undefined
    let integrationCleanup: (() => Promise<void>) | undefined
    let verification: ApplyVerification | undefined
    let patchFile = candidate.patchFile

    if (input.verifyCommand || input.dryRun) {
      if (!integrationBase) throw new Error("cannot create an integration worktree without a base commit")
      const integration = await createIntegrationWorktree(deps, race.raceID, integrationBase, signal)
      integrationDirectory = integration.directory
      integrationCleanup = integration.cleanup
      try {
        const applied = await applyCommitOrPatch(
          deps,
          integration.directory,
          {
            strategy: input.strategy,
            commit: candidate.commit,
            patch: candidate.patch,
            patchFile: candidate.patchFile,
          },
          signal,
        )
        patchFile = applied.patchFile ?? patchFile
        if (!applied.ok) {
          return {
            state: "error",
            applied: false,
            alreadyApplied: false,
            dryRun: input.dryRun,
            strategy: input.strategy,
            targetDirectory: target,
            integrationDirectory,
            base: race.base,
            reason: applied.reason ?? "apply check failed",
            error: applied.reason ?? "apply check failed",
          }
        }
        if (input.verifyCommand) {
          const result = await runCommand(input.verifyCommand, {
            cwd: integration.directory,
            timeoutMs: deps.options.gitTimeoutMs,
            maxBuffer: deps.options.maxTestOutputChars,
            signal,
          })
          verification = {
            command: input.verifyCommand,
            passed: gitOk(result),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdout: truncateCodePoints(result.stdout, deps.options.maxTestOutputChars, "…"),
            stderr: truncateCodePoints(result.stderr, deps.options.maxTestOutputChars, "…"),
            ...(result.error ? { reason: result.error } : {}),
          }
          if (!verification.passed) {
            return {
              state: "error",
              applied: false,
              alreadyApplied: false,
              dryRun: input.dryRun,
              strategy: input.strategy,
              targetDirectory: target,
              integrationDirectory,
              base: race.base,
              verification,
              reason: "verification failed in the integration worktree",
              error: "verification failed in the integration worktree",
            }
          }
        }
        if (input.dryRun) {
          return {
            state: "ok",
            applied: false,
            alreadyApplied: false,
            dryRun: true,
            strategy: input.strategy,
            targetDirectory: target,
            integrationDirectory,
            base: race.base,
            verification,
            reason: "dry run: target was not modified",
          }
        }
      } finally {
        await integrationCleanup?.()
      }
    }

    const backupName = `session-bridge/backup-${race.raceID}-${Date.now()}`.replace(
      /[^A-Za-z0-9/_-]+/g,
      "-",
    )
    const backup = await deps.git(["branch", backupName, "HEAD"], target, {
      timeoutMs: deps.options.gitTimeoutMs,
      signal,
    })
    if (!gitOk(backup)) {
      throw new Error(backup.stderr.trim() || "could not create a backup branch")
    }
    const applied = await applyCommitOrPatch(
      deps,
      target,
      {
        strategy: input.strategy,
        commit: candidate.commit,
        patch: candidate.patch,
        patchFile,
      },
      signal,
    )
    if (!applied.ok) {
      await rollbackTarget(deps, target, backupName, before, signal)
      return {
        state: "error",
        applied: false,
        alreadyApplied: false,
        dryRun: false,
        strategy: input.strategy,
        targetDirectory: target,
        integrationDirectory,
        base: race.base,
        backup: backupName,
        verification,
        reason: applied.reason ?? "apply failed",
        error: applied.reason ?? "apply failed",
      }
    }
    return finalizeApply(
      deps,
      target,
      race,
      candidate,
      input,
      before,
      patchFile,
      signal,
      { backup: backupName, integrationDirectory, verification },
    )
  } finally {
    APPLY_LOCKS.delete(lockKey)
  }
}

async function finalizeApply(
  deps: OrchestrationDeps,
  target: string,
  race: RaceRecord,
  candidate: CandidateRecord,
  input: {
    strategy: "apply" | "cherry-pick"
    commit: boolean
    commitMessage?: string
    push: boolean
    dryRun: boolean
  },
  before: string[],
  _patchFile: string | undefined,
  signal: AbortSignal,
  extra: {
    backup?: string
    integrationDirectory?: string
    verification?: ApplyVerification
  } = {},
): Promise<ApplyResult> {
  let commitHash: string | undefined
  if (input.commit) {
    const message =
      input.commitMessage ?? `session-bridge: apply ${race.raceID}/${candidate.candidateID}`
    const committed = await deps.git(
      [
        "-c",
        "user.name=session-bridge",
        "-c",
        "user.email=session-bridge@localhost",
        "commit",
        "--no-verify",
        "-m",
        message,
      ],
      target,
      { timeoutMs: deps.options.gitTimeoutMs, signal },
    )
    if (!gitOk(committed)) {
      if (extra.backup) await rollbackTarget(deps, target, extra.backup, before, signal)
      return {
        state: "error",
        applied: false,
        alreadyApplied: false,
        dryRun: false,
        strategy: input.strategy,
        targetDirectory: target,
        base: race.base,
        ...extra,
        reason: committed.stderr.trim() || "commit failed",
        error: committed.stderr.trim() || "commit failed",
      }
    }
    commitHash = (await resolveCommit(deps, target, "HEAD", signal)) ?? candidate.commit
  } else {
    commitHash = input.strategy === "cherry-pick" ? candidate.commit : undefined
  }

  let pushed: boolean | undefined
  let pushError: string | undefined
  if (input.push) {
    if (!input.commit) {
      pushError = "push requires commit: true; the target change is not committed"
    } else if (!deps.options.allowPushCandidates) {
      pushError = "allowPushCandidates is false"
    } else if (!commitHash) {
      pushError = "nothing to push: the change is not committed"
    } else {
      const result = await deps.git(["push"], target, {
        timeoutMs: deps.options.gitTimeoutMs,
        signal,
      })
      pushed = gitOk(result)
      if (!pushed) {
        pushError =
          result.stderr.trim() ||
          result.stdout.trim() ||
          "push rejected; fetch/rebase and re-run verification manually"
      }
    }
  }

  return {
    state: "ok",
    applied: true,
    alreadyApplied: false,
    dryRun: false,
    strategy: input.strategy,
    targetDirectory: target,
    base: race.base,
    ...extra,
    ...(commitHash ? { commit: commitHash } : {}),
    ...(pushed !== undefined ? { pushed } : {}),
    ...(pushError ? { pushError } : {}),
  }
}

export function raceStatus(deps: OrchestrationDeps, raceID?: string): RaceRecord | RaceRecord[] {
  const projectID = String(deps.ctx.location?.project?.id ?? "")
  const matches = (race: RaceRecord) =>
    !race.projectID || !projectID || race.projectID === projectID
  if (raceID) {
    const race = deps.races.get(raceID)
    if (!race || !matches(race)) throw new Error(`race not found: ${raceID}`)
    return race
  }
  return [...deps.races.values()]
    .filter(matches)
    .sort((left, right) => right.createdAt - left.createdAt)
}

export function raceList(deps: OrchestrationDeps): Array<Record<string, unknown>> {
  const projectID = String(deps.ctx.location?.project?.id ?? "")
  return [...deps.races.values()]
    .filter((race) => !race.projectID || !projectID || race.projectID === projectID)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((race) => ({
      raceID: race.raceID,
      status: race.status,
      mode: race.mode,
      createdAt: race.createdAt,
      updatedAt: race.updatedAt,
      base: race.base,
      targetDirectory: race.targetDirectory,
      candidates: race.candidates.length,
      worktrees: race.worktrees.length,
      keepWorktrees: race.keepWorktrees,
      ...(race.cleanup ? { cleanup: race.cleanup } : {}),
    }))
}

export async function raceCleanup(
  deps: OrchestrationDeps,
  context: ToolExecuteContext,
  input: { raceID: string; confirm: boolean; force: boolean; archiveSessions: boolean },
  signal: AbortSignal,
): Promise<{ race: RaceRecord; cleanup: RaceCleanup }> {
  if (!input.confirm) throw new Error("confirm: true is required to clean up a race")
  if (!deps.options.allowWorktreeManagement) {
    throw new Error("allowWorktreeManagement is false; cleanup is disabled")
  }
  const race = deps.races.get(input.raceID)
  if (!race) throw new Error(`race not found: ${input.raceID}`)
  if (!canManageRace(deps, context, race)) {
    throw new Error("race belongs to another session/run")
  }
  const projectID = String(deps.ctx.location?.project?.id ?? "")
  if (race.projectID && projectID && race.projectID !== projectID) {
    throw new Error("race belongs to another project")
  }
  if (!race.worktrees.length) {
    const cleanup: RaceCleanup = { at: Date.now(), removed: [], orphans: [], kept: [] }
    race.cleanup = cleanup
    await rememberRace(deps.ctx, deps.races, race)
    await removeRacePatches(race.raceID)
    return { race, cleanup }
  }
  const results = await removeWorktrees(
    {
      ctx: deps.ctx,
      options: deps.options,
      worktrees: deps.worktrees,
      git: deps.git,
      liveState: deps.liveState,
    },
    race.worktrees,
    { force: input.force, archiveSessions: input.archiveSessions },
    signal,
  )
  const cleanup: RaceCleanup = {
    at: Date.now(),
    removed: results.filter((entry) => entry.removed).map((entry) => entry.directory),
    orphans: results.filter((entry) => entry.orphan).map((entry) => entry.directory),
    kept: results.filter((entry) => !entry.removed && !entry.orphan).map((entry) => entry.directory),
  }
  race.cleanup = cleanup
  await rememberRace(deps.ctx, deps.races, race)
  if (!cleanup.orphans.length && !(cleanup.kept?.length ?? 0)) {
    await removeRacePatches(race.raceID)
  }
  return { race, cleanup }
}

export { shapeRace }


