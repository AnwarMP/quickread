import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Chunk, DocIndex, Reference, Section } from '../../../shared/types'

export const INDEX_VERSION = 2

interface Line {
  text: string
  page: number
  x: number
  /** Top of the line in PDF space. */
  y: number
  h: number
}

const HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z][^.!?]{2,70})$/
const NAMED_HEADING = /^(abstract|introduction|conclusions?|acknowledge?ments?|appendix(?:\s+\w+)?)$/i
const REFS_HEADING = /^(references|bibliography)$/i

async function readLines(pdf: PDFDocumentProxy): Promise<Line[]> {
  const lines: Line[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    let cur: Line | null = null
    const flush = (): void => {
      if (cur) {
        cur.text = cur.text.replace(/\s+/g, ' ').trim()
        // Drop empty lines and bare page numbers.
        if (cur.text && !/^\d{1,4}$/.test(cur.text)) lines.push(cur)
      }
      cur = null
    }
    for (const item of content.items) {
      if (!('str' in item)) continue
      const t = item.transform as number[]
      // Skip rotated text such as the arXiv stamp in the margin.
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue
      const h = item.height || Math.abs(t[3]) || 10
      const top = t[5] + h
      if (cur && Math.abs(top - cur.y) > Math.max(cur.h, h) * 1.3) flush()
      if (!cur) {
        if (!item.str.trim()) continue
        cur = { text: '', page: p, x: t[4], y: top, h }
      }
      cur.text += item.str
      cur.h = Math.max(cur.h, h)
      if (item.hasEOL) flush()
    }
    flush()
    page.cleanup()
  }
  return lines
}

function join(a: string, b: string): string {
  if (!a) return b
  // Re-join words hyphenated across a line break.
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b
  return `${a} ${b}`
}

async function readTitle(pdf: PDFDocumentProxy, lines: Line[], fallback: string): Promise<string> {
  try {
    const meta = await pdf.getMetadata()
    const t = String((meta.info as Record<string, unknown>)?.Title ?? '').trim()
    if (t.length > 4 && !/\.(pdf|tex|dvi|docx?)$/i.test(t) && !/^(untitled|microsoft word)/i.test(t)) return t
  } catch {
    /* fall through to the layout guess */
  }
  const first = lines.filter((l) => l.page === 1).slice(0, 25)
  const biggest = Math.max(0, ...first.map((l) => l.h))
  const title = first
    .filter((l) => l.h >= biggest * 0.95)
    .slice(0, 3)
    .map((l) => l.text)
    .join(' ')
  return title.length > 4 ? title : fallback
}

export async function extractDoc(pdf: PDFDocumentProxy, fallbackTitle: string): Promise<DocIndex> {
  const lines = await readLines(pdf)
  const chunks: Chunk[] = []
  const refs: Reference[] = []
  const sections: Section[] = []

  let cur: Chunk | null = null
  let section: string | undefined
  let inRefs = false
  let ref: Reference | null = null

  const flush = (): void => {
    if (cur && cur.text.length > 30) chunks.push({ ...cur, id: chunks.length })
    cur = null
  }

  for (const line of lines) {
    const text = line.text
    const numbered = HEADING.exec(text)
    const isHeading =
      (numbered !== null && !/[,;:]$/.test(text) && text.split(' ').length <= 10) ||
      NAMED_HEADING.test(text) ||
      REFS_HEADING.test(text)

    if (inRefs) {
      const m = /^\[(\d{1,3})\]\s*(.*)$/.exec(text)
      const leavesRefs =
        /^(appendix|supplementa)/i.test(text) ||
        (ref !== null && !m && line.page !== ref.page && /\.$/.test(ref.text) && !/^[a-z]/.test(text) && isHeading)
      if (leavesRefs) {
        inRefs = false
        ref = null
      } else {
        if (m) {
          ref = { key: m[1], text: m[2], page: line.page, x: line.x, y: line.y }
          refs.push(ref)
        } else if (ref) {
          // A reference that finished on a previous page is not continued by unrelated text.
          if (line.page !== ref.page && /\.$/.test(ref.text) && ref.text.length > 60) {
            inRefs = false
            ref = null
          } else ref.text = join(ref.text, text)
        }
        if (inRefs) continue
      }
    }

    if (isHeading) {
      flush()
      section = text
      sections.push({ title: text, page: line.page, x: line.x, y: line.y })
      if (REFS_HEADING.test(text)) inRefs = true
      continue
    }

    const full = cur !== null && cur.text.length > 900 && /[.!?:]$/.test(cur.text)
    if (cur && (full || cur.text.length > 1500)) flush()
    if (!cur) cur = { id: 0, page: line.page, x: line.x, y: line.y, text: '', section, lines: [] }
    cur.lines!.push({ o: cur.text.length, p: line.page, y: line.y })
    cur.text = join(cur.text, text)
  }
  flush()

  return {
    version: INDEX_VERSION,
    title: await readTitle(pdf, lines, fallbackTitle),
    pages: pdf.numPages,
    chunks,
    refs,
    sections
  }
}
