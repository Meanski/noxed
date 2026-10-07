export interface RecentConnection {
  id: string
  at: number
}

export const MAX_RECENTS = 8

/** Moves `id` to the front of the recents list, stamped `now`. */
export function withRecent(list: readonly RecentConnection[], id: string, now: number): RecentConnection[] {
  return [{ id, at: now }, ...list.filter((r) => r.id !== id)].slice(0, MAX_RECENTS)
}

/** Keeps only well-formed entries from persisted settings. */
export function sanitizeRecents(raw: unknown): RecentConnection[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r): r is RecentConnection => typeof r?.id === 'string' && typeof r?.at === 'number' && Number.isFinite(r.at))
    .slice(0, MAX_RECENTS)
}
