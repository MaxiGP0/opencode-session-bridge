import type { QueuedPrompt, QueuedPrompts } from "./types.ts"

export type QueueOptions = {
  ttlMs: number
  maxPerSession: number
}

function isExpired(entry: QueuedPrompt, now: number, ttlMs: number): boolean {
  return ttlMs > 0 && now - entry.at > ttlMs
}

export function purgeQueuedPrompts(
  queue: QueuedPrompts,
  sessionID: string,
  options: QueueOptions,
  now = Date.now(),
): QueuedPrompt[] {
  const entries = queue.get(sessionID)
  if (!entries) return []
  const live = entries.filter((entry) => !isExpired(entry, now, options.ttlMs))
  if (live.length === 0) queue.delete(sessionID)
  else if (live.length !== entries.length) queue.set(sessionID, live)
  return live
}

export function enqueueQueuedPrompt(
  queue: QueuedPrompts,
  sessionID: string,
  messageID: string,
  delivery: "steer" | "queue",
  options: QueueOptions,
  now = Date.now(),
): void {
  if (!messageID) return
  const entries = purgeQueuedPrompts(queue, sessionID, options, now)
  const existing = entries.find((entry) => entry.messageID === messageID)
  if (existing) {
    existing.delivery = delivery
    return
  }
  const next: QueuedPrompt = { messageID, at: now, delivery }
  entries.push(next)
  const max = Math.max(1, options.maxPerSession)
  while (entries.length > max) entries.shift()
  queue.set(sessionID, entries)
}

export function listQueuedPrompts(
  queue: QueuedPrompts,
  sessionID: string,
  options: QueueOptions,
  now = Date.now(),
): QueuedPrompt[] {
  return [...purgeQueuedPrompts(queue, sessionID, options, now)]
}

export function nextQueuedPrompt(
  queue: QueuedPrompts,
  sessionID: string,
  options: QueueOptions,
  now = Date.now(),
): QueuedPrompt | undefined {
  return purgeQueuedPrompts(queue, sessionID, options, now)[0]
}

export function removeQueuedPrompt(
  queue: QueuedPrompts,
  sessionID: string,
  messageID: string | undefined,
  options: QueueOptions,
  now = Date.now(),
): void {
  if (!messageID) return
  const entries = purgeQueuedPrompts(queue, sessionID, options, now).filter(
    (entry) => entry.messageID !== messageID,
  )
  if (entries.length === 0) queue.delete(sessionID)
  else queue.set(sessionID, entries)
}

export function clearQueuedPrompts(queue: QueuedPrompts, sessionID: string): void {
  queue.delete(sessionID)
}

export function clearAllQueuedPrompts(queue: QueuedPrompts): void {
  queue.clear()
}
