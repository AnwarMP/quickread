import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { GlossaryTerm, Highlight, Rect } from '../../../shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface SelectionInfo {
  text: string
  parts: { page: number; rects: Rect[] }[]
  /** Screen position of the end of the selection, for placing the toolbar. */
  anchor: { x: number; y: number }
}

export interface Anchor {
  left: number
  top: number
  bottom: number
}

export interface ControllerEvents {
  onPage(page: number): void
  onTerm(term: string, at: Anchor): void
  onCite(key: string, at: Anchor): void
  onSelection(sel: SelectionInfo | null): void
  onHighlight(id: string, at: Anchor): void
  /** The reader is about to follow one of the PDF's own internal links. */
  onFollowLink(): void
}

interface PageView {
  div: HTMLDivElement
  viewport: { convertToViewportPoint(x: number, y: number): number[]; height: number }
  textLayer?: { div: HTMLDivElement }
}

const anchorOf = (r: DOMRect): Anchor => ({ left: r.left, top: r.top, bottom: r.bottom })
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const norm = (s: string): string => s.toLowerCase().replace(/[\s-]+/g, ' ')
const CITE = /\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g

/** Thin wrapper around PDF.js's viewer that adds term/citation marks and highlights. */
export class PdfController {
  private bus = new EventBus()
  private links = new PDFLinkService({ eventBus: this.bus })
  private viewer: PDFViewer
  private doc: PDFDocumentProxy | null = null
  private task: ReturnType<typeof pdfjs.getDocument> | null = null
  private termRe: RegExp | null = null
  private termKey = new Map<string, string>()
  private refKeys = new Set<string>()
  private highlights: Highlight[] = []
  private resize: ResizeObserver
  /** Resolves once the current document's pages can be scrolled to. */
  ready: Promise<void> = Promise.resolve()

