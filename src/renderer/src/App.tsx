import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  ChatMessage,
  DocIndex,
  DocState,
  GlossaryTerm,
  Highlight,
  LibraryEntry,
  LlmStatus,
  Settings
} from '../../shared/types'
import { PdfController, type Anchor, type SelectionInfo } from './lib/controller'
import { extractDoc, INDEX_VERSION } from './lib/extract'
import {
  chat,
  defineTerm,
  embedIndex,
  extractGlossary,
  mentionsOf,
  mostRelevant,
  parseJson,
  refsNear,
  refTitle,
  retrieve,
  termNames,
  uid
} from './lib/brain'
import { Sidebar, type SideTab } from './components/Sidebar'
import { AgentPanel } from './components/AgentPanel'
import { CiteCard, COLORS, HighlightCard, Popover, TermCard } from './components/Popovers'

type Pop =
  | { kind: 'term'; term: string; at: Anchor }
  | { kind: 'cite'; key: string; at: Anchor }
  | { kind: 'highlight'; id: string; at: Anchor }

const fileName = (path: string): string => path.split('/').pop()?.replace(/\.pdf$/i, '') ?? path
const sameTerm = (t: GlossaryTerm, name: string): boolean =>
  termNames(t).some((n) => n.toLowerCase() === name.toLowerCase())

