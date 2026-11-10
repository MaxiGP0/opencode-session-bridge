import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  normalizeWorktreeLineEndings,
  parseCommand,
  redactSecrets,
  runCommand,
  runGit,
  safeEnvironment,
} from "../src/git.ts"

describe("command parsing", () => {
  it("tokenizes quoted arguments without a shell", () => {
    expect(parseCommand('node -e "process.exit(0)"')).toEqual({
      ok: true,
      file: "node",
      args: ["-e", "process.exit(0)"],
    })
    expect(parseCommand("npm run test -- --runInBand")).toEqual({
      ok: true,
      file: "npm",
      args: ["run", "test", "--", "--runInBand"],
    })
  })

  it("rejects shell metacharacters and shells", () => {
    expect(parseCommand("npm test && rm -rf /")).toMatchObject({ ok: false })
    expect(parseCommand("npm test | tee out")).toMatchObject({ ok: false })
    expect(parseCommand("sh -c 'npm test'")).toMatchObject({ ok: false })
    expect(parseCommand("cmd /c npm test")).toMatchObject({ ok: false })
    expect(parseCommand("   ")).toMatchObject({ ok: false })
  })
})

describe("environment and redaction", () => {
  it("skips secret-like and malformed env keys", () => {
    const { env, skipped } = safeEnvironment({
      MY_FLAG: "1",
      API_TOKEN: "secret",
      "bad-key": "x",
      DATABASE_URL: "postgres://localhost/test",
    })
    expect(env.MY_FLAG).toBe("1")
    expect(env.DATABASE_URL).toBe("postgres://localhost/test")
    expect(skipped).toContain("API_TOKEN")
    expect(skipped).toContain("bad-key")
  })

  it("redacts env values and common credential patterns", () => {
    const text = [
      "token=abc123",
      "Authorization: Bearer abcdefghijkl",
      "sk-1234567890abcdef",
      "value hunter2",
    ].join("\n")
    const redacted = redactSecrets(text, { MY_PASSWORD: "hunter2" })
    expect(redacted).not.toContain("hunter2")
    expect(redacted).not.toContain("abcdefghijkl")
    expect(redacted).not.toContain("sk-1234567890abcdef")
    expect(redacted).toContain("[redacted]")
  })
})

describe("runCommand", () => {
  it("runs without a shell and caps output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "session-bridge-cmd-"))
    try {
      const ok = await runCommand('node -e "process.stdout.write(\'ok\')"', {
        cwd,
        timeoutMs: 10_000,
        maxBuffer: 100,
      })
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toBe("ok")
      expect(ok.timedOut).toBe(false)

      const big = await runCommand('node -e "process.stdout.write(\'x\'.repeat(5000))"', {
        cwd,
        timeoutMs: 10_000,
        maxBuffer: 100,
      })
      expect(big.stdout.length).toBeLessThanOrEqual(100)
      expect(big.stdoutTruncated).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("times out and kills the process", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "session-bridge-cmd-"))
    try {
      const result = await runCommand('node -e "setTimeout(() => {}, 5000)"', {
        cwd,
        timeoutMs: 150,
        maxBuffer: 100,
      })
      expect(result.timedOut).toBe(true)
      expect(result.killed).toBe(true)
      expect(result.durationMs).toBeLessThan(4_000)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe("worktree line endings", () => {
  it("rewrites a CRLF checkout from the index without conversion", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "session-bridge-crlf-"))
    const worktree = path.join(repo, "wt")
    try {
      await runGit(["init", "-b", "main"], repo)
      await runGit(["config", "user.name", "test"], repo)
      await runGit(["config", "user.email", "test@localhost"], repo)
      await writeFile(path.join(repo, "base.txt"), "base\nsecond\n", "utf8")
      await runGit(["add", "."], repo)
      await runGit(["commit", "-m", "base"], repo)

      const added = await runGit(
        ["-c", "core.autocrlf=true", "worktree", "add", worktree, "-b", "crlf-wt", "HEAD"],
        repo,
        { timeoutMs: 30_000 },
      )
      expect(added.exitCode).toBe(0)
      const before = await readFile(path.join(worktree, "base.txt"), "utf8")
      expect(before).toContain("\r\n")

      expect(await normalizeWorktreeLineEndings(runGit, worktree)).toBe(true)
      const after = await readFile(path.join(worktree, "base.txt"), "utf8")
      expect(after).toBe("base\nsecond\n")
      const status = await runGit(["status", "--porcelain=v1"], worktree)
      expect(status.stdout.trim()).toBe("")
    } finally {
      await runGit(["worktree", "remove", "--force", worktree], repo).catch(() => undefined)
      await rm(repo, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
