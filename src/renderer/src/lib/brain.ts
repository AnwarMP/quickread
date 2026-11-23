import type { Chunk, DocIndex, GlossaryTerm, Reference } from '../../../shared/types'

let seq = 0
export const uid = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}`

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

export async function chat(
  messages: Msg[],
  opts: { json?: boolean; onDelta?: (d: string) => void; id?: string; temperature?: number } = {}
): Promise<string> {
  const id = opts.id ?? uid()
  const off = opts.onDelta
    ? window.qr.onDelta((rid, delta) => {
        if (rid === id) opts.onDelta?.(delta)
      })
    : null
  try {
    return await window.qr.chat({ id, messages, json: opts.json, stream: !!opts.onDelta, temperature: opts.temperature })
  } finally {
    off?.()
  }
}

export function parseJson<T>(raw: string): T | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

// ---------- matching ----------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches a term or alias as a whole word, tolerating a plural ending and line-wrap spacing. */
export function namesPattern(names: string[]): string {
  const alts = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((n) => esc(n).replace(/[\s-]+/g, '[\\s-]+'))
  return `(?<![\\w-])(?:${alts.join('|')})(?:e?s)?(?![\\w-])`
}

export const termNames = (t: Pick<GlossaryTerm, 'term' | 'aliases'>): string[] => [t.term, ...t.aliases]

export function mentionsOf(index: DocIndex, names: string[]): Chunk[] {
  const re = new RegExp(namesPattern(names), 'i')
  return index.chunks.filter((c) => !c.ref && re.test(c.text))
}

// ---------- retrieval ----------

const dot = (a: number[], b: number[]): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const cosine = (a: number[], b: number[]): number => dot(a, b) / (Math.sqrt(dot(a, a) * dot(b, b)) || 1)

// EmbeddingGemma expects a task prefix on both sides.
const asQuery = (q: string): string => `task: search result | query: ${q}`
const asDoc = (c: Chunk): string => `title: ${c.section ?? 'none'} | text: ${c.text}`

export async function embedIndex(index: DocIndex, model: string): Promise<DocIndex> {
  const embeddings = await window.qr.embed(index.chunks.map(asDoc))
  return { ...index, embeddings, embedModel: model }
}

const STOP = new Set(
  'the a an of and or to in on for with is are was be as by at from that this it its we our their which what how why does do can into than then'.split(
    ' '
  )
)

function lexicalScores(index: DocIndex, query: string): number[] {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].filter((w) => !STOP.has(w))
  return index.chunks.map((c) => {
    const text = c.text.toLowerCase()
    let score = 0
    for (const w of words) {
      const hits = text.split(w).length - 1
      if (hits) score += 1 + Math.log(hits)
    }
    return score / (words.length || 1) / 3
  })
}

/** Similarity of every chunk to the query: embeddings when available, keyword overlap otherwise. */
async function scores(index: DocIndex, query: string): Promise<number[]> {
  if (index.embeddings?.length === index.chunks.length) {
    try {
      const [q] = await window.qr.embed([asQuery(query)])
      return index.embeddings.map((e) => cosine(q, e))
    } catch {
      /* fall back to keywords */
    }
  }
  return lexicalScores(index, query)
}

export async function retrieve(index: DocIndex, query: string, k: number): Promise<Chunk[]> {
  const s = await scores(index, query)
  return index.chunks
    .filter((c) => !c.ref)
    .sort((a, b) => s[b.id] - s[a.id])
    .slice(0, k)
    .sort((a, b) => a.id - b.id)
}

/** Keep the items closest in meaning to the query; without embeddings, keep the first few. */
export async function mostRelevant<T>(query: string, items: T[], text: (item: T) => string, keep: number): Promise<T[]> {
  if (items.length <= 1) return items
  try {
    const [q, ...vecs] = await window.qr.embed([asQuery(query), ...items.map((i) => `title: none | text: ${text(i)}`)])
    return items
      .map((item, i) => ({ item, score: cosine(q, vecs[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, keep)
      .map((x) => x.item)
  } catch {
    return items.slice(0, keep)
  }
}

// ---------- glossary ----------

const PRUNE_SYSTEM = `You tidy an automatically extracted glossary for a research paper.
You get a numbered list of candidate terms. Some are real technical terms or named concepts a reader may want explained. Others are noise: sentence fragments, generic phrases, names of organisations, hardware, or datasets mentioned in passing, and ordinary words.
List the numbers of the noise entries. When unsure, keep the entry.
Answer with JSON only: {"drop":[numbers]}`

/** One short model call that names the statistical extractor's false positives. */
export async function pruneTerms(index: DocIndex, terms: GlossaryTerm[], id?: string): Promise<Set<string>> {
  const raw = await chat(
    [
      { role: 'system', content: PRUNE_SYSTEM },
      { role: 'user', content: `Paper: ${index.title}\n\n${terms.map((t, i) => `${i + 1}. ${t.term}`).join('\n')}` }
    ],
    { json: true, temperature: 0, id }
  )
  const drop = parseJson<{ drop?: unknown }>(raw)?.drop
  const numbers = (Array.isArray(drop) ? drop : []).filter((n): n is number => Number.isInteger(n))
  // A model that wants to drop most of the list has misread the task.
  if (numbers.length > terms.length * 0.6) return new Set()
  return new Set(numbers.map((n) => terms[n - 1]?.term).filter((t): t is string => !!t))
}

const SUMMARY_SYSTEM = `You help a reader recall what a term means in the paper they are reading.
Write one or two plain sentences saying what the term means as this paper uses it. Start with the term itself.
Use only the excerpts given. If they do not explain the term, say the paper uses it without defining it, then give its standard meaning.
Output only the definition, with no preamble.`

/**
 * Writes a term's summary from its defining sentences and those of the terms it builds on.
 * The prompt is a few hundred tokens, because the term graph has already found what matters.
 */
export async function summarizeTerm(
  title: string,
  term: string,
  sentences: string[],
  related: { term: string; quote: string }[],
  onDelta: (text: string) => void
): Promise<string> {
  let acc = ''
  const out = await chat(
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      {
        role: 'user',
        content: `Paper: ${title}\nTerm: ${term}\n\nWhere the paper introduces it:\n${sentences.map((s) => `- ${s}`).join('\n')}${
          related.length ? `\n\nRelated terms it builds on:\n${related.map((r) => `- ${r.term}: ${r.quote}`).join('\n')}` : ''
        }`
      }
    ],
    { temperature: 0, onDelta: (d) => onDelta((acc += d)) }
  )
  return out.trim()
}

// ---------- definitions ----------

const CUES = /\b(is an?|are|refers? to|defined as|we call|called|denotes?|known as|consists? of|composed of|i\.e\.|namely|maps?)\b/i

const DEFINE_SYSTEM = `You help a reader recall what a term means in the paper they are reading.
You get the term and numbered passages from that paper. Use only these passages.
Answer with JSON only:
{"summary":"one or two plain sentences that say directly what the term means as this paper uses it; start with the term itself, never with 'The paper'","passage":<number of the passage that best introduces or defines the term>,"quote":"the sentence or two from that passage that define it, copied word for word"}
If the passages never explain the term, still pick the most informative passage and say in the summary that the paper uses the term without defining it, then give the standard meaning.`

export interface Definition {
  summary: string
  quote?: string
  chunkId?: number
}

export async function defineTerm(index: DocIndex, names: string[]): Promise<Definition> {
  const term = names[0]
  const sim = await scores(index, `Definition of ${term}: what ${term} is and how it works`)
  const re = new RegExp(namesPattern(names), 'i')
  let pool = mentionsOf(index, names)
  const mentioned = pool.length > 0
  if (!mentioned) pool = index.chunks.filter((c) => !c.ref)

  const last = index.chunks.length || 1
  const rank = (c: Chunk): number =>
    sim[c.id] +
    (mentioned ? 0.12 * (1 - c.id / last) : 0) + // terms are usually defined early
    (CUES.test(c.text) ? 0.04 : 0) +
    (c.section && re.test(c.section) ? 0.15 : 0)
  const top = [...pool]
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 5)
    .sort((a, b) => a.id - b.id)
  if (!top.length) return { summary: 'This paper has no readable text to look this up in.' }

  const passages = top
    .map((c, i) => `[${i + 1}] (${c.section ?? 'no section'}, page ${c.page})\n${c.text}`)
    .join('\n\n')
  const raw = await chat(
    [
      { role: 'system', content: DEFINE_SYSTEM },
      { role: 'user', content: `Paper: ${index.title}\nTerm: ${term}\n\nPassages:\n${passages}` }
    ],
    { json: true, temperature: 0 }
  )
  const parsed = parseJson<{ summary?: unknown; passage?: unknown; quote?: unknown }>(raw)
  if (!parsed || typeof parsed.summary !== 'string') throw new Error('The model returned an unreadable answer')
  const chosen = top[Number(parsed.passage) - 1] ?? top[0]
  return {
    summary: parsed.summary.trim(),
    quote: typeof parsed.quote === 'string' ? parsed.quote.trim() : undefined,
    chunkId: chosen.id
  }
}

/** Page and position of a quote inside a chunk, falling back to the chunk's first line. */
export function locate(chunk: Chunk, quote?: string): { page: number; y: number } {
  const start = { page: chunk.page, y: chunk.y }
  const probe = (quote ?? '').replace(/\s+/g, ' ').replace(/^["“\s]+/, '').slice(0, 32).toLowerCase()
  if (probe.length < 12 || !chunk.lines?.length) return start
  const at = chunk.text.toLowerCase().indexOf(probe)
  if (at < 0) return start
  // Offsets are recorded before a line is joined, so allow a character of slack.
  const line = [...chunk.lines].reverse().find((l) => l.o <= at + 1)
  return line ? { page: line.p, y: line.y } : start
}

// ---------- citations ----------

/** References the paper cites in the passages that mention these names, most-cited first. */
export function refsNear(index: DocIndex, names: string[]): Reference[] {
  const counts = new Map<string, number>()
  for (const c of mentionsOf(index, names)) {
    for (const group of c.text.matchAll(/\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g)) {
      for (const n of group[1].split(/[,–-]/)) {
        const key = n.trim()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return index.refs
    .filter((r) => counts.has(r.key))
    .sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0))
    .slice(0, 5)
}

/** The arXiv identifier in a bibliography entry, when it has one. */
export const arxivId = (text: string): string | null =>
  /arxiv[:\s]*(\d{4}\.\d{4,5})/i.exec(text)?.[1] ?? /abs\/(\d{4}\.\d{4,5})/i.exec(text)?.[1] ?? null

/** Best-effort title of a bibliography entry, for searching it online. */
export function refTitle(text: string): string {
  const parts = text.split(/\.\s+/).map((s) => s.trim())
  // "Authors. Title. Venue, year." — the title is usually the first long part after the authors.
  const candidate = parts.slice(1).find((p) => p.split(' ').length >= 3 && !/^(in |arxiv|corr|proceedings)/i.test(p))
  return (candidate ?? parts[0] ?? text).replace(/[.,]$/, '').slice(0, 180)
}
