import { codePointLength, compact, truncateCodePoints } from "./format.ts"
import type { BridgeOptions } from "./options.ts"
import type { PluginContext } from "./types.ts"
import type { WorktreeStrategy } from "./worktrees.ts"

export type RaceMode = "worktrees" | "same-directory"
export type RaceStatus = "running" | "completed" | "partial" | "failed"
export type SnapshotMode = "auto" | "commit" | "patch"
export type Verification = "trusted" | "flagged" | "unknown"

export type VcsFileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
  more?: true
}

export type CandidateDiffFile = {
  file: string
  status: "added" | "deleted" | "modified"
  additions: number
  deletions: number
  patch?: string
  patchTruncated?: boolean
  binary?: boolean
  renamed?: boolean
  modeChanged?: boolean
  submodule?: boolean
  lfs?: boolean
  unsupported?: boolean
}

export type CommandSummary = {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout?: string
  stderr?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  skipped?: boolean
  reason?: string
  envSkipped?: string[]
}

export type CandidateTests = {
  skipped: boolean
  reason?: string
  passed?: boolean
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  stdout?: string
  stderr?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  command?: string
  setup?: CommandSummary
  teardown?: CommandSummary
  envSkipped?: string[]
}

export type RaceJson =
  | string
  | number
  | boolean
  | null
  | RaceJson[]
  | { [key: string]: RaceJson }

export type CandidateRecord = {
  candidateID: string
  index: number
  sessionID?: string
  messageID: string
  directory: string
  worktree?: string
  strategy: WorktreeStrategy
  base?: string
  branch?: string
  commit?: string
  patch?: string
  patchFile?: string
  patchBytes: number
  diffComplete: boolean
  snapshotSource: "git-commit" | "git-patch" | "vcs" | "none"
  files: CandidateDiffFile[]
  diffStats: { files: number; additions: number; deletions: number }
  testFilesChanged: boolean
  ciFilesChanged: boolean
  skippedTests: boolean
  verification: Verification
  tests?: CandidateTests
  state: string
  outcome?: string
  elapsedMs: number
  error?: string
  text?: string
  cost?: RaceJson
  tokens?: RaceJson
  retry?: { attempt: number; message: string; next: number; inMs?: number }
  pendingPermissions?: Array<{ id: string; action: string; resources?: string[] }>
  background?: Array<{ kind: string; description?: string; command?: string }>
  unsupported?: boolean
  applyStrategy: "cherry-pick" | "patch" | "none"
}

export type RaceCleanup = {
  at: number
  removed: string[]
  orphans: string[]
  kept?: string[]
}

export type RaceRecord = {
  raceID: string
  createdAt: number
  updatedAt: number
  projectID?: string
  ownerSessionID?: string
  ownerDirectory?: string
  targetDirectory: string
  mode: RaceMode
  prompt: string
  base?: string
  keepWorktrees: boolean
  status: RaceStatus
  candidates: CandidateRecord[]
  worktrees: string[]
  cleanup?: RaceCleanup
}

export type RaceRegistry = Map<string, RaceRecord>

const RACES_KEY = "session-bridge:races"
const MAX_RACES = 50
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

const processRaces: RaceRegistry = new Map()

function validString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function pruneRaces(races: RaceRegistry, now = Date.now()): void {
  for (const [raceID, race] of races) {
    if (race.status === "running") continue
    if (now - race.updatedAt > DEFAULT_RETENTION_MS) races.delete(raceID)
  }
  while (races.size > MAX_RACES) {
    const oldest = races.keys().next().value
    if (typeof oldest !== "string") break
    races.delete(oldest)
  }
}

export function createRaceID(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `race_${Date.now().toString(36)}_${random}`
}

