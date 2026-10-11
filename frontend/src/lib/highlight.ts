export interface HighlightRange {
  /** Inclusive start offset into the original document text. */
  start: number
  /** Exclusive end offset into the original document text. */
  end: number
}

interface Normalized {
  text: string
  /** normalized index -> index in the original string */
  map: number[]
}

/**
 * Rewrite runs of whitespace. `keepSpace` collapses each run to a single space
 * (right for Latin text); otherwise the run is dropped entirely — which is what
 * CJK needs, since PDF-extracted text carries line breaks inserted mid-word
 * ("连接建\n立开销") that the original had no whitespace in.
 */
function normalize(src: string, keepSpace: boolean): Normalized {
  let text = ''
  const map: number[] = []
  let i = 0
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      if (keepSpace) {
        text += ' '
        map.push(i)
      }
      i = j
    } else {
      text += src[i]
      map.push(i)
      i++
    }
  }
  return { text, map }
}

/** Find `needle` in a normalized document and map the match back to offsets. */
function matchNormalized(doc: string, chunk: string, keepSpace: boolean): HighlightRange | null {
  const n = normalize(chunk, keepSpace).text.trim()
  if (!n) return null
  const hay = normalize(doc, keepSpace)
  const at = hay.text.indexOf(n)
  if (at < 0) return null
  // needle is trimmed, so its first char sits at a non-space position.
  const start = hay.map[at]
  const end = hay.map[at + n.length - 1] + 1
  return { start, end }
}

/**
 * Locate `chunk` inside `doc`, returning the range in `doc`'s own coordinates.
 *
 * Graph chunks are a slice of the stored document, but the text passes through
 * a tokenizer that re-flows whitespace (and PDF extraction adds line breaks
 * that are not in the chunked copy). So try, in order: exact substring, trimmed
 * exact, whitespace-collapsed, whitespace-stripped. Returns null when the
 * passage cannot be located — callers should then show the chunk on its own
 * rather than guess.
 */
export function findHighlightRange(doc: string, chunk: string): HighlightRange | null {
  if (!doc || !chunk) return null

  const exact = doc.indexOf(chunk)
  if (exact >= 0) return { start: exact, end: exact + chunk.length }

  const trimmed = chunk.trim()
  if (trimmed && trimmed !== chunk) {
    const at = doc.indexOf(trimmed)
    if (at >= 0) return { start: at, end: at + trimmed.length }
  }

  return matchNormalized(doc, chunk, true) ?? matchNormalized(doc, chunk, false)
}

/**
 * Locate several passages in one document, returning sorted, non-overlapping
 * ranges. Overlapping matches (adjacent chunks share an overlap window) collapse
 * into one so the rendered `<mark>` runs never nest.
 */
export function findAllHighlightRanges(doc: string, texts: string[]): HighlightRange[] {
  const ranges = texts
    .map(t => findHighlightRange(doc, t))
    .filter((r): r is HighlightRange => r !== null)
    .sort((a, b) => a.start - b.start)

  const merged: HighlightRange[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end)
      continue
    }
    merged.push({ ...r })
  }
  return merged
}
