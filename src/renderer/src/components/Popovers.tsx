import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Chunk, DocIndex, GlossaryTerm, Highlight, Reference, Resource } from '../../../shared/types'
import type { Anchor } from '../lib/controller'
import { arxivId, locate, mentionsOf, refTitle, termNames } from '../lib/brain'

export const COLORS = ['#ffe066', '#b9f18c', '#a5d8ff', '#ffc9de']

/** A floating card placed under (or above) an anchor and kept inside the window. */
export function Popover(props: { at: Anchor; onClose: () => void; children: ReactNode; width?: number }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const width = props.width ?? 380

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const left = Math.max(12, Math.min(props.at.left, window.innerWidth - width - 12))
    const below = props.at.bottom + 8
    const top = below + h > window.innerHeight - 12 ? Math.max(12, props.at.top - h - 8) : below
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose()
    }
    window.addEventListener('keydown', onKey)
    // Registered on the next tick so the click that opened the popover does not close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [props.onClose])

  return (
    <div
      ref={ref}
      className="popover"
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      <button className="pop-close" aria-label="Close" onClick={props.onClose}>
        ✕
      </button>
      {props.children}
    </div>
  )
}

/** The defining passage, with the model's chosen quote marked when it can be found verbatim. */
function Passage({ chunk, quote }: { chunk: Chunk; quote?: string }): ReactNode {
  const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const text = chunk.text
  const q = quote ? flat(quote).replace(/^["“]|["”.]$/g, '') : ''
  const at = q.length > 12 ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (at < 0) return <p className="passage">{text}</p>
  return (
    <p className="passage">
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </p>
  )
}

export function TermCard(props: {
  term: GlossaryTerm
  index: DocIndex
  llmOk: boolean
  onJump: (page: number, y?: number) => void
  onDeeper: (term: GlossaryTerm) => void
  onRetry: (term: GlossaryTerm) => void
  onTerm: (name: string) => void
}): ReactNode {
  const { term, index } = props
  const [full, setFull] = useState(false)
  const chunk = term.chunkId !== undefined ? index.chunks[term.chunkId] : undefined
  const mentions = mentionsOf(index, termNames(term))
  const pages = [...new Set(mentions.map((c) => c.page))]

  return (
    <div className="term-card">
      <div className="card-head">
        <h3>{term.term}</h3>
        {term.aliases.length > 0 && <span className="muted">also: {term.aliases.join(', ')}</span>}
      </div>

      {term.status === 'pending' && !term.summary && (
        <p className="muted working">
          {props.llmOk ? 'Writing a summary…' : 'The local model is not running, so there is no summary.'}
        </p>
      )}
      {term.status === 'error' && (
        <p className="muted">
          Could not write a summary ({term.error}).{' '}
          <button className="link" onClick={() => props.onRetry(term)}>
            Try again
          </button>
        </p>
      )}
      {term.summary && <p className="summary">{term.summary}</p>}

      {chunk && (
        <div className="source">
          <div className="source-head">
            <span className="label">
              In the paper · {chunk.section ? `${chunk.section} · ` : ''}p. {chunk.page}
            </span>
            <button className="link" onClick={() => setFull(!full)}>
              {full ? 'Show less' : 'Full passage'}
            </button>
          </div>
          {full ? (
            <Passage chunk={chunk} quote={term.quote} />
          ) : (
            <p className="passage">{term.quote ? `“${term.quote.replace(/^["“]|["”]$/g, '')}”` : `${chunk.text.slice(0, 220)}…`}</p>
          )}
        </div>
      )}

      {term.deps && term.deps.length > 0 && (
        <div className="mentions">
          <span className="label">Builds on</span>
          {term.deps.map((d) => (
            <button key={d} className="chip" onClick={() => props.onTerm(d)}>
              {d}
            </button>
          ))}
        </div>
      )}

      {pages.length > 0 && (
        <div className="mentions">
          <span className="label">Mentioned on</span>
          {pages.slice(0, 14).map((p) => {
            const first = mentions.find((c) => c.page === p)
            return (
              <button key={p} className="chip" onClick={() => props.onJump(p, first?.y)}>
                {p}
              </button>
            )
          })}
        </div>
      )}

      <div className="card-actions">
        {chunk && (
          <button
            className="btn primary"
            onClick={() => {
              const spot = locate(chunk, term.quote)
              props.onJump(spot.page, spot.y)
            }}
          >
            Go to definition
          </button>
        )}
        <button className="btn" onClick={() => props.onDeeper(term)} disabled={!props.llmOk}>
          Dive deeper
        </button>
      </div>
    </div>
  )
}