export function App(): ReactNode {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [llm, setLlm] = useState<LlmStatus>({ ok: false, models: [] })
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [index, setIndex] = useState<DocIndex | null>(null)
  const [state, setState] = useState<DocState | null>(null)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [pop, setPop] = useState<Pop | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [back, setBack] = useState<{ page: number; scroll: number }[]>([])
  const [tab, setTab] = useState<SideTab>('contents')
  const [showAgent, setShowAgent] = useState(true)
  const [showMarks, setShowMarks] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [quote, setQuote] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const ctrl = useRef<PdfController | null>(null)
  const stateRef = useRef<DocState | null>(null)
  const indexRef = useRef<DocIndex | null>(null)
  const settingsRef = useRef<Settings | null>(null)
  const run = useRef(0) // bumps whenever another document is opened
  const worker = useRef(0)
  const priority = useRef<string | null>(null)
  const chatId = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------- persistence ----------

  const save = useCallback((now = false): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const write = (): void => {
      if (stateRef.current) void window.qr.saveState(stateRef.current)
    }
    if (now) write()
    else saveTimer.current = setTimeout(write, 600)
  }, [])

  const update = useCallback(
    (fn: (s: DocState) => DocState): void => {
      if (!stateRef.current) return
      stateRef.current = fn(stateRef.current)
      setState(stateRef.current)
      save()
    },
    [save]
  )

  const patchTerm = useCallback(
    (name: string, patch: Partial<GlossaryTerm>): void =>
      update((s) => ({ ...s, glossary: s.glossary.map((t) => (t.term === name ? { ...t, ...patch } : t)) })),
    [update]
  )

  const patchMsg = useCallback(
    (id: string, patch: Partial<ChatMessage>): void =>
      update((s) => ({ ...s, chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    [update]
  )

  // ---------- indexing ----------

  /** Writes the summaries for pending glossary terms, one at a time, clicked term first. */
  const runWorker = useCallback(
    async (token: number): Promise<void> => {
      if (worker.current === token) return
      worker.current = token
      try {
        while (token === run.current) {
          const idx = indexRef.current
          const pending = stateRef.current?.glossary.filter((t) => t.status === 'pending') ?? []
          if (!idx || !pending.length) break
          const next = pending.find((t) => t.term === priority.current) ?? pending[0]
          setStatus(`Writing term summaries… ${pending.length} left`)
          try {
            const def = await defineTerm(idx, termNames(next))
            if (token !== run.current) return
            patchTerm(next.term, { status: 'ready', error: undefined, ...def })
          } catch (e) {
            if (token !== run.current) return
            patchTerm(next.term, { status: 'error', error: e instanceof Error ? e.message : String(e) })
          }
        }
        if (token === run.current) setStatus('')
      } finally {
        if (worker.current === token) worker.current = 0
      }
    },
    [patchTerm]
  )

  const runIndexing = useCallback(
    async (token: number): Promise<void> => {
      const s = await window.qr.llmStatus()
      setLlm(s)
      let idx = indexRef.current
      const cfg = settingsRef.current
      if (!s.ok || !idx || !cfg || token !== run.current) {
        setStatus('')
        return
      }
      if (!idx.embeddings || idx.embedModel !== cfg.embedModel) {
        setStatus('Indexing passages…')
        try {
          idx = await embedIndex(idx, cfg.embedModel)
          if (token !== run.current) return
          indexRef.current = idx
          setIndex(idx)
          await window.qr.saveIndex(stateRef.current!.id, idx)
        } catch (e) {
          // Lookups still work on keyword matching without embeddings.
          setError(`Passage embeddings are unavailable, using keyword search instead. ${e instanceof Error ? e.message : ''}`)
        }
      }
      if (!stateRef.current?.glossaryDone) {
        setStatus('Finding key terms…')
        try {
          const terms = await extractGlossary(idx, (done, total) =>
            setStatus(total > 1 ? `Finding key terms… part ${Math.min(done + 1, total)} of ${total}` : 'Finding key terms…')
          )
          if (token !== run.current) return
          update((st) => ({
            ...st,
            glossaryDone: true,
            glossary: [...st.glossary.filter((m) => !terms.some((t) => sameTerm(t, m.term))), ...terms].sort((a, b) =>
              a.term.localeCompare(b.term)
            )
          }))
        } catch (e) {
          setError(`Could not build the glossary. ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      void runWorker(token)
    },
    [runWorker, update]
  )

  // ---------- opening documents ----------

  const openPath = useCallback(
    async (path: string): Promise<void> => {
      const c = ctrl.current
      if (!c) return
      const token = ++run.current
      save(true)
      setError('')
      setPop(null)
      setSelection(null)
      setBack([])
      setPage(1)
      try {
        setStatus('Opening…')
        const res = await window.qr.openDoc(path)
        const pdf = await c.load(res.data)
        let idx = res.index?.version === INDEX_VERSION ? res.index : null
        if (!idx) {
          setStatus('Reading the paper…')
          idx = await extractDoc(pdf, fileName(path))
          await window.qr.saveIndex(res.id, idx)
        }
        if (token !== run.current) return
        indexRef.current = idx
        setIndex(idx)
        const prev = res.state
        const st: DocState = {
          id: res.id,
          path,
          title: idx.title,
          lastPage: prev?.lastPage ?? 1,
          opened: Date.now(),
          highlights: prev?.highlights ?? [],
          bookmarks: prev?.bookmarks ?? [],
          glossary: prev?.glossary ?? [],
          glossaryDone: prev?.glossaryDone,
          chat: (prev?.chat ?? []).map((m) => ({ ...m, pending: false, status: undefined }))
        }
        stateRef.current = st
        setState(st)
        save(true)
        if (st.lastPage > 1) void c.ready.then(() => token === run.current && c.jump(st.lastPage))
        await runIndexing(token)
      } catch (e) {
        if (token === run.current) {
          setStatus('')
          setError(`Could not open that PDF. ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    },
    [runIndexing, save]
  )

  const pickPdf = useCallback(async (): Promise<void> => {
    const path = await window.qr.pickPdf()
    if (path) await openPath(path)
  }, [openPath])

  const openFromWeb = useCallback(
    async (url: string): Promise<void> => {
      setStatus('Downloading the paper…')
      setError('')
      try {
        await openPath(await window.qr.downloadPdf(url))
      } catch (e) {
        setStatus('')
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [openPath]
  )

  const closeDoc = useCallback(async (): Promise<void> => {
    save(true)
    run.current++
    stateRef.current = null
    indexRef.current = null
    setState(null)
    setIndex(null)
    setStatus('')
    setPop(null)
    await ctrl.current?.close()
    setLibrary(await window.qr.library())
  }, [save])

  // ---------- navigation ----------

  const jump = useCallback((toPage: number, y?: number): void => {
    const c = ctrl.current
    if (!c) return
    setBack((b) => [...b.slice(-19), { page: c.page, scroll: c.scroll }])
    setPop(null)
    c.jump(toPage, y)
  }, [])

  const goBack = useCallback((): void => {
    setBack((b) => {
      const last = b[b.length - 1]
      if (last && ctrl.current) ctrl.current.scroll = last.scroll
      return b.slice(0, -1)
    })
  }, [])

  // ---------- terms ----------

  const openTerm = useCallback(
    (name: string, at: Anchor): void => {
      const st = stateRef.current
      const idx = indexRef.current
      if (!st || !idx) return
      let term = st.glossary.find((t) => sameTerm(t, name))
      if (!term) {
        term = { term: name, aliases: [], mentions: mentionsOf(idx, [name]).length, status: 'pending', manual: true }
        const added = term
        update((s) => ({ ...s, glossary: [...s.glossary, added].sort((a, b) => a.term.localeCompare(b.term)) }))
      } else if (term.status === 'error') {
        patchTerm(term.term, { status: 'pending', error: undefined })
      }
      priority.current = term.term
      setSelection(null)
      setPop({ kind: 'term', term: term.term, at })
      void runWorker(run.current)
    },
    [patchTerm, runWorker, update]
  )

  // ---------- agent ----------

  const pushMsgs = useCallback(
    (...msgs: ChatMessage[]): void => update((s) => ({ ...s, chat: [...s.chat, ...msgs] })),
    [update]
  )

  const ask = useCallback(
    async (text: string): Promise<void> => {
      const idx = indexRef.current
      const st = stateRef.current
      if (!idx || !st) return
      const q = quote
      setQuote(null)
      const history = st.chat.slice(-6).map((m) => ({ role: m.role, content: m.text }))
      const aid = uid()
      pushMsgs(
        { id: uid(), role: 'user', text: q ? `> ${q}\n\n${text}` : text },
        { id: aid, role: 'assistant', text: '', pending: true, status: 'Reading the paper…' }
      )
      setBusy(true)
      chatId.current = aid
      let acc = ''
      try {
        const hits = await retrieve(idx, q ? `${text} ${q}` : text, 6)
        const excerpts = hits.map((c) => `[p. ${c.page}${c.section ? `, ${c.section}` : ''}]\n${c.text}`).join('\n\n')
        patchMsg(aid, { status: 'Thinking…' })
        const out = await chat(
          [
            {
              role: 'system',
              content: `You are a reading companion for the paper "${idx.title}". The reader is on page ${ctrl.current?.page ?? 1}.
Answer from the excerpts when the question is about the paper, and cite the pages you used like [p. 3].
When the excerpts are not enough, use your general knowledge and say that you are doing so.
Be concise and plain. Explain jargon instead of repeating it.`
            },
            ...history,
            {
              role: 'user',
              content: `Excerpts from the paper:\n${excerpts}\n\n${q ? `Selected text: "${q}"\n\n` : ''}Question: ${text}`
            }
          ],
          { id: aid, onDelta: (d) => patchMsg(aid, { text: (acc += d) }) }
        )
        patchMsg(aid, { text: out, pending: false, status: undefined })
      } catch (e) {
        const stopped = /abort/i.test(String(e))
        patchMsg(aid, {
          text: acc || (stopped ? '*Stopped.*' : `The model could not answer: ${e instanceof Error ? e.message : String(e)}`),
          pending: false,
          status: undefined
        })
      } finally {
        setBusy(false)
      }
    },
    [patchMsg, pushMsgs, quote]
  )

  const deepDive = useCallback(
    async (term: GlossaryTerm): Promise<void> => {
      const idx = indexRef.current
      if (!idx) return
      setPop(null)
      setShowAgent(true)
      const names = termNames(term)
      const aid = uid()
      const paperRefs = refsNear(idx, names)
      pushMsgs(
        { id: uid(), role: 'user', text: `Go deeper on **${term.term}**` },
        { id: aid, role: 'assistant', text: '', pending: true, status: 'Working out what to search for…', paperRefs }
      )
      setBusy(true)
      chatId.current = aid
      let acc = ''
      try {
        const plan = parseJson<{ queries?: unknown }>(
          await chat(
            [
              {
                role: 'system',
                content:
                  'Write 2 short web search queries that would find good background reading on a concept from a research paper: one for an encyclopedia-style overview, one for the key paper or tutorial. Answer with JSON only: {"queries":["...","..."]}'
              },
              { role: 'user', content: `Paper: ${idx.title}\nConcept: ${term.term}\n${term.summary ?? ''}` }
            ],
            { json: true, id: aid, temperature: 0 }
          )
        )
        const queries = (Array.isArray(plan?.queries) ? plan.queries : [])
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 2)
          .slice(0, 3)
        if (!queries.length) queries.push(term.term)

        patchMsg(aid, { status: 'Searching for further reading…' })
        const found = (await Promise.all(queries.map((x) => window.qr.search(x)))).flat()
        // Search engines return loosely related hits, so keep only what is close to the concept.
        const resources = await mostRelevant(
          `${term.term}: ${term.summary ?? ''} (background for the paper "${idx.title}")`,
          found.filter((r, i) => found.findIndex((o) => o.url === r.url) === i),
          (r) => `${r.title}. ${r.snippet ?? ''}`,
          5
        )
        patchMsg(aid, { resources, status: 'Writing the explanation…' })

        const excerpts = mentionsOf(idx, names)
          .slice(0, 3)
          .map((c) => `[p. ${c.page}] ${c.text}`)
          .join('\n\n')
        const out = await chat(
          [
            {
              role: 'system',
              content: `You are a reading companion for the paper "${idx.title}". Explain a concept in more depth than the paper does: the intuition, how it works, and why it matters for this paper. Use about 180 words and plain language. Cite the paper's pages like [p. 3] where relevant.
Then add a short section under the heading line "### Where to read more" that says, in two or three sentences, which of the listed resources suits which purpose, naming them by title. Never mention a resource that is not in the lists.`
            },
            {
              role: 'user',
              content: `Concept: ${term.term}\nShort definition: ${term.summary ?? 'none yet'}\n\nHow the paper uses it:\n${excerpts || 'none'}\n\nReferences the paper cites near this concept:\n${paperRefs.map((r) => `- [${r.key}] ${r.text}`).join('\n') || 'none'}\n\nResources found on the web:\n${resources.map((r) => `- ${r.title} (${r.source}${r.year ? `, ${r.year}` : ''}) ${r.snippet ?? ''}`).join('\n') || 'none'}`
            }
          ],
          { id: aid, onDelta: (d) => patchMsg(aid, { text: (acc += d) }) }
        )
        patchMsg(aid, { text: out, pending: false, status: undefined })
      } catch (e) {
        const stopped = /abort/i.test(String(e))
        patchMsg(aid, {
          text: acc || (stopped ? '*Stopped.*' : `The model could not answer: ${e instanceof Error ? e.message : String(e)}`),
          pending: false,
          status: undefined
        })
      } finally {
        setBusy(false)
      }
    },
    [patchMsg, pushMsgs]
  )

  const findRef = useCallback(
    async (text: string): Promise<void> => {
      const aid = uid()
      const title = refTitle(text)
      pushMsgs({ id: aid, role: 'assistant', text: `Looking online for *${title}*`, pending: true, status: 'Searching…' })
      const resources = await window.qr.search(title)
      patchMsg(aid, {
        text: resources.length ? `Online matches for *${title}*:` : `Nothing found online for *${title}*.`,
        resources,
        pending: false,
        status: undefined
      })
    },
    [patchMsg, pushMsgs]
  )

  // ---------- highlights and bookmarks ----------

  const addHighlight = (color: string): void => {
    if (!selection) return
    const made: Highlight[] = selection.parts.map((p) => ({
      id: uid(),
      page: p.page,
      rects: p.rects,
      text: selection.text,
      color,
      created: Date.now()
    }))
    update((s) => ({ ...s, highlights: [...s.highlights, ...made] }))
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  const bookmarked = state?.bookmarks.find((b) => b.page === page)
  const toggleBookmark = (): void => {
    if (bookmarked) {
      update((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== bookmarked.id) }))
      return
    }
    const section = [...(index?.sections ?? [])].reverse().find((s) => s.page <= page)
    const label = section ? `${section.title} (p. ${page})` : `Page ${page}`
    update((s) => ({ ...s, bookmarks: [...s.bookmarks, { id: uid(), page, label, created: Date.now() }] }))
    setTab('bookmarks')
  }

  // ---------- wiring ----------

  // Controller callbacks are created once, so they reach the latest handlers through this ref.
  const openRef = useRef(openPath)
  openRef.current = openPath
  const handlers = useRef({ openTerm, setPop, setSelection, update })
  handlers.current = { openTerm, setPop, setSelection, update }

  useEffect(() => {
    const c = new PdfController(containerRef.current!, viewerRef.current!, {
      onPage: (p) => {
        setPage(p)
        handlers.current.update((s) => (s.lastPage === p ? s : { ...s, lastPage: p }))
      },
      onTerm: (term, at) => handlers.current.openTerm(term, at),
      onCite: (key, at) => handlers.current.setPop({ kind: 'cite', key, at }),
      onSelection: (sel) => handlers.current.setSelection(sel),
      onHighlight: (id, at) => handlers.current.setPop({ kind: 'highlight', id, at }),
      onFollowLink: () => setBack((b) => [...b.slice(-19), { page: c.page, scroll: c.scroll }])
    })
    ctrl.current = c
    void (async () => {
      const cfg = await window.qr.getSettings()
      settingsRef.current = cfg
      setSettings(cfg)
      setLibrary(await window.qr.library())
      setLlm(await window.qr.llmStatus())
      const initial = await window.qr.initialPath()
      if (initial) void openRef.current(initial)
    })()
    return () => c.destroy()
  }, [])

  const marksKey = useMemo(
    () => (state?.glossary ?? []).map((t) => termNames(t).join('|')).join(';'),
    [state?.glossary]
  )
  useEffect(() => {
    ctrl.current?.setMarks(
      stateRef.current?.glossary ?? [],
      (index?.refs ?? []).map((r) => r.key),
      showMarks
    )
  }, [marksKey, index?.refs, showMarks])

  useEffect(() => {
    ctrl.current?.setHighlights(state?.highlights ?? [])
  }, [state?.highlights])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 'o') (e.preventDefault(), void pickPdf())
      else if (e.key === '[') (e.preventDefault(), goBack())
      else if (e.key === '=' || e.key === '+') (e.preventDefault(), ctrl.current?.zoom(1.1))
      else if (e.key === '-') (e.preventDefault(), ctrl.current?.zoom(1 / 1.1))
      else if (e.key === '0') (e.preventDefault(), ctrl.current?.fit())
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.pdf$/i.test(f.name))
      if (file) void openPath(window.qr.pathForFile(file))
    }
    const onOver = (e: DragEvent): void => e.preventDefault()
    const onHide = (): void => save(true)
    const offOpen = window.qr.onOpenPath((path) => void openPath(path))
    window.addEventListener('keydown', onKey)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragover', onOver)
    window.addEventListener('beforeunload', onHide)
    return () => {
      offOpen()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('beforeunload', onHide)
    }
  }, [goBack, openPath, pickPdf, save])

  const saveSettings = async (next: Settings, reindex: boolean): Promise<void> => {
    const saved = await window.qr.setSettings(next)
    settingsRef.current = saved
    setSettings(saved)
    setShowSettings(false)
    setError('')
    if (reindex && stateRef.current) {
      update((s) => ({ ...s, glossaryDone: false, glossary: s.glossary.filter((t) => t.manual).map((t) => ({ ...t, status: 'pending' as const })) }))
    }
    if (stateRef.current) await runIndexing(run.current)
    else setLlm(await window.qr.llmStatus())
  }

  // ---------- render ----------

  const popTerm = pop?.kind === 'term' ? state?.glossary.find((t) => t.term === pop.term) : undefined
  const popRef = pop?.kind === 'cite' ? index?.refs.find((r) => r.key === pop.key) : undefined
  const popHl = pop?.kind === 'highlight' ? state?.highlights.find((h) => h.id === pop.id) : undefined

  return (
    <div className="app">
      <header className="titlebar">
        <div className="tb-left">
          {state && (
            <button className="tool" onClick={() => void closeDoc()} title="Back to library">
              Library
            </button>
          )}
          <button className="tool" onClick={() => void pickPdf()} title="Open a PDF (⌘O)">
            Open
          </button>
        </div>
        <div className="tb-title">{state ? state.title : 'QuickRead'}</div>
        <div className="tb-right">
          {status && (
            <span className="status" role="status">
              {status}
              <span className="progress" aria-hidden="true">
                <i />
              </span>
            </span>
          )}
          {state && index && (
            <>
              <span className="muted small pages">
                {page} / {index.pages}
              </span>
              <button className="tool" onClick={() => ctrl.current?.zoom(1 / 1.1)} aria-label="Zoom out">
                −
              </button>
              <button className="tool" onClick={() => ctrl.current?.zoom(1.1)} aria-label="Zoom in">
                +
              </button>
              <button className={`tool${bookmarked ? ' on' : ''}`} onClick={toggleBookmark}>
                {bookmarked ? 'Bookmarked' : 'Bookmark'}
              </button>
              <button className={`tool${showMarks ? ' on' : ''}`} onClick={() => setShowMarks(!showMarks)} title="Underline glossary terms in the paper">
                Terms
              </button>
              <button className={`tool${showAgent ? ' on' : ''}`} onClick={() => setShowAgent(!showAgent)}>
                Companion
              </button>
            </>
          )}
          <button className="tool" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="icon" aria-label="Dismiss" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}

      <div className="body">
        {state && (
          <Sidebar
            tab={tab}
            setTab={setTab}
            index={index}
            state={state}
            page={page}
            onJump={jump}
            onTerm={(t, el) => {
              const r = el.getBoundingClientRect()
              openTerm(t.term, { left: r.right + 8, top: r.top, bottom: r.top })
            }}
            onRemoveBookmark={(id) => update((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== id) }))}
          />
        )}

        <main className="reader">
          <div ref={containerRef} className="pdf-container" style={{ visibility: state ? 'visible' : 'hidden' }}>
            <div ref={viewerRef} className="pdfViewer" />
          </div>
          {back.length > 0 && state && (
            <button className="back-pill" onClick={goBack} title="Return to where you were reading (⌘[)">
              ← Back to p. {back[back.length - 1].page}
            </button>
          )}
          {!state && (
            <div className="start">
              <div className="orb" aria-hidden="true">
                Q
              </div>
              <h1>QuickRead</h1>
              <p className="muted">Read papers without losing your place. Click any term to recall what it means.</p>
              <button className="btn primary big" onClick={() => void pickPdf()}>
                Open a PDF
              </button>
              <p className="muted small">or drop a PDF anywhere in this window</p>
              <p className={`muted small model-line${llm.ok ? '' : ' warn'}`}>
                {llm.ok
                  ? `Local model ready: ${settings?.chatModel ?? ''}`
                  : 'The local model server is not running. Reading, highlights and bookmarks still work.'}
              </p>
              {library.length > 0 && (
                <div className="recents">
                  <div className="label">Recent papers</div>
                  <ul className="list">
                    {library.slice(0, 12).map((e) => (
                      <li key={e.id}>
                        <button onClick={() => void openPath(e.path)}>
                          <span className="grow">{e.title}</span>
                          <span className="muted small">{new Date(e.opened).toLocaleDateString()}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </main>

        {state && showAgent && (
          <AgentPanel
            messages={state.chat}
            busy={busy}
            llmOk={llm.ok}
            model={settings?.chatModel ?? ''}
            quote={quote}
            clearQuote={() => setQuote(null)}
            onAsk={(t) => void ask(t)}
            onStop={() => chatId.current && void window.qr.abort(chatId.current)}
            onClear={() => update((s) => ({ ...s, chat: [] }))}
            onPage={(p) => jump(p)}
            onOpenPdf={(u) => void openFromWeb(u)}
            onFindRef={(t) => void findRef(t)}
          />
        )}
      </div>

      {selection && !pop && (
        <div
          className="sel-bar"
          style={{
            left: Math.max(8, Math.min(selection.anchor.x - 120, window.innerWidth - 300)),
            top: Math.min(selection.anchor.y + 8, window.innerHeight - 48)
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {COLORS.map((c) => (
            <button key={c} className="swatch" style={{ background: c }} aria-label="Highlight" onClick={() => addHighlight(c)} />
          ))}
          {selection.text.length <= 80 && (
            <button
              className="tool"
              onClick={() =>
                openTerm(selection.text, { left: selection.anchor.x - 120, top: selection.anchor.y - 24, bottom: selection.anchor.y })
              }
            >
              Define
            </button>
          )}
          <button
            className="tool"
            onClick={() => {
              setQuote(selection.text)
              setShowAgent(true)
              setSelection(null)
            }}
          >
            Ask
          </button>
        </div>
      )}

      {pop && index && (popTerm || popRef || popHl) && (
        <Popover at={pop.at} onClose={() => setPop(null)}>
          {popTerm && (
            <TermCard
              term={popTerm}
              index={index}
              llmOk={llm.ok}
              onJump={jump}
              onDeeper={(t) => void deepDive(t)}
              onRetry={(t) => openTerm(t.term, pop.at)}
            />
          )}
          {popRef && <CiteCard reference={popRef} onJump={jump} onOpenPdf={(u) => void openFromWeb(u)} />}
          {popHl && (
            <HighlightCard
              highlight={popHl}
              onChange={(patch) =>
                update((s) => ({ ...s, highlights: s.highlights.map((h) => (h.id === popHl.id ? { ...h, ...patch } : h)) }))
              }
              onDelete={() => {
                update((s) => ({ ...s, highlights: s.highlights.filter((h) => h.id !== popHl.id) }))
                setPop(null)
              }}
            />
          )}
        </Popover>
      )}

      {showSettings && settings && (
        <SettingsDialog settings={settings} llm={llm} hasDoc={!!state} onSave={saveSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

function SettingsDialog(props: {
  settings: Settings
  llm: LlmStatus
  hasDoc: boolean
  onSave: (s: Settings, reindex: boolean) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState(props.settings)
  const set = (patch: Partial<Settings>): void => setDraft({ ...draft, ...patch })
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" role="dialog" aria-label="Settings">
        <h3>Local models</h3>
        <p className={`muted small${props.llm.ok ? '' : ' warn'}`}>
          {props.llm.ok ? `Connected. ${props.llm.models.length} models installed.` : (props.llm.error ?? 'Not connected.')}
        </p>
        <label>
          Model server (Ollama) address
          <input value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim() })} />
        </label>
        <label>
          Chat model
          <input list="models" value={draft.chatModel} onChange={(e) => set({ chatModel: e.target.value.trim() })} />
        </label>
        <label>
          Embedding model
          <input list="models" value={draft.embedModel} onChange={(e) => set({ embedModel: e.target.value.trim() })} />
        </label>
        <label>
          Context window (tokens)
          <input type="number" min={4096} step={4096} value={draft.numCtx} onChange={(e) => set({ numCtx: Number(e.target.value) || 32768 })} />
        </label>
        <datalist id="models">
          {props.llm.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="card-actions">
          <button className="btn primary" onClick={() => void props.onSave(draft, false)}>
            Save
          </button>
          {props.hasDoc && (
            <button className="btn" onClick={() => void props.onSave(draft, true)}>
              Save and rebuild this paper’s glossary
            </button>
          )}
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
