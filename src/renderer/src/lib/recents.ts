export interface RecentConnection {
  id: string
  at: number
}

export const MAX_RECENTS = 8

/** Moves `id` to the front of the recents list, stamped `now`. */
export function withRecent(list: readonly RecentConnection[], id: string, now: number): RecentConnection[] {
  return [{ id, at: now }, ...list.filter((r) => r.id !== id)].slice(0, MAX_RECENTS)
}

/** `first`, then whatever of `rest` isn't already in it, capped. */
export function mergeRecents(first: readonly RecentConnection[], rest: readonly RecentConnection[]): RecentConnection[] {
  const ids = new Set(first.map((r) => r.id))
  return [...first, ...rest.filter((r) => !ids.has(r.id))].slice(0, MAX_RECENTS)
}

/** Keeps only well-formed entries from persisted settings, one per connection (the first, newest). */
export function sanitizeRecents(raw: unknown): RecentConnection[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw
    .filter((r): r is RecentConnection => typeof r?.id === 'string' && typeof r?.at === 'number' && Number.isFinite(r.at))
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, MAX_RECENTS)
}
