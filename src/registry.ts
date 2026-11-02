import type { PluginContext } from "./types.ts"

const OWNED_KEY = "session-bridge:owned-sessions"
const MAX_OWNED = 500

export async function loadOwnedSessions(ctx: PluginContext): Promise<Set<string>> {
  try {
    const raw = await ctx.storage?.get(OWNED_KEY)
    if (!Array.isArray(raw)) return new Set()
    const ids = raw.filter((value): value is string => typeof value === "string" && value.length > 0)
    return new Set(ids.slice(-MAX_OWNED))
  } catch {
    return new Set()
  }
}

export async function persistOwnedSessions(
  ctx: PluginContext,
  sessions: Set<string>,
): Promise<void> {
  try {
    await ctx.storage?.set(OWNED_KEY, [...sessions])
  } catch {
    // Storage is optional; the in-memory registry still protects this process.
  }
}

export async function rememberOwnedSession(
  ctx: PluginContext,
  sessions: Set<string>,
  sessionID: string,
): Promise<void> {
  sessions.add(sessionID)
  while (sessions.size > MAX_OWNED) {
    const oldest = sessions.values().next().value
    if (typeof oldest !== "string") break
    sessions.delete(oldest)
  }
  await persistOwnedSessions(ctx, sessions)
}

export async function forgetOwnedSession(
  ctx: PluginContext,
  sessions: Set<string>,
  sessionID: string,
): Promise<void> {
  sessions.delete(sessionID)
  await persistOwnedSessions(ctx, sessions)
}