export async function loadRaces(ctx: PluginContext): Promise<RaceRegistry> {
  const races: RaceRegistry = new Map()
  try {
    const raw = await ctx.storage?.get(RACES_KEY)
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (!value || typeof value !== "object") continue
        const race = value as RaceRecord
        if (!validString(race.raceID) || !validString(race.targetDirectory)) continue
        races.set(race.raceID, {
          ...race,
          createdAt: validTimestamp(race.createdAt) ?? Date.now(),
          updatedAt: validTimestamp(race.updatedAt) ?? Date.now(),
          candidates: Array.isArray(race.candidates) ? race.candidates : [],
          worktrees: Array.isArray(race.worktrees) ? race.worktrees : [],
        })
      }
    }
  } catch {
    // Storage is optional.
  }
  for (const [raceID, race] of processRaces) races.set(raceID, race)
  pruneRaces(races)
  return races
}

export async function persistRaces(ctx: PluginContext, races: RaceRegistry): Promise<void> {
  try {
    await ctx.storage?.set(RACES_KEY, [...races.values()])
  } catch {
    // Storage is optional.
  }
}

export async function rememberRace(
  ctx: PluginContext,
  races: RaceRegistry,
  race: RaceRecord,
): Promise<void> {
  races.set(race.raceID, race)
  processRaces.set(race.raceID, race)
  pruneRaces(races)
  pruneRaces(processRaces)
  await persistRaces(ctx, races)
}

export function candidateByID(
  race: RaceRecord | undefined,
  candidateID: string,
): CandidateRecord | undefined {
  return race?.candidates.find((candidate) => candidate.candidateID === candidateID)
}

const TEST_PATH =
  /(^|\/)(tests?|__tests__|e2e|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s$/
const CI_PATH =
  /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)azure-pipelines\.ya?ml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\//

const SKIPPED_TEST_MARKERS = [
  ".skip(",
  ".only(",
  "xit(",
  "fit(",
  "todo(",
  "--passWithNoTests",
  "test.skip",
  "describe.skip",
  "it.skip",
  "@pytest.mark.skip",
  "pytest.skip(",
  "t.Skip(",
  "#[ignore]",
]

/** Parses a full `git diff --binary` patch into per-file entries. */
export function parsePatchFiles(patch: string): VcsFileDiff[] {
  if (!patch) return []
  const lines = patch.split(/\r?\n/)
  const files: VcsFileDiff[] = []
  let current: VcsFileDiff | undefined
  let currentFile: string | undefined
  let added = 0
  let deleted = 0
  let addedFile = false
  let deletedFile = false

  const flush = () => {
    if (!current || !currentFile) return
    current.file = currentFile
    current.additions = added
    current.deletions = deleted
    current.status = addedFile ? "added" : deletedFile ? "deleted" : "modified"
    files.push(current)
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush()
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      currentFile = match?.[2] ?? match?.[1]
      current = {
        file: currentFile ?? "",
        patch: "",
        additions: 0,
        deletions: 0,
        status: "modified",
      }
      added = 0
      deleted = 0
      addedFile = false
      deletedFile = false
      continue
    }
    if (!current) continue
    current.patch += `${line}\n`
    if (line.startsWith("new file mode ")) addedFile = true
    if (line.startsWith("deleted file mode ")) deletedFile = true
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim().replace(/^"?b\//, "").replace(/"$/, "")
      if (value && value !== "/dev/null") currentFile = value
    } else if (line.startsWith("--- ")) {
      const value = line.slice(4).trim().replace(/^"?a\//, "").replace(/"$/, "")
      if (value && value !== "/dev/null" && !currentFile) currentFile = value
    }
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    if (line.startsWith("-") && !line.startsWith("---")) deleted++
  }
  flush()
  return files
}

export function isTestPath(file: string): boolean {
  return TEST_PATH.test(file.replace(/\\/g, "/"))
}

export function isCiPath(file: string): boolean {
  return CI_PATH.test(file.replace(/\\/g, "/"))
}

export function patchDisablesTests(patch: string): boolean {
  if (!patch) return false
  return patch.split(/\r?\n/).some((line) => {
    if (!line.startsWith("+") || line.startsWith("+++")) return false
    return SKIPPED_TEST_MARKERS.some((marker) => line.includes(marker))
  })
}

