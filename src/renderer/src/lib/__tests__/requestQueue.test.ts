import { describe, it, expect } from 'vitest'
import { withRequest, withoutRequest } from '../requestQueue'

const a = { requestId: 'a' }
const b = { requestId: 'b' }

describe('request queue updaters', () => {
  it('removes by id, leaving others in order', () => {
    expect(withoutRequest('a')([a, b])).toEqual([b])
    expect(withoutRequest('z')([a, b])).toEqual([a, b])
  })

  it('restores a prompt to the front once', () => {
    expect(withRequest(a)([b])).toEqual([a, b])
    const queue = [a, b]
    expect(withRequest(a)(queue)).toBe(queue)
  })
})
