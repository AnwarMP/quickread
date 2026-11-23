import { useState, type ReactNode } from 'react'
import type { DocIndex, DocState, GlossaryTerm } from '../../../shared/types'

export type SideTab = 'contents' | 'glossary' | 'highlights' | 'bookmarks'

const TABS: { id: SideTab; label: string }[] = [
  { id: 'contents', label: 'Contents' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'bookmarks', label: 'Bookmarks' }
]

export function Sidebar(props: {
  tab: SideTab
  setTab: (t: SideTab) => void
  index: DocIndex | null
  state: DocState
  page: number
  onJump: (page: number, y?: number) => void
  onTerm: (term: GlossaryTerm, el: HTMLElement) => void
  onRemoveBookmark: (id: string) => void
}): ReactNode {
  const { tab, index, state } = props
  const [filter, setFilter] = useState('')
  const terms = state.glossary.filter((t) => t.term.toLowerCase().includes(filter.toLowerCase()))
  const highlights = [...state.highlights].sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y)
  const bookmarks = [...state.bookmarks].sort((a, b) => a.page - b.page)

  return (
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => props.setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="side-body">
        {tab === 'contents' &&
          (index?.sections.length ? (
            <ul className="list">
              {index.sections.map((s, i) => {
                const depth = (/^(\d+(?:\.\d+)*)/.exec(s.title)?.[1].split('.').length ?? 1) - 1
                return (
                  <li key={i}>
                    <button style={{ paddingLeft: 12 + depth * 14 }} onClick={() => props.onJump(s.page, s.y)}>
                      <span className="grow">{s.title}</span>
                      <span className="muted small">{s.page}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="empty">{index ? 'No section headings were found in this PDF.' : 'Reading the paper…'}</p>
          ))}

        {tab === 'glossary' && (
          <>
            <input className="filter" placeholder="Filter terms" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {terms.length ? (
              <ul className="list">
                {terms.map((t) => (
                  <li key={t.term}>
                    <button onClick={(e) => props.onTerm(t, e.currentTarget)}>
                      <span className="grow">
                        <span className="term-name">{t.term}</span>
                        {t.summary && <span className="term-sum">{t.summary}</span>}
                      </span>
                      {t.status === 'pending' && <span className="dot" title="Summary not written yet" />}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">
                {state.glossary.length
                  ? 'No terms match.'
                  : state.glossaryDone
                    ? 'No terms were found. Select any text and choose Define.'
                    : 'Terms appear here once the paper has been indexed. You can also select any text and choose Define.'}
              </p>
            )}
          </>
        )}

        {tab === 'highlights' &&
          (highlights.length ? (
            <ul className="list">
              {highlights.map((h) => (
                <li key={h.id}>
                  <button onClick={() => props.onJump(h.page)}>
                    <span className="bar" style={{ background: h.color }} />
                    <span className="grow">
                      <span className="hl-text">{h.text}</span>
                      {h.note && <span className="term-sum">{h.note}</span>}
                    </span>
                    <span className="muted small">{h.page}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Select text in the paper and pick a colour to highlight it.</p>
          ))}

        {tab === 'bookmarks' &&
          (bookmarks.length ? (
            <ul className="list">
              {bookmarks.map((b) => (
                <li key={b.id} className="row">
                  <button onClick={() => props.onJump(b.page)}>
                    <span className="grow">{b.label}</span>
                    <span className="muted small">{b.page}</span>
                  </button>
                  <button className="icon" aria-label="Remove bookmark" onClick={() => props.onRemoveBookmark(b.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Bookmark the current page (p. {props.page}) from the toolbar.</p>
          ))}
      </div>
    </aside>
  )
}