function patchFlags(patch: string): {
  binary: boolean
  binaryRepresentable: boolean
  renamed: boolean
  modeChanged: boolean
  submodule: boolean
  lfs: boolean
} {
  return {
    binary: /GIT binary patch|Binary files .* differ/i.test(patch),
    binaryRepresentable: /GIT binary patch/.test(patch),
    renamed: /^rename (from|to) /m.test(patch),
    modeChanged: /^(old|new) mode /m.test(patch),
    submodule: /^Subproject commit /m.test(patch),
    lfs: /git-lfs\.github\.com\/spec\/v1/m.test(patch),
  }
}

/**
 * Converts the VCS diff into a bounded, display-safe shape while retaining the
 * full patch separately for apply. Binary patches that are only represented as
 * "Binary files differ" are marked unsupported.
 */
export function analyzeDiffs(
  files: readonly VcsFileDiff[],
  fullPatch: string,
  maxBytes: number,
): {
  files: CandidateDiffFile[]
  diffStats: { files: number; additions: number; deletions: number }
  testFilesChanged: boolean
  ciFilesChanged: boolean
  skippedTests: boolean
  unsupported: boolean
  binary: boolean
  renamed: boolean
  modeChanged: boolean
  submodule: boolean
  lfs: boolean
} {
  const global = patchFlags(fullPatch)
  let used = 0
  const analyzed: CandidateDiffFile[] = []
  let additions = 0
  let deletions = 0
  let testFilesChanged = false
  let ciFilesChanged = false
  let unsupported = false
  let binary = false
  let renamed = false
  let modeChanged = false
  let submodule = false
  let lfs = false

  for (const file of files) {
    const flags = patchFlags(file.patch ?? "")
    binary ||= flags.binary
    renamed ||= flags.renamed
    modeChanged ||= flags.modeChanged
    submodule ||= flags.submodule
    lfs ||= flags.lfs
    if (isTestPath(file.file)) testFilesChanged = true
    if (isCiPath(file.file)) ciFilesChanged = true
    additions += file.additions
    deletions += file.deletions

    const remaining = Math.max(0, maxBytes - used)
    const patch = file.patch ?? ""
    const truncated = codePointLength(patch) > remaining
    const shown = truncated ? truncateCodePoints(patch, remaining, "…") : patch
    used += codePointLength(shown)
    const fileUnsupported =
      flags.binary && !flags.binaryRepresentable && !global.binaryRepresentable
    if (fileUnsupported) unsupported = true
    analyzed.push({
      file: file.file,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(shown ? { patch: shown } : {}),
      ...(truncated ? { patchTruncated: true } : {}),
      ...(flags.binary ? { binary: true } : {}),
      ...(flags.renamed ? { renamed: true } : {}),
      ...(flags.modeChanged ? { modeChanged: true } : {}),
      ...(flags.submodule ? { submodule: true } : {}),
      ...(flags.lfs ? { lfs: true } : {}),
      ...(fileUnsupported ? { unsupported: true } : {}),
    })
  }

  return {
    files: analyzed,
    diffStats: { files: files.length, additions, deletions },
    testFilesChanged: testFilesChanged || files.some((file) => isTestPath(file.file)),
    ciFilesChanged: ciFilesChanged || files.some((file) => isCiPath(file.file)),
    skippedTests: patchDisablesTests(fullPatch),
    unsupported: unsupported || global.submodule,
    binary,
    renamed,
    modeChanged,
    submodule,
    lfs,
  }
}

export function verificationFor(input: {
  testsSkipped: boolean
  testsPassed: boolean | undefined
  testFilesChanged: boolean
  ciFilesChanged: boolean
  skippedTests: boolean
  allowTestChanges: boolean
}): Verification {
  if (input.testsSkipped || input.testsPassed === undefined) return "unknown"
  if (input.testsPassed === false) return "flagged"
  if (
    input.skippedTests ||
    ((input.testFilesChanged || input.ciFilesChanged) && !input.allowTestChanges)
  ) {
    return "flagged"
  }
  return "trusted"
}

export type Ranking = {
  recommended?: string
  ranking: string[]
  rankingReasons: string[]
}

/**
 * Heuristic ranking, never an absolute "best". Only a candidate with passing
 * tests and an unmodified test/CI surface can be recommended.
 */
