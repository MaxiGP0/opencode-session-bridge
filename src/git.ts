import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const WINDOWS = process.platform === "win32"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BUFFER = 1_000_000

const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "PWD",
  "OLDPWD",
  "USERNAME",
  "USERDOMAIN",
  "CI",
  "NODE_ENV",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "REDIS_URL",
]

const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|COOKIE|SESSION)/i
const SECRET_VALUE = [
  /\b(sk-[A-Za-z0-9_-]{8,})/g,
  /\b(ghp_[A-Za-z0-9]{8,})/g,
  /\b(github_pat_[A-Za-z0-9_]{8,})/g,
  /\b(AKIA[0-9A-Z]{12,})/g,
  /\b(Bearer\s+[A-Za-z0-9._~+/-]{8,}=*)/gi,
]
const SECRET_ASSIGNMENT =
  /((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'`]+)/gi

const SHELL_METACHARACTERS = /[;&|<>()`$\n\r]/

export type CommandResult = {
  command: string
  args: string[]
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  killed: boolean
  durationMs: number
  envSkipped: string[]
  error?: string
}

export type RunCommandOptions = {
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  env?: Record<string, string>
  signal?: AbortSignal
  redact?: boolean
}

export type ParsedCommand =
  | { ok: true; file: string; args: string[] }
  | { ok: false; error: string }

function quoteForWindowsBatch(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function isKnownPackageManager(value: string): boolean {
  return ["npm", "npx", "pnpm", "yarn", "bun"].includes(value.toLowerCase())
}

/**
 * Parses a command without a shell. Quotes group arguments; metacharacters are
 * rejected so a test command cannot smuggle a pipeline or redirection. Callers
 * that need a shell must add an explicit command runner with its own opt-in.
 */
export function parseCommand(command: string): ParsedCommand {
  const text = command.trim()
  if (!text) return { ok: false, error: "command is empty" }
  if (/[\n\r]/.test(text)) return { ok: false, error: "command must be a single line" }

  const args: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false

  for (const character of text) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else {
        current += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }
    if (SHELL_METACHARACTERS.test(character)) {
      return {
        ok: false,
        error: "shell metacharacters are not allowed; quote arguments or use a script",
      }
    }
    current += character
  }

  if (escaped) return { ok: false, error: "command ends with an escape character" }
  if (quote) return { ok: false, error: "command has an unterminated quote" }
  if (current) args.push(current)
  if (!args.length) return { ok: false, error: "command is empty" }

  const [file, ...rest] = args
  if (!file) return { ok: false, error: "command is empty" }
  const base = path.basename(file).toLowerCase()
  if (["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"].includes(base)) {
    return { ok: false, error: "shell commands are not allowed" }
  }
  return { ok: true, file, args: rest }
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

export function safeEnvironment(extra: Record<string, string> | undefined): {
  env: Record<string, string>
  skipped: string[]
} {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === "string") env[key] = value
  }
  const skipped: string[] = []
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      skipped.push(key)
      continue
    }
    // Never forward credential-like values provided through tool input. Tests
    // that need secrets must receive them from the host environment/CI.
    if (isSecretKey(key)) {
      skipped.push(key)
      continue
    }
    env[key] = value
  }
  return { env, skipped }
}

export function redactSecrets(text: string, env: Record<string, string> = {}): string {
  let result = text
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretKey(key) || value.length < 4) continue
    result = result.split(value).join("[redacted]")
  }
  for (const pattern of SECRET_VALUE) {
    result = result.replace(pattern, "[redacted]")
  }
  result = result.replace(SECRET_ASSIGNMENT, "$1[redacted]")
  return result
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (WINDOWS) {
    try {
      const killer = spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `taskkill /pid ${pid} /T /F`],
        { windowsHide: true, stdio: "ignore" },
      )
      killer.on("error", () => undefined)
      killer.unref()
      return
    } catch {
      // Fall through to the portable signal below.
    }
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The process may already be gone.
  }
}

async function spawnProcess(
  file: string,
  args: string[],
  options: RunCommandOptions,
  displayCommand = file,
  displayArgs = args,
): Promise<CommandResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBuffer = Math.max(100, options.maxBuffer ?? DEFAULT_MAX_BUFFER)
  const { env, skipped } = safeEnvironment(options.env)

  return new Promise<CommandResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let killed = false
    let settled = false
    let spawnError: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const child = spawn(file, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      if (options.redact !== false) {
        stdout = redactSecrets(stdout, env)
        stderr = redactSecrets(stderr, env)
      }
      resolve({
        command: displayCommand,
        args: displayArgs,
        exitCode,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        killed,
        durationMs: Date.now() - started,
        envSkipped: skipped,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }

    const kill = () => {
      if (settled) return
      killed = true
      killTree(child.pid)
    }

    const onAbort = () => kill()
    if (options.signal) {
      if (options.signal.aborted) kill()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
    }

    child.on("error", (error) => {
      spawnError = error.message
      finish(null, null)
    })

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length >= maxBuffer) {
        stdoutTruncated = true
        kill()
        return
      }
      stdout += chunk.toString()
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer)
        stdoutTruncated = true
        kill()
      }
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= maxBuffer) {
        stderrTruncated = true
        kill()
        return
      }
      stderr += chunk.toString()
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer)
        stderrTruncated = true
        kill()
      }
    })

    child.on("close", (code, signal) => finish(code, signal))
  })
}

/**
 * Runs a command with `execFile` semantics: no shell, bounded output, timeout,
 * allowlisted environment, and process-tree kill on Windows.
 */
export async function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const parsed = parseCommand(command)
  if (!parsed.ok) {
    return {
      command,
      args: [],
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      killed: false,
      durationMs: 0,
      envSkipped: [],
      error: parsed.error,
    }
  }

  if (WINDOWS && isKnownPackageManager(parsed.file)) {
    const comspec = process.env.ComSpec ?? "cmd.exe"
    const line = [parsed.file, ...parsed.args].map(quoteForWindowsBatch).join(" ")
    return spawnProcess(
      comspec,
      ["/d", "/s", "/c", line],
      options,
      parsed.file,
      parsed.args,
    )
  }

  return spawnProcess(parsed.file, parsed.args, options)
}

export async function runGit(
  args: string[],
  cwd: string,
  options: Omit<RunCommandOptions, "cwd"> = {},
): Promise<CommandResult> {
  return spawnProcess(
    "git",
    ["-c", "core.quotepath=false", "-c", "core.autocrlf=false", ...args],
    { ...options, cwd },
  )
}

export type GitRunner = (
  args: string[],
  cwd: string,
  options?: Omit<RunCommandOptions, "cwd">,
) => Promise<CommandResult>

/**
 * Linked worktrees are checked out by the host, which may use the user's
 * global `core.autocrlf=true`. The plugin's git runner deliberately uses raw
 * bytes (`core.autocrlf=false`), so a CRLF checkout would make every file look
 * modified and produce a huge line-ending-only snapshot. Rewrite the new
 * worktree from its index with no conversion before workers touch it.
 */
export async function normalizeWorktreeLineEndings(
  git: GitRunner,
  directory: string,
  options: Omit<RunCommandOptions, "cwd"> = {},
): Promise<boolean> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], directory, options)
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return false
  // This runs on a freshly created worktree, before any worker edits it.
  // reset --hard rewrites the checkout with raw bytes and refreshes the index
  // stat cache, avoiding line-ending-only `git status` entries.
  const reset = await git(
    ["-c", "core.autocrlf=false", "reset", "--hard", "HEAD"],
    directory,
    options,
  )
  return reset.exitCode === 0
}

export type TemporaryDirectory = {
  path: string
  cleanup: () => Promise<void>
}

export async function temporaryDirectory(prefix = "session-bridge-"): Promise<TemporaryDirectory> {
  const created = await mkdtemp(path.join(tmpdir(), prefix))
  return {
    path: created,
    cleanup: async () => {
      await rm(created, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export async function writePatchFile(
  raceID: string,
  candidateID: string,
  patch: string,
): Promise<string> {
  const directory = path.join(tmpdir(), "opencode-session-bridge", "races", raceID)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${candidateID.replace(/[^A-Za-z0-9_.-]/g, "_")}.patch`)
  await writeFile(file, patch, "utf8")
  return file
}

export async function removeRacePatches(raceID: string): Promise<void> {
  const directory = path.join(tmpdir(), "opencode-session-bridge", "races", raceID)
  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}
