/**
 * Byte length of a raw WebSocket frame payload WITHOUT decoding it to a string.
 *
 * Node's ws adapter delivers frames as a Buffer (an ArrayBuffer view), so this
 * reads the length off the raw bytes; strings fall back to char count. Lets the
 * ws handler drop an oversized flood frame before paying for its UTF-8 decode +
 * full string allocation (SEC finding #3). Byte length ≥ decoded char length for
 * UTF-8, so a byte-length guard subsumes a decoded-length guard.
 */
export function wsFrameByteLength(rawData: unknown): number {
  if (typeof rawData === 'string') return rawData.length
  if (rawData instanceof ArrayBuffer) return rawData.byteLength
  if (ArrayBuffer.isView(rawData)) return rawData.byteLength
  return 0
}
