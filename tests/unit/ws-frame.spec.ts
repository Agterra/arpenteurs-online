import { describe, expect, it } from 'vitest'
import { wsFrameByteLength } from '../../server/utils/wsFrame.ts'

/**
 * Regression for SEC finding #3: the ws flood guard must measure a frame by its
 * BYTE length off the raw bytes, before decoding it to a string — so an
 * oversized frame is dropped without paying for a UTF-8 decode + allocation.
 */
describe('wsFrameByteLength', () => {
  it('measures a Buffer by its byte length (no decode)', () => {
    expect(wsFrameByteLength(Buffer.from('abc'))).toBe(3)
    // 3 chars, 6 bytes in UTF-8 (é = 2 bytes each)
    expect(wsFrameByteLength(Buffer.from('ééé', 'utf-8'))).toBe(6)
  })

  it('measures a Uint8Array / ArrayBuffer / DataView view', () => {
    expect(wsFrameByteLength(new Uint8Array(10))).toBe(10)
    expect(wsFrameByteLength(new ArrayBuffer(12))).toBe(12)
    expect(wsFrameByteLength(new DataView(new ArrayBuffer(8)))).toBe(8)
  })

  it('falls back to char count for a string frame', () => {
    expect(wsFrameByteLength('hello')).toBe(5)
  })

  it('flags an oversized frame above the 64 KB guard', () => {
    const big = Buffer.alloc(64_001)
    expect(wsFrameByteLength(big) > 64_000).toBe(true)
    expect(wsFrameByteLength(Buffer.alloc(64_000)) > 64_000).toBe(false)
  })

  it('returns 0 for unrecognised payloads', () => {
    expect(wsFrameByteLength(null)).toBe(0)
    expect(wsFrameByteLength(undefined)).toBe(0)
    expect(wsFrameByteLength(42)).toBe(0)
    expect(wsFrameByteLength({})).toBe(0)
  })
})