  constructor(
    private container: HTMLDivElement,
    viewerEl: HTMLDivElement,
    private events: ControllerEvents
  ) {
    this.viewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus: this.bus,
      linkService: this.links,
      textLayerMode: 1
    })
    this.links.setViewer(this.viewer)
    this.bus.on('pagesinit', () => (this.viewer.currentScaleValue = 'auto'))
    this.bus.on('pagechanging', (e: { pageNumber: number }) => events.onPage(e.pageNumber))
    this.bus.on('textlayerrendered', (e: { pageNumber: number }) => this.decorate(e.pageNumber))
    this.bus.on('pagerendered', (e: { pageNumber: number }) => this.paintHighlights(e.pageNumber))
    container.addEventListener('click', this.onLinkClick, true)
    container.addEventListener('click', this.onClick)
    container.addEventListener('mouseup', this.onMouseUp)
    this.resize = new ResizeObserver(() => {
      const v = this.viewer.currentScaleValue
      if (this.doc && (v === 'auto' || v === 'page-width')) this.viewer.currentScaleValue = v
    })
    this.resize.observe(container)
  }

  async load(data: Uint8Array): Promise<PDFDocumentProxy> {
    await this.close()
    this.task = pdfjs.getDocument({ data: data.slice() })
    this.doc = await this.task.promise
    this.ready = new Promise((resolve) => this.bus.on('pagesinit', () => resolve(), { once: true }))
    this.viewer.setDocument(this.doc)
    this.links.setDocument(this.doc)
    return this.doc
  }

  async close(): Promise<void> {
    if (!this.task) return
    this.viewer.setDocument(null as unknown as PDFDocumentProxy)
    this.links.setDocument(null)
    await this.task.destroy()
    this.task = null
    this.doc = null
  }

  destroy(): void {
    this.resize.disconnect()
    this.container.removeEventListener('click', this.onLinkClick, true)
    this.container.removeEventListener('click', this.onClick)
    this.container.removeEventListener('mouseup', this.onMouseUp)
    void this.close()
  }

  // ----- navigation -----

  get page(): number {
    return this.viewer.currentPageNumber
  }

  get scroll(): number {
    return this.container.scrollTop
  }

  set scroll(top: number) {
    this.container.scrollTop = top
  }

  zoom(factor: number): void {
    this.viewer.currentScale = Math.min(4, Math.max(0.4, this.viewer.currentScale * factor))
  }

  fit(): void {
    this.viewer.currentScaleValue = 'auto'
  }

  /** Scroll to a page, optionally to a PDF-space y on it, and briefly mark the spot. */
  jump(page: number, y?: number): void {
    if (!this.doc) return
    const pageNumber = Math.min(Math.max(1, page), this.doc.numPages)
    this.viewer.scrollPageIntoView({
      pageNumber,
      destArray: y === undefined ? undefined : [null, { name: 'XYZ' }, null, y + 48, null]
    })
    if (y !== undefined) setTimeout(() => this.flash(pageNumber, y), 120)
  }

  private pageView(page: number): PageView | null {
    return (this.viewer.getPageView(page - 1) as PageView | undefined) ?? null
  }

  private flash(page: number, y: number): void {
    const view = this.pageView(page)
    if (!view) return
    const top = view.viewport.convertToViewportPoint(0, y)[1]
    const mark = document.createElement('div')
    mark.className = 'qr-flash'
    mark.style.top = `${(top / view.viewport.height) * 100}%`
    view.div.appendChild(mark)
    setTimeout(() => mark.remove(), 2600)
  }

  private renderedPages(): number[] {
    return [...this.container.querySelectorAll<HTMLElement>('.page[data-page-number]')].map((el) =>
      Number(el.dataset.pageNumber)
    )
  }

  // ----- term and citation marks -----

  setMarks(terms: Pick<GlossaryTerm, 'term' | 'aliases'>[], refKeys: string[], show: boolean): void {
    this.termKey.clear()
    this.refKeys = new Set(refKeys)
    const alts: string[] = []
    if (show) {
      for (const t of terms) {
        for (const name of [t.term, ...t.aliases]) {
          const key = norm(name)
          if (key.length < 2 || this.termKey.has(key)) continue
          this.termKey.set(key, t.term)
          alts.push(escapeRe(name.trim()).replace(/[\s-]+/g, '[\\s-]+'))
        }
      }
    }
    alts.sort((a, b) => b.length - a.length)
    this.termRe = alts.length ? new RegExp(`(?<![\\w-])(${alts.join('|')})(?:e?s)?(?![\\w-])`, 'gi') : null
    for (const p of this.renderedPages()) this.decorate(p)
  }

  private decorate(page: number): void {
    const layer = this.pageView(page)?.textLayer?.div
    if (!layer) return
    for (const old of layer.querySelectorAll('span.qr-term, span.qr-cite')) {
      old.replaceWith(document.createTextNode(old.textContent ?? ''))
    }
    layer.normalize()
    if (!this.termRe && !this.refKeys.size) return

    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)

    for (const node of nodes) {
      const text = node.data
      if (text.trim().length < 2) continue
      const marks: { start: number; end: number; cls: string; key: string }[] = []
      if (this.termRe) {
        this.termRe.lastIndex = 0
        for (const m of text.matchAll(this.termRe)) {
          const key = this.termKey.get(norm(m[1]))
          if (key) marks.push({ start: m.index, end: m.index + m[0].length, cls: 'qr-term', key })
        }
      }
      if (this.refKeys.size) {
        for (const m of text.matchAll(CITE)) {
          for (const n of m[1].matchAll(/\d+/g)) {
            if (!this.refKeys.has(n[0])) continue
            const start = m.index + 1 + n.index
            marks.push({ start, end: start + n[0].length, cls: 'qr-cite', key: n[0] })
          }
        }
      }
      if (!marks.length) continue
      marks.sort((a, b) => a.start - b.start)
      const frag = document.createDocumentFragment()
      let at = 0
      for (const m of marks) {
        if (m.start < at) continue
        frag.append(text.slice(at, m.start))
        const span = document.createElement('span')
        span.className = m.cls
        span.dataset.key = m.key
        span.textContent = text.slice(m.start, m.end)
        frag.append(span)
        at = m.end
      }
      frag.append(text.slice(at))
      node.replaceWith(frag)
    }
  }

  // ----- highlights -----

  setHighlights(highlights: Highlight[]): void {
    this.highlights = highlights
    for (const p of this.renderedPages()) this.paintHighlights(p)
  }

  private paintHighlights(page: number): void {
    const div = this.pageView(page)?.div
    if (!div) return
    div.querySelector('.qr-hl-layer')?.remove()
    const mine = this.highlights.filter((h) => h.page === page)
    if (!mine.length) return
    const layer = document.createElement('div')
    layer.className = 'qr-hl-layer'
    for (const h of mine) {
      for (const r of h.rects) {
        const el = document.createElement('div')
        el.className = `qr-hl${h.note ? ' has-note' : ''}`
        el.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;background:${h.color}`
        layer.appendChild(el)
      }
    }
    const canvas = div.querySelector('.canvasWrapper')
    if (canvas) canvas.after(layer)
    else div.prepend(layer)
  }

  /** The page box (without border) under a screen point. */
  private pageAt(x: number, y: number): { page: number; box: DOMRect } | null {
    for (const el of this.container.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
      const box = (el.querySelector('.textLayer') ?? el.querySelector('.canvasWrapper') ?? el).getBoundingClientRect()
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        return { page: Number(el.dataset.pageNumber), box }
      }
    }
    return null
  }

  // ----- pointer handling -----

  /**
   * The PDF's own link layer sits above the text. When a link covers one of our marks
   * (a citation number, usually) our card wins; other internal links are followed as
   * usual, after telling the app so it can offer a way back.
   */
  private onLinkClick = (e: MouseEvent): void => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('.annotationLayer a')
    if (!link) return
    const mark = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el): el is HTMLElement => el instanceof HTMLElement && el.matches('.qr-term, .qr-cite'))
    if (mark?.dataset.key) {
      e.preventDefault()
      e.stopPropagation()
      const at = anchorOf(mark.getBoundingClientRect())
      if (mark.classList.contains('qr-term')) this.events.onTerm(mark.dataset.key, at)
      else this.events.onCite(mark.dataset.key, at)
    } else if (link.getAttribute('href')?.startsWith('#')) {
      this.events.onFollowLink()
    }
  }

  private onClick = (e: MouseEvent): void => {
    if (!window.getSelection()?.isCollapsed) return
    const target = e.target as HTMLElement
    const mark = target.closest<HTMLElement>('.qr-term, .qr-cite')
    if (mark?.dataset.key) {
      const at = anchorOf(mark.getBoundingClientRect())
      if (mark.classList.contains('qr-term')) this.events.onTerm(mark.dataset.key, at)
      else this.events.onCite(mark.dataset.key, at)
      return
    }
    const hit = this.pageAt(e.clientX, e.clientY)
    if (!hit) return
    const fx = (e.clientX - hit.box.left) / hit.box.width
    const fy = (e.clientY - hit.box.top) / hit.box.height
    const h = this.highlights.find(
      (hl) => hl.page === hit.page && hl.rects.some((r) => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h)
    )
    if (h) this.events.onHighlight(h.id, { left: e.clientX, top: e.clientY - 8, bottom: e.clientY + 8 })
  }

  private onMouseUp = (): void => {
    // Let the browser settle the selection first.
    setTimeout(() => this.events.onSelection(this.readSelection()), 0)
  }

  private readSelection(): SelectionInfo | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!this.container.contains(range.commonAncestorContainer)) return null
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) return null

    const raw = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 3)
    if (!raw.length) return null
    const byPage = new Map<number, { box: DOMRect; rects: DOMRect[] }>()
    for (const r of raw) {
      const hit = this.pageAt(r.left + r.width / 2, r.top + r.height / 2)
      if (!hit) continue
      // Ignore boxes of whole containers that the range happens to enclose.
      if (r.height > hit.box.height * 0.2) continue
      const entry = byPage.get(hit.page) ?? { box: hit.box, rects: [] }
      entry.rects.push(r)
      byPage.set(hit.page, entry)
    }
    const parts = [...byPage.entries()].map(([page, { box, rects }]) => ({
      page,
      rects: mergeLines(rects).map((r) => ({
        x: (r.left - box.left) / box.width,
        y: (r.top - box.top) / box.height,
        w: (r.right - r.left) / box.width,
        h: (r.bottom - r.top) / box.height
      }))
    }))
    if (!parts.length) return null
    const last = raw[raw.length - 1]
    return { text, parts, anchor: { x: last.right, y: last.bottom } }
  }
}

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** Merge the per-span rectangles of a selection into one box per text line. */
function mergeLines(rects: DOMRect[]): Box[] {
  const sorted = rects
    .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }))
    .sort((a, b) => a.top - b.top || a.left - b.left)
  const out: Box[] = []
  for (const r of sorted) {
    const line = out.find((o) => {
      const overlap = Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top)
      const sameLine = overlap > 0.5 * Math.min(o.bottom - o.top, r.bottom - r.top)
      return sameLine && r.left <= o.right + 12 && r.right >= o.left - 12
    })
    if (line) {
      line.left = Math.min(line.left, r.left)
      line.right = Math.max(line.right, r.right)
      line.top = Math.min(line.top, r.top)
      line.bottom = Math.max(line.bottom, r.bottom)
    } else out.push(r)
  }
  return out
}
