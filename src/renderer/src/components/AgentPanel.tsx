import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage } from '../../../shared/types'
import { Markdown } from './Markdown'
import { ResourceList } from './Popovers'

export function AgentPanel(props: {
  messages: ChatMessage[]
  busy: boolean
  llmOk: boolean
  model: string
  quote: string | null
  clearQuote: () => void
  onAsk: (text: string) => void
  onStop: () => void
  onClear: () => void
  onPage: (page: number) => void
  onOpenPdf: (url: string) => void
  onFindRef: (text: string) => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Braces matter: newer Chromium returns a promise here, which React would treat as a cleanup.
    void end.current?.scrollIntoView({ block: 'end' })
  }, [props.messages])
  useEffect(() => {
    if (props.quote) input.current?.focus()
  }, [props.quote])

  const send = (): void => {
    const text = draft.trim()
    if (!text || props.busy || !props.llmOk) return
    setDraft('')
    props.onAsk(text)
  }

  return (
    <aside className="agent">
      <div className="agent-head">
        <div>
          <strong>Reading companion</strong>
          <div className="muted small">{props.llmOk ? `${props.model} · runs on this Mac` : 'Local model not running'}</div>
        </div>
        {props.messages.length > 0 && (
          <button className="link" onClick={props.onClear}>
            Clear
          </button>
        )}
      </div>

      <div className="agent-body">
        {props.messages.length === 0 && (
          <div className="empty">
            <p>Ask about anything in this paper. Answers point back to the pages they come from.</p>
            <p>Use “Dive deeper” on a term to get a fuller explanation and further reading from the paper’s references and the web.</p>
          </div>
        )}
        {props.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'user' ? <Markdown text={m.text} /> : <Markdown text={m.text} onPage={props.onPage} />}
            {m.pending && !m.text && <div className="muted small working">{m.status ?? 'Thinking…'}</div>}
            {m.paperRefs && m.paperRefs.length > 0 && (
              <div className="res-group">
                <div className="label">Cited by this paper</div>
                <ul className="resources">
                  {m.paperRefs.map((r) => (
                    <li key={r.key}>
                      <div className="small">
                        [{r.key}] {r.text}
                      </div>
                      <div className="res-actions">
                        <button className="link" onClick={() => props.onPage(r.page)}>
                          Go to reference list
                        </button>
                        <button className="link" onClick={() => props.onFindRef(r.text)}>
                          Find online
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {m.resources && m.resources.length > 0 && (
              <div className="res-group">
                <div className="label">From the web</div>
                <ResourceList items={m.resources} onOpenPdf={props.onOpenPdf} />
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>

      <div className="composer">
        {props.quote && (
          <div className="quote">
            <span>“{props.quote.slice(0, 160)}{props.quote.length > 160 ? '…' : ''}”</span>
            <button className="icon" aria-label="Remove quoted text" onClick={props.clearQuote}>
              ×
            </button>
          </div>
        )}
        <textarea
          ref={input}
          rows={2}
          value={draft}
          placeholder={props.quote ? 'Ask about the selected text' : 'Ask about this paper'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {props.busy ? (
          <button className="btn" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={send} disabled={!draft.trim() || !props.llmOk}>
            Ask
          </button>
        )}
      </div>
    </aside>
  )
}