export function rankCandidates(candidates: CandidateRecord[]): Ranking {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.verification === "trusted" &&
      candidate.tests?.passed === true &&
      !candidate.tests.skipped &&
      candidate.state === "idle" &&
      candidate.diffStats.files > 0,
  )
  const score = (candidate: CandidateRecord) =>
    candidate.diffStats.additions + candidate.diffStats.deletions
  const sorted = [...candidates].sort((left, right) => {
    const leftEligible = eligible.includes(left) ? 0 : 1
    const rightEligible = eligible.includes(right) ? 0 : 1
    if (leftEligible !== rightEligible) return leftEligible - rightEligible
    if (leftEligible === 0) {
      const diff = score(left) - score(right)
      if (diff !== 0) return diff
      return left.elapsedMs - right.elapsedMs
    }
    return left.elapsedMs - right.elapsedMs
  })
  const ranking = sorted.map((candidate) => candidate.candidateID)
  const reasons: string[] = []
  if (!eligible.length) {
    reasons.push("no-trusted-candidate")
    if (candidates.every((candidate) => candidate.tests?.skipped)) {
      reasons.push("tests-skipped")
    } else if (candidates.every((candidate) => candidate.tests?.passed !== true)) {
      reasons.push("tests-failed")
    }
    return { ranking, rankingReasons: reasons }
  }
  const recommended = [...eligible].sort((left, right) => {
    const diff = score(left) - score(right)
    return diff !== 0 ? diff : left.elapsedMs - right.elapsedMs
  })[0]?.candidateID
  reasons.push("tests-passed")
  reasons.push("smallest-diff")
  reasons.push("fastest")
  return { recommended, ranking, rankingReasons: reasons }
}

export function boundedCommandSummary(
  value: CommandSummary | undefined,
  maxChars: number,
): CommandSummary | undefined {
  if (!value) return undefined
  return {
    command: value.command,
    exitCode: value.exitCode,
    timedOut: value.timedOut,
    durationMs: value.durationMs,
    ...(value.stdout
      ? {
          stdout: truncateCodePoints(value.stdout, maxChars, "…"),
          stdoutTruncated: codePointLength(value.stdout) > maxChars,
        }
      : {}),
    ...(value.stderr
      ? {
          stderr: truncateCodePoints(value.stderr, maxChars, "…"),
          stderrTruncated: codePointLength(value.stderr) > maxChars,
        }
      : {}),
    ...(value.skipped ? { skipped: true } : {}),
    ...(value.reason ? { reason: value.reason } : {}),
    ...(value.envSkipped?.length ? { envSkipped: value.envSkipped } : {}),
  }
}

export function boundedTests(
  tests: CandidateTests | undefined,
  maxChars: number,
): CandidateTests | undefined {
  if (!tests) return undefined
  return {
    skipped: tests.skipped,
    ...(tests.reason ? { reason: tests.reason } : {}),
    ...(tests.passed !== undefined ? { passed: tests.passed } : {}),
    ...(tests.exitCode !== undefined ? { exitCode: tests.exitCode } : {}),
    ...(tests.timedOut ? { timedOut: true } : {}),
    ...(tests.durationMs !== undefined ? { durationMs: tests.durationMs } : {}),
    ...(tests.command ? { command: tests.command } : {}),
    ...(tests.stdout
      ? {
          stdout: truncateCodePoints(tests.stdout, maxChars, "…"),
          stdoutTruncated: codePointLength(tests.stdout) > maxChars,
        }
      : {}),
    ...(tests.stderr
      ? {
          stderr: truncateCodePoints(tests.stderr, maxChars, "…"),
          stderrTruncated: codePointLength(tests.stderr) > maxChars,
        }
      : {}),
    ...(tests.setup ? { setup: boundedCommandSummary(tests.setup, maxChars) } : {}),
    ...(tests.teardown ? { teardown: boundedCommandSummary(tests.teardown, maxChars) } : {}),
    ...(tests.envSkipped?.length ? { envSkipped: tests.envSkipped } : {}),
  }
}

