import type { RetryInfo, SessionStatusLike } from "./types.ts"

/**
 * Normalizes a provider retry into a timestamp-based `RetryInfo`.
 *
 * OpenCode emits `SessionStatus.retry.next` (and `session.retry.scheduled.at`)
 * as absolute epoch milliseconds, not as a delay. Keeping `next` for backwards
 * compatibility and deriving `inMs` at read time avoids ever rendering the
 * epoch value as a duration.
 */
export function retryInfo(
  attempt: number,
  message: string,
  next: number,
  now = Date.now(),
): RetryInfo {
  const at = Number.isFinite(next) ? next : now
  const inMs = Math.max(0, at - now)
  return {
    attempt,
    message,
    next: at,
    at,
    inMs,
    atISO: isoOrUndefined(at),
  }
}

export function retryInfoFromStatus(
  status: Extract<SessionStatusLike, { type: "retry" }>,
  now = Date.now(),
): RetryInfo {
  return retryInfo(status.attempt, status.message, status.next, now)
}

/** Recomputes the remaining time without losing the authoritative timestamp. */
export function refreshRetry(retry: RetryInfo, now = Date.now()): RetryInfo {
  return retryInfo(retry.attempt, retry.message, retry.next, now)
}

export function retryRemainingMs(retry: RetryInfo, now = Date.now()): number {
  return Math.max(0, retry.next - now)
}

function isoOrUndefined(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0 || value > 8.64e15) return undefined
  try {
    return new Date(value).toISOString()
  } catch {
    return undefined
  }
}
