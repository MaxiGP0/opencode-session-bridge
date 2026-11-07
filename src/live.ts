import type {
  MessageLike,
  SessionEventLike,
  SessionStatusLike,
} from "./types.ts"

export type LivePromptInput = {
  sessionID?: string
  messageID?: string
  delivery?: "steer" | "queue"
}

export type LivePending = {
  messageID: string
  at: number
  delivery: "steer" | "queue"
  source: "hook" | "inbox"
}

export type LiveSnapshot = {
  pending: LivePending[]
  status?: SessionStatusLike
  statusAt?: number
}

export type LiveStateOptions = {
  ttlMs?: number
  maxPerSession?: number
  maxSessions?: number
  now?: () => number
}

export type LiveState = {
  notePrompt: (input: LivePromptInput) => void
  applyEvent: (event: SessionEventLike) => void
  markDelivered: (sessionID: string, messageID: string) => void
  reconcile: (sessionID: string, messages: MessageLike[]) => void
  get: (sessionID: string) => LiveSnapshot
  clearSession: (sessionID: string) => void
  clear: () => void
}

type LiveSession = {
  pending: Map<string, LivePending>
  status?: SessionStatusLike
  statusAt?: number
  at: number
}

const DEFAULT_TTL_MS = 3_600_000
const DEFAULT_MAX_PER_SESSION = 100
const DEFAULT_MAX_SESSIONS = 500

export function createLiveState(options: LiveStateOptions = {}): LiveState {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxPerSession = Math.max(1, options.maxPerSession ?? DEFAULT_MAX_PER_SESSION)
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS)
  const now = options.now ?? Date.now
  const sessions = new Map<string, LiveSession>()

  const touch = (sessionID: string): LiveSession => {
    const current = sessions.get(sessionID)
    if (current) {
      // Refresh insertion order for a true LRU when the session cap is hit.
      sessions.delete(sessionID)
      sessions.set(sessionID, current)
      return current
    }
    const created: LiveSession = { pending: new Map(), at: now() }
    sessions.set(sessionID, created)
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value
      if (typeof oldest !== "string") break
      sessions.delete(oldest)
    }
    return created
  }

  const pruneSession = (session: LiveSession): void => {
    for (const [messageID, entry] of session.pending) {
      if (ttlMs > 0 && now() - entry.at > ttlMs) session.pending.delete(messageID)
    }
    if (session.pending.size > maxPerSession) {
      const entries = [...session.pending.values()].sort((a, b) => a.at - b.at)
      for (const entry of entries.slice(0, entries.length - maxPerSession)) {
        session.pending.delete(entry.messageID)
      }
    }
    if (
      session.statusAt !== undefined &&
      ttlMs > 0 &&
      now() - session.statusAt > ttlMs
    ) {
      session.status = undefined
      session.statusAt = undefined
    }
  }

  const addPending = (
    sessionID: string,
    messageID: string,
    delivery: "steer" | "queue",
    source: "hook" | "inbox",
  ): void => {
    if (!sessionID || !messageID) return
    const session = touch(sessionID)
    const existing = session.pending.get(messageID)
    if (existing) {
      existing.delivery = delivery
      existing.source = source
    } else {
      session.pending.set(messageID, { messageID, at: now(), delivery, source })
    }
    pruneSession(session)
  }

  const removePending = (sessionID: string, messageID: string): void => {
    const session = sessions.get(sessionID)
    if (!session) return
    session.pending.delete(messageID)
    if (session.pending.size === 0 && session.status === undefined) sessions.delete(sessionID)
  }

  return {
    notePrompt(input) {
      addPending(
        input.sessionID ?? "",
        input.messageID ?? "",
        input.delivery ?? "steer",
        "hook",
      )
    },
    applyEvent(event) {
      const sessionID = event.data?.sessionID
      if (!sessionID) return
      if (event.type === "session.status") {
        const status = event.data?.status
        if (!status || typeof status.type !== "string") return
        const session = touch(sessionID)
        session.status = status
        session.statusAt = now()
        pruneSession(session)
        return
      }
      if (event.type === "session.idle") {
        const session = touch(sessionID)
        session.status = { type: "idle" }
        session.statusAt = now()
        return
      }
      const inboxID = event.data?.inboxID
      if (!inboxID) return
      if (event.type === "session.inbox.enqueued") {
        const delivery =
          event.data?.item?.delivery ?? event.data?.delivery ?? "queue"
        addPending(sessionID, inboxID, delivery, "inbox")
        return
      }
      if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
        removePending(sessionID, inboxID)
        return
      }
      if (event.type === "session.inbox.delivery.changed") {
        const session = sessions.get(sessionID)
        const entry = session?.pending.get(inboxID)
        const delivery = event.data?.delivery
        if (entry && delivery) entry.delivery = delivery
      }
    },
    markDelivered(sessionID, messageID) {
      removePending(sessionID, messageID)
    },
    reconcile(sessionID, messages) {
      const session = sessions.get(sessionID)
      if (!session) return
      const seen = new Set(
        messages
          .filter((message) => message.type === "user" && typeof message.id === "string")
          .map((message) => message.id as string),
      )
      for (const messageID of session.pending.keys()) {
        if (seen.has(messageID)) session.pending.delete(messageID)
      }
      if (session.pending.size === 0 && session.status === undefined) sessions.delete(sessionID)
    },
    get(sessionID) {
      const session = sessions.get(sessionID)
      if (!session) return { pending: [] }
      pruneSession(session)
      const pending = [...session.pending.values()].sort((a, b) => a.at - b.at)
      if (pending.length === 0 && session.status === undefined) sessions.delete(sessionID)
      return { pending, status: session.status, statusAt: session.statusAt }
    },
    clearSession(sessionID) {
      sessions.delete(sessionID)
    },
    clear() {
      sessions.clear()
    },
  }
}