export function ResourceList(props: { items: Resource[]; onOpenPdf: (url: string) => void }): ReactNode {
  return (
    <ul className="resources">
      {props.items.map((r) => (
        <li key={r.url}>
          <div className="res-title">{r.title}</div>
          <div className="muted small">
            {[r.source, r.year, r.snippet].filter(Boolean).join(' · ')}
          </div>
          <div className="res-actions">
            <button className="link" onClick={() => void window.qr.openExternal(r.url)}>
              Open in browser
            </button>
            {r.pdfUrl && (
              <button className="link" onClick={() => props.onOpenPdf(r.pdfUrl!)}>
                Read here
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function CiteCard(props: {
  reference: Reference
  onJump: (page: number, y?: number) => void
  onOpenPdf: (url: string) => void
}): ReactNode {
  const { reference } = props
  const [found, setFound] = useState<Resource[] | 'loading' | null>(null)

  const find = async (): Promise<void> => {
    setFound('loading')
    const title = refTitle(reference.text)
    const id = arxivId(reference.text)
    // An arXiv id in the entry is an exact match, so it goes first.
    const exact: Resource[] = id
      ? [{ title, url: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`, source: 'arXiv', snippet: 'Exact match from the reference' }]
      : []
    const rest = await window.qr.search(title)
    setFound([...exact, ...rest.filter((r) => !id || !r.url.includes(id))])
  }

  return (
    <div className="term-card">
      <div className="card-head">
        <h3>Reference [{reference.key}]</h3>
      </div>
      <p className="passage">{reference.text}</p>
      {found === 'loading' && <p className="muted working">Searching…</p>}
      {Array.isArray(found) &&
        (found.length ? (
          <ResourceList items={found.slice(0, 4)} onOpenPdf={props.onOpenPdf} />
        ) : (
          <p className="muted">Nothing found online for this title.</p>
        ))}
      <div className="card-actions">
        <button className="btn primary" onClick={() => void find()} disabled={found === 'loading'}>
          Find online
        </button>
        <button className="btn" onClick={() => props.onJump(reference.page, reference.y)}>
          Go to reference list
        </button>
      </div>
    </div>
  )
}

export function HighlightCard(props: {
  highlight: Highlight
  onChange: (patch: Partial<Highlight>) => void
  onDelete: () => void
}): ReactNode {
  const { highlight } = props
  return (
    <div className="term-card">
      <div className="card-head">
        <h3>Highlight</h3>
        <span className="muted">page {highlight.page}</span>
      </div>
      <p className="passage">“{highlight.text.slice(0, 240)}{highlight.text.length > 240 ? '…' : ''}”</p>
      <textarea
        className="note"
        placeholder="Add a note"
        defaultValue={highlight.note ?? ''}
        onBlur={(e) => props.onChange({ note: e.target.value.trim() || undefined })}
      />
      <div className="card-actions">
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch${c === highlight.color ? ' on' : ''}`}
              style={{ background: c }}
              aria-label="Highlight colour"
              onClick={() => props.onChange({ color: c })}
            />
          ))}
        </div>
        <button className="btn danger" onClick={props.onDelete}>
          Remove
        </button>
      </div>
    </div>
  )
}
