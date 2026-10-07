import { describe, it, expect } from 'vitest'
import { MAX_RECENTS, mergeRecents, sanitizeRecents, withRecent } from '../recents'

describe('withRecent', () => {
  it('moves the connection to the front and caps the list', () => {
    const list = Array.from({ length: MAX_RECENTS }, (_, i) => ({ id: `s${i}`, at: i }))
    const next = withRecent(list, 's3', 100)
    expect(next[0]).toEqual({ id: 's3', at: 100 })
    expect(next.filter((r) => r.id === 's3')).toHaveLength(1)
    expect(withRecent(list, 'new', 100)).toHaveLength(MAX_RECENTS)
  })
})

describe('sanitizeRecents', () => {
  it('keeps only well-formed entries', () => {
    expect(sanitizeRecents('junk')).toEqual([])
    expect(sanitizeRecents([{ id: 'a', at: 1 }, { id: 2, at: 1 }, { id: 'b', at: Number.NaN }, null, { id: 'c', at: 3 }])).toEqual([
      { id: 'a', at: 1 },
      { id: 'c', at: 3 },
    ])
  })

  it('keeps one entry per connection when loading saved recents', () => {
    expect(sanitizeRecents([{ id: 'a', at: 3 }, { id: 'b', at: 2 }, { id: 'a', at: 1 }])).toEqual([{ id: 'a', at: 3 }, { id: 'b', at: 2 }])
  })

  it('merges a saved list behind the current one without repeats', () => {
    expect(mergeRecents([{ id: 'a', at: 5 }], [{ id: 'b', at: 2 }, { id: 'a', at: 1 }])).toEqual([{ id: 'a', at: 5 }, { id: 'b', at: 2 }])
  })
})
