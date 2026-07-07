import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkRateLimit } from '../../server/utils/rateLimit.ts'

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to max attempts in the window', () => {
    const key = `k1:${Date.now()}:${Math.random()}`
    for (let i = 0; i < 5; i++) expect(checkRateLimit(key, 5, 60_000)).toBe(true)
  })

  it('blocks attempt max+1', () => {
    const key = `k2:${Date.now()}:${Math.random()}`
    for (let i = 0; i < 5; i++) checkRateLimit(key, 5, 60_000)
    expect(checkRateLimit(key, 5, 60_000)).toBe(false)
    expect(checkRateLimit(key, 5, 60_000)).toBe(false)
  })

  it('resets after the window elapses', () => {
    const key = `k3:${Math.random()}`
    for (let i = 0; i < 5; i++) checkRateLimit(key, 5, 60_000)
    expect(checkRateLimit(key, 5, 60_000)).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect(checkRateLimit(key, 5, 60_000)).toBe(true)
  })

  it('does not reset before the window elapses', () => {
    const key = `k4:${Math.random()}`
    for (let i = 0; i < 5; i++) checkRateLimit(key, 5, 60_000)
    vi.advanceTimersByTime(59_000)
    expect(checkRateLimit(key, 5, 60_000)).toBe(false)
  })

  it('tracks keys independently', () => {
    const a = `a:${Math.random()}`
    const b = `b:${Math.random()}`
    for (let i = 0; i < 5; i++) checkRateLimit(a, 5, 60_000)
    expect(checkRateLimit(a, 5, 60_000)).toBe(false)
    expect(checkRateLimit(b, 5, 60_000)).toBe(true)
  })
})
