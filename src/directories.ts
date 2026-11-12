import { access, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const WINDOWS = process.platform === "win32"

/**
 * Windows long paths can arrive as `\\?\C:\...` or `\\?\UNC\server\share`.
 * Comparisons and storage keys use the plain form; filesystem calls keep the
 * caller's value.
 */
export function stripLongPathPrefix(value: string): string {
  if (!value.startsWith("\\\\?\\")) return value
  const rest = value.slice(4)
  if (rest.startsWith("UNC\\")) return `\\\\${rest.slice(4)}`
  return rest
}

/** Normalizes a directory for identity comparisons, not for filesystem use. */
export function normalizeDirectory(value: string): string {
  const normalized = path.normalize(stripLongPathPrefix(value.trim()))
  return WINDOWS ? normalized.toLowerCase() : normalized
}

export function sameDirectory(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false
  return normalizeDirectory(left) === normalizeDirectory(right)
}

export function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = normalizeDirectory(child)
  const normalizedParent = normalizeDirectory(parent)
  if (normalizedChild === normalizedParent) return true
  const separator = normalizedParent.endsWith(path.sep) ? "" : path.sep
  return normalizedChild.startsWith(`${normalizedParent}${separator}`)
}

/** Rejects `..` before resolution so callers cannot hide traversal in a worktree path. */
export function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..")
}

/**
 * IDs that may be used as a single filesystem path segment. Generated race,
 * run, and candidate IDs use this shape; anything else must be hashed before
 * it reaches `path.join`.
 */
export function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..")
}

export type DirectoryValidationOptions = {
  projectDirectory?: string
  projectCanonical?: string
  registeredDirectories?: string[]
  allowWorktreeDirectories?: boolean
}

export type DirectoryValidation =
  | {
      ok: true
      directory: string
      realDirectory: string
      insideProject: boolean
      source: "project" | "registered" | "worktree"
    }
  | {
      ok: false
      reason:
        | "empty"
        | "not-absolute"
        | "parent-segment"
        | "not-found"
        | "not-directory"
        | "outside-project"
        | "not-git-worktree"
      error: string
    }

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    return value
  }
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value)
    return true
  } catch {
    return false
  }
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

async function isGitWorktreeRoot(value: string): Promise<boolean> {
  try {
    const info = await stat(path.join(value, ".git"))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * Validates an explicit session/worktree directory. The returned
 * `realDirectory` is the resolved path used for `session.create({ location })`.
 * Symlinks are resolved before the containment check so a link cannot escape
 * the project. Registered worktrees created by this plugin are accepted even
 * when they live outside the canonical project root.
 */
export async function validateTargetDirectory(
  input: string,
  options: DirectoryValidationOptions = {},
): Promise<DirectoryValidation> {
  const value = input.trim()
  if (!value) {
    return { ok: false, reason: "empty", error: "directory is empty" }
  }
  if (!path.isAbsolute(stripLongPathPrefix(value))) {
    return { ok: false, reason: "not-absolute", error: "directory must be absolute" }
  }
  if (hasParentSegment(value)) {
    return {
      ok: false,
      reason: "parent-segment",
      error: "directory must not contain '..' segments",
    }
  }
  if (!(await exists(value))) {
    return { ok: false, reason: "not-found", error: "directory does not exist" }
  }
  if (!(await isDirectory(value))) {
    return { ok: false, reason: "not-directory", error: "path is not a directory" }
  }

  let resolved: string
  try {
    resolved = await realpath(value)
  } catch {
    return { ok: false, reason: "not-found", error: "directory cannot be resolved" }
  }

  const projectRoots = [options.projectCanonical, options.projectDirectory].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  )
  for (const root of projectRoots) {
    const canonicalRoot = await canonicalPath(root)
    if (isPathInside(resolved, canonicalRoot)) {
      return {
        ok: true,
        directory: resolved,
        realDirectory: resolved,
        insideProject: true,
        source: "project",
      }
    }
  }

  const registered = options.registeredDirectories ?? []
  for (const candidate of registered) {
    const canonicalCandidate = await canonicalPath(candidate)
    if (sameDirectory(canonicalCandidate, resolved)) {
      return {
        ok: true,
        directory: resolved,
        realDirectory: resolved,
        insideProject: false,
        source: "registered",
      }
    }
  }

  // A manually created `git worktree` is a sibling/outside directory. It is
  // accepted only with an explicit opt-in and only when it is a git worktree
  // root (`.git` file or directory), never an arbitrary directory.
  if (options.allowWorktreeDirectories && (await isGitWorktreeRoot(resolved))) {
    return {
      ok: true,
      directory: resolved,
      realDirectory: resolved,
      insideProject: false,
      source: "worktree",
    }
  }

  return {
    ok: false,
    reason: "outside-project",
    error: "directory is outside the project and is not a registered worktree",
  }
}

/** Resolves the `.git` directory for a normal checkout or a linked worktree. */
export async function resolveGitDir(directory: string): Promise<string | undefined> {
  const dotGit = path.join(directory, ".git")
  try {
    const info = await stat(dotGit)
    if (info.isDirectory()) return dotGit
    if (!info.isFile()) return undefined
    const text = await readFile(dotGit, "utf8")
    const match = /^gitdir:\s*(.+)$/m.exec(text)
    if (!match?.[1]) return undefined
    return path.resolve(directory, match[1].trim())
  } catch {
    return undefined
  }
}

/** Walks up until it finds a `.git` entry. */
export async function findGitRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(stripLongPathPrefix(start))
  for (;;) {
    if (await resolveGitDir(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
