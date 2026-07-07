/**
 * Decklist text parser (pure — resolution against the catalog happens
 * server-side in deckResolve). Accepts Moxfield / MTGA / Archidekt / plain
 * exports:
 *   1 Sol Ring | 1x Sol Ring | Sol Ring | 4 Sol Ring (C21) 125 *F* [Ramp]
 * Section headers: Commander / Deck / Main(board) / Sideboard / Maybeboard /
 * Considering / Companion / Token(s) / About — case-insensitive, optional ':'.
 * Blank lines separate blocks (used for commander guessing when no headers).
 */

export type ParsedSection = 'COMMANDER' | 'MAIN' | 'IGNORED'

export interface ParsedEntry {
  line: number // 1-based line number in the pasted text
  qty: number
  name: string // raw name as pasted (not normalized)
  section: ParsedSection
  block: number // blank-line-separated block index
}

export interface ParsedSkip {
  line: number
  raw: string
  reason: 'section_ignored' | 'comment' | 'unparseable' | 'about_block'
}

export interface ParsedDecklist {
  entries: ParsedEntry[]
  skipped: ParsedSkip[]
  /** true if an explicit Commander section was present */
  hasCommanderSection: boolean
  /** entry indexes of the first block, if NO headers were present (commander guess candidates) */
  firstBlockIfHeaderless: ParsedEntry[]
}

const SECTION_RE = /^(commanders?|deck|main(?:board)?|sideboard|maybeboard|considering|companion|tokens?|about)\s*:?\s*$/i

const LINE_RE = new RegExp(
  '^\\s*' +
    '(?:(\\d+)\\s*[xX]?\\s+)?' + // qty (optional, default 1)
    '(.+?)' + // card name (lazy)
    '(?:\\s+\\(([A-Za-z0-9]{2,6})\\)(?:\\s+([0-9A-Za-z★†\\-]+))?)?' + // (SET) collector — ignored
    '((?:\\s+\\*[A-Za-z]+\\*)*)' + // Moxfield foil/etched markers — ignored
    '(?:\\s+\\[[^\\]]*\\])?' + // Archidekt [Category] — ignored
    '(?:\\s+\\^[^^]*\\^)?' + // Archidekt color tag — ignored
    '\\s*$',
)

function sectionFor(header: string): ParsedSection | 'ABOUT' {
  const h = header.toLowerCase().replace(/:$/, '').trim()
  if (h.startsWith('commander')) return 'COMMANDER'
  if (h === 'deck' || h.startsWith('main')) return 'MAIN'
  if (h === 'about') return 'ABOUT'
  return 'IGNORED'
}

export function parseDecklist(text: string): ParsedDecklist {
  const entries: ParsedEntry[] = []
  const skipped: ParsedSkip[] = []
  let section: ParsedSection = 'MAIN'
  let hasCommanderSection = false
  let sawAnyHeader = false
  let inAboutBlock = false
  let block = 0
  let lastWasBlank = true

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]!
    const trimmed = raw.trim()

    if (!trimmed) {
      if (!lastWasBlank) block++
      lastWasBlank = true
      inAboutBlock = false
      continue
    }
    lastWasBlank = false

    if (inAboutBlock) {
      skipped.push({ line: lineNo, raw: trimmed, reason: 'about_block' })
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      skipped.push({ line: lineNo, raw: trimmed, reason: 'comment' })
      continue
    }

    const header = SECTION_RE.exec(trimmed)
    if (header) {
      sawAnyHeader = true
      const s = sectionFor(header[1]!)
      if (s === 'ABOUT') {
        inAboutBlock = true
        section = 'IGNORED'
      } else {
        section = s
        if (s === 'COMMANDER') hasCommanderSection = true
      }
      continue
    }

    if (section === 'IGNORED') {
      skipped.push({ line: lineNo, raw: trimmed, reason: 'section_ignored' })
      continue
    }

    const m = LINE_RE.exec(trimmed)
    if (!m || !m[2]) {
      skipped.push({ line: lineNo, raw: trimmed, reason: 'unparseable' })
      continue
    }
    entries.push({
      line: lineNo,
      qty: m[1] ? Math.max(1, parseInt(m[1], 10)) : 1,
      name: m[2].trim(),
      section,
      block,
    })
  }

  const blocks = new Set(entries.map((e) => e.block))
  const firstBlock = entries.filter((e) => e.block === Math.min(...(entries.length ? entries.map((e) => e.block) : [0])))
  return {
    entries,
    skipped,
    hasCommanderSection,
    firstBlockIfHeaderless:
      !sawAnyHeader && blocks.size > 1 && firstBlock.length >= 1 && firstBlock.length <= 2
        ? firstBlock
        : [],
  }
}
