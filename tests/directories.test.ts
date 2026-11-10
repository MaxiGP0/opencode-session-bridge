import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  findGitRoot,
  hasParentSegment,
  isPathInside,
  normalizeDirectory,
  resolveGitDir,
  sameDirectory,
  stripLongPathPrefix,
  validateTargetDirectory,
} from "../src/directories.ts"

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "session-bridge-dirs-")))
}

describe("directory helpers", () => {
  it("normalizes long paths and compares case-insensitively on Windows", () => {
    expect(stripLongPathPrefix("\\\\?\\C:\\repo")).toBe("C:\\repo")
    expect(stripLongPathPrefix("\\\\?\\UNC\\server\\share")).toBe("\\\\server\\share")
    if (process.platform === "win32") {
      expect(sameDirectory("C:\\Repo", "c:\\repo")).toBe(true)
      expect(normalizeDirectory("C:\\Repo\\..\\Repo")).toBe("c:\\repo")
    } else {
      expect(sameDirectory("/repo", "/REPO")).toBe(false)
    }
  })

  it("detects containment and parent segments", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo"
    const child = path.join(root, "src")
    expect(isPathInside(child, root)).toBe(true)
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, child)).toBe(false)
    expect(hasParentSegment("a/../b")).toBe(true)
    expect(hasParentSegment("a/b")).toBe(false)
  })
})

describe("validateTargetDirectory", () => {
  it("accepts an existing directory inside the canonical project", async () => {
    const root = await tempRoot()
    try {
      const child = path.join(root, "packages", "app")
      await mkdir(child, { recursive: true })
      const result = await validateTargetDirectory(child, {
        projectCanonical: root,
        projectDirectory: root,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.insideProject).toBe(true)
        expect(sameDirectory(result.realDirectory, child)).toBe(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("canonicalizes a project root before checking containment", async () => {
    const root = await tempRoot()
    try {
      const child = path.join(root, "child")
      await mkdir(child, { recursive: true })
      const alias = path.join(root, "root-link")
      try {
        await symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
      } catch {
        // Creating symlinks may require privileges on Windows; skip in that case.
        return
      }
      const result = await validateTargetDirectory(child, { projectCanonical: alias })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.insideProject).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects relative paths and parent traversal", async () => {
    expect(await validateTargetDirectory("relative/dir", {})).toMatchObject({
      ok: false,
      reason: "not-absolute",
    })
    const root = await tempRoot()
    try {
      expect(
        await validateTargetDirectory(`${root}/../escape`, {
          projectCanonical: root,
        }),
      ).toMatchObject({ ok: false, reason: "parent-segment" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects outside directories unless they are opt-in git worktrees", async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    try {
      const child = path.join(root, "inside")
      await mkdir(child, { recursive: true })
      expect(
        await validateTargetDirectory(outside, { projectCanonical: root }),
      ).toMatchObject({ ok: false, reason: "outside-project" })

      expect(
        await validateTargetDirectory(outside, {
          projectCanonical: root,
          allowWorktreeDirectories: true,
        }),
      ).toMatchObject({ ok: false, reason: "outside-project" })

      await mkdir(path.join(outside, ".git"), { recursive: true })
      expect(
        await validateTargetDirectory(outside, {
          projectCanonical: root,
          allowWorktreeDirectories: true,
        }),
      ).toMatchObject({ ok: true, source: "worktree" })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("resolves .git files for linked worktrees and walks to the root", async () => {
    const root = await tempRoot()
    try {
      const worktree = path.join(root, "wt")
      const gitDir = path.join(root, "repo", ".git", "worktrees", "wt")
      await mkdir(gitDir, { recursive: true })
      await mkdir(worktree, { recursive: true })
      await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8")
      expect(await resolveGitDir(worktree)).toBe(gitDir)
      expect(await findGitRoot(path.join(worktree))).toBe(worktree)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a symlink that escapes the project", async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    try {
      const link = path.join(root, "escape")
      try {
        await symlink(
          outside,
          link,
          process.platform === "win32" ? "junction" : "dir",
        )
      } catch {
        // Creating symlinks may require privileges on Windows; skip in that case.
        return
      }
      const result = await validateTargetDirectory(link, { projectCanonical: root })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("outside-project")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