export function shapeCandidate(
  candidate: CandidateRecord,
  options: BridgeOptions,
  maxPatchChars = options.maxDiffBytes,
  maxTestChars = options.maxTestOutputChars,
  maxTextChars = options.maxTextChars,
  maxErrorChars = options.maxErrorChars,
): Record<string, unknown> {
  let used = 0
  const files = candidate.files.slice(0, 50).map((file) => {
    const patch = file.patch ?? ""
    if (!patch) return file
    const remaining = Math.max(0, maxPatchChars - used)
    const shown = truncateCodePoints(patch, remaining, "…")
    used += codePointLength(shown)
    return {
      ...file,
      patch: shown,
      ...(shown !== patch || file.patchTruncated ? { patchTruncated: true } : {}),
    }
  })
  return {
    candidateID: candidate.candidateID,
    sessionID: candidate.sessionID,
    messageID: candidate.messageID,
    directory: candidate.directory,
    strategy: candidate.strategy,
    branch: candidate.branch,
    base: candidate.base,
    commit: candidate.commit,
    state: candidate.state,
    outcome: candidate.outcome,
    elapsedMs: candidate.elapsedMs,
    ...(candidate.text
      ? {
          text: truncateCodePoints(candidate.text, maxTextChars, "…"),
          textTruncated: codePointLength(candidate.text) > maxTextChars,
        }
      : {}),
    ...(candidate.error
      ? {
          error: truncateCodePoints(candidate.error, maxErrorChars, "…"),
          errorTruncated: codePointLength(candidate.error) > maxErrorChars,
        }
      : {}),
    diffStats: candidate.diffStats,
    files: files.slice(0, 50),
    ...(files.length > 50 ? { filesTruncated: true } : {}),
    patchBytes: candidate.patchBytes,
    diffComplete: candidate.diffComplete,
    snapshotSource: candidate.snapshotSource,
    applyStrategy: candidate.applyStrategy,
    testFilesChanged: candidate.testFilesChanged,
    ciFilesChanged: candidate.ciFilesChanged,
    skippedTests: candidate.skippedTests,
    verification: candidate.verification,
    tests: boundedTests(candidate.tests, maxTestChars),
    ...(candidate.cost !== undefined ? { cost: compact(candidate.cost, 100) || undefined } : {}),
    ...(candidate.tokens !== undefined
      ? { tokens: compact(candidate.tokens, 200) || undefined }
      : {}),
    ...(candidate.unsupported ? { unsupported: true } : {}),
    ...(candidate.retry ? { retry: candidate.retry } : {}),
    ...(candidate.pendingPermissions?.length
      ? { pendingPermissions: candidate.pendingPermissions }
      : {}),
    ...(candidate.background?.length ? { background: candidate.background } : {}),
  }
}

export function shapeRace(
  race: RaceRecord,
  options: BridgeOptions,
  ranking?: Ranking,
): Record<string, unknown> {
  const perCandidate = Math.max(
    1_200,
    Math.floor(
      (options.maxOutputTotalChars / Math.max(1, race.candidates.length)) * 0.7,
    ),
  )
  return {
    raceID: race.raceID,
    status: race.status,
    mode: race.mode,
    base: race.base,
    targetDirectory: race.targetDirectory,
    keepWorktrees: race.keepWorktrees,
    createdAt: race.createdAt,
    updatedAt: race.updatedAt,
    worktrees: race.worktrees,
    candidates: race.candidates.map((candidate) =>
      shapeCandidate(
        candidate,
        options,
        Math.floor(perCandidate * 0.5),
        Math.floor(perCandidate * 0.25),
        Math.max(200, Math.floor(perCandidate * 0.15)),
        Math.max(200, Math.floor(perCandidate * 0.1)),
      ),
    ),
    ...(ranking
      ? {
          ranking: ranking.ranking,
          rankingReasons: ranking.rankingReasons,
          recommended: ranking.recommended ?? null,
        }
      : {}),
    ...(race.cleanup
      ? {
          cleanup: {
            at: race.cleanup.at,
            removed: race.cleanup.removed,
            orphans: race.cleanup.orphans,
            ...(race.cleanup.kept ? { kept: race.cleanup.kept } : {}),
          },
        }
      : {}),
  }
}
