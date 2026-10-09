import { describe, it, expect } from 'vitest'
import { valuesPlaceholders } from '../dbTypes'

describe('valuesPlaceholders', () => {
  it('numbers placeholders across rows in the driver syntax', () => {
    expect(valuesPlaceholders(2, 3, (n) => `$${n}`)).toBe('($1, $2, $3), ($4, $5, $6)')
    expect(valuesPlaceholders(1, 2, (n) => `@p${n}`)).toBe('(@p1, @p2)')
  })

  it('is empty for no rows', () => {
    expect(valuesPlaceholders(0, 3, (n) => `$${n}`)).toBe('')
  })
})
