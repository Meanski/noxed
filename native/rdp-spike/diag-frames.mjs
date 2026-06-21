#!/usr/bin/env node
// Diagnose the sidecar's stdout framing. Reads a raw capture (rdp-sidecar's
// stdout redirected to a file) and walks the NXF1 frame chain, reporting the
// first place the stream diverges from the expected layout:
//   "NXF1" + u32le w + u32le h + u32le dataLen + dataLen bytes  (dataLen == w*h*4)
//
// Usage: node diag-frames.mjs /tmp/rdp.bin

import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) { console.error('usage: node diag-frames.mjs <capture.bin>'); process.exit(2) }

const buf = readFileSync(path)
console.log(`capture: ${buf.length} bytes`)

const MAGIC = 'NXF1'
const hexAscii = (off, n = 32) => {
  const slice = buf.subarray(off, off + n)
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ')
  const asc = [...slice].map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
  return `  hex: ${hex}\n  asc: ${asc}`
}

let off = 0
let frame = 0
while (off + 16 <= buf.length) {
  const magic = buf.toString('ascii', off, off + 4)
  if (magic !== MAGIC) {
    console.log(`\n❌ DESYNC at offset ${off} (after ${frame} good frames). Expected "NXF1", got "${magic}".`)
    console.log(`bytes at desync:`)
    console.log(hexAscii(off, 48))
    // Where does the next real NXF1 appear? Measures the size of the stray gap.
    const next = buf.indexOf(Buffer.from(MAGIC), off + 1)
    if (next >= 0) console.log(`\nnext "NXF1" at offset ${next}  →  ${next - off} stray bytes injected here`)
    else console.log(`\nno further "NXF1" found`)
    process.exit(1)
  }
  const w = buf.readUInt32LE(off + 4)
  const h = buf.readUInt32LE(off + 8)
  const dataLen = buf.readUInt32LE(off + 12)
  const expected = w * h * 4
  const tag = dataLen === expected ? 'ok' : `⚠ dataLen != w*h*4 (${expected})`
  if (frame < 5 || dataLen !== expected) {
    console.log(`frame ${frame}: ${w}x${h} dataLen=${dataLen} [${tag}] @${off}`)
  }
  const nextOff = off + 16 + dataLen
  if (nextOff > buf.length) {
    console.log(`\n⚠️ WARNING: frame ${frame} extends beyond buffer end (${nextOff} > ${buf.length}), truncated`)
    break
  }
  off = nextOff
  frame++
}
console.log(`\n✅ walked ${frame} frames cleanly, ended at offset ${off} (capture ${buf.length})`)
if (off !== buf.length) console.log(`   (trailing ${buf.length - off} bytes = partial final frame, expected)`)
