/**
 * Finds a paper's key terms, where each is defined, and how they depend on one another,
 * using only text statistics. No model is involved, so this runs the moment a paper opens.
 *
 *  1. Candidates: word runs between stopwords and punctuation, up to four words.
 *  2. Importance: C-value (frequency, length, and not merely part of a longer term) weighted by
 *     how rare the words are in everyday English, plus boosts for headings, acronyms, and so on.
 *  3. Definitions: every sentence mentioning a term is scored for definition phrasing,
 *     position, and whether its section is about the term.
 *  4. Graph: term A depends on term B when B appears in A's name or in A's defining sentence.
 */
import type { Chunk, DocIndex, GlossaryTerm } from '../../../shared/types'
import commonWords from './common-words.json'
import { namesPattern } from './brain'

const RANK = new Map((commonWords as string).split(' ').map((w, i) => [w, i + 1]))

const STOP = new Set(
  `a an the and or but nor so yet if then than that this these those there here it its it's they them their we our us you your he she his her i
  of in on at by for with from to into onto over under between among through during before after above below up down out off about against across per via within without
  is are was were be been being am do does did done doing have has had having can could may might must shall should will would
  not no only also very more most much many few some any all each every both either neither other another such same own
  as while when where which who whom whose what why how whether because since although though however therefore thus hence moreover furthermore
  use used uses using show shows shown showed see seen given give gives make makes made take takes taken let get gets
  paper work section table figure fig equation eq appendix et al e.g i.e etc respectively
  one two three four five six seven eight nine ten first second third new different similar several various following previous next last
  well better best even still just now further rather instead already often always never state-of-the-art
  result results approach method methods example examples case cases way ways number numbers set sets order terms term kind type types
  describe described describes present presented presents propose proposed proposes obtain obtained achieve achieved achieves compare compared
  allow allows allowed perform performs performed consider considered note observe observed find found based due able`
    .split(/\s+/)
    .filter(Boolean)
)

/** Words every paper in the field uses; never worth a glossary entry on their own. */
const GENERIC = new Set(
  `model training output input network architecture task data dataset experiment performance problem system function value parameter
  feature sample step size dimension vector matrix representation sequence layer translation evaluation baseline accuracy score error
  loss state time cost quality length position structure information process analysis learning test weight operation computation
  setting configuration variation component module block unit level rate token word sentence language target source context`
    .split(/\s+/)
    .filter(Boolean)
)

/** Share of a sentence's words that are everyday function words. Table rows and axis labels score near zero. */
function proseRatio(text: string): number {
  const words = text.match(/[A-Za-z]+/g) ?? []
  if (words.length < 4) return 0
  return words.filter((w) => STOP.has(w.toLowerCase()) || (RANK.get(w.toLowerCase()) ?? 99999) <= 150).length / words.length
}

const isProse = (s: { text: string; section?: string }): boolean =>
  s.section !== undefined && proseRatio(s.text) >= 0.2 && !/^(?:Figure|Table|Fig\.)\s*\d/.test(s.text)

/** 0 for the commonest English words, 1 for words outside the 30,000 most common. */
function rarity(word: string): number {
  const w = word.toLowerCase()
  let rank = RANK.get(w)
  if (!rank && !w.includes('-')) {
    // Inflected forms of everyday words ("implemented", "significantly") are everyday words too.
    for (const stem of [singular(w), w.replace(/(?:ed|ing|ly)$/, ''), w.replace(/(?:d|ing|ly)$/, 'e'), w.replace(/ally$/, '')]) {
      rank = RANK.get(stem)
      if (rank) break
    }
  }
  return rank ? Math.min(1, Math.log(rank) / Math.log(30000)) : 1
}

function singular(w: string): string {
  if (w.length < 4) return w
  if (/(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (/[^aeiou]ies$/.test(w)) return `${w.slice(0, -3)}y`
  if (/s$/.test(w) && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}

/** Singular form that keeps the original capitalisation. */
function singularSurface(w: string): string {
  const s = singular(w.toLowerCase())
  if (s === w.toLowerCase()) return w
  return /ies$/i.test(w) ? `${w.slice(0, -3)}y` : w.slice(0, s.length)
}

// ---------- sentences ----------

export interface Sentence {
  id: number
  chunkId: number
  text: string
  page: number
  y: number
  section?: string
}

const ABBREV = /(?:\b(?:Fig|Figs|Eq|Eqs|Sec|Tab|al|etc|vs|cf|resp|approx|No|Dr|Prof)|\b[ei]\.[eg])\.$/

function splitSentences(chunk: Chunk, out: Sentence[]): void {
  const text = chunk.text
  const cuts = [0]
  for (const m of text.matchAll(/[.!?]["”)]?\s+(?=[A-Z0-9("“[])/g)) {
    const end = m.index + m[0].length
    if (!ABBREV.test(text.slice(0, m.index + 1))) cuts.push(end)
  }
  cuts.push(text.length)
  for (let i = 0; i < cuts.length - 1; i++) {
    const raw = text.slice(cuts[i], cuts[i + 1]).trim()
    if (raw.length < 15) continue
    const line = [...(chunk.lines ?? [])].reverse().find((l) => l.o <= cuts[i] + 1)
    out.push({
      id: out.length,
      chunkId: chunk.id,
      text: raw,
      page: line?.p ?? chunk.page,
      y: line?.y ?? chunk.y,
      section: chunk.section
    })
  }
}

const sentenceCache = new WeakMap<DocIndex, Sentence[]>()

export function sentencesOf(index: DocIndex): Sentence[] {
  let s = sentenceCache.get(index)
  if (!s) {
    s = []
    for (const c of index.chunks) if (!c.ref) splitSentences(c, s)
    sentenceCache.set(index, s)
  }
  return s
}

// ---------- candidates ----------

interface Candidate {
  key: string
  words: string[]
  tf: number
  forms: Map<string, number>
  sections: Set<string>
  heading: boolean
  abstract: boolean
  /** Times it appeared capitalised away from the start of a sentence. */
  caps: number
  /** Times it ended its word run, i.e. was not modifying a following word. */
  head: number
  acronym: boolean
  score: number
}

const TOKEN = /[A-Za-z][A-Za-z0-9]*(?:[-’'][A-Za-z0-9]+)*/g

/** Runs of consecutive content words: broken at stopwords and at any punctuation. */
function runs(text: string): { word: string; first: boolean }[][] {
  const out: { word: string; first: boolean }[][] = []
  let cur: { word: string; first: boolean }[] = []
  let prevEnd = -1
  for (const m of text.matchAll(TOKEN)) {
    const gap = prevEnd < 0 ? '' : text.slice(prevEnd, m.index)
    if (cur.length && gap !== ' ') {
      out.push(cur)
      cur = []
    }
    const word = m[0].replace(/[’']s$/, '')
    if (STOP.has(word.toLowerCase()) || word.length < 2) {
      if (cur.length) out.push(cur)
      cur = []
    } else cur.push({ word, first: m.index === 0 })
    prevEnd = m.index + m[0].length
  }
  if (cur.length) out.push(cur)
  return out
}

function collect(index: DocIndex): Map<string, Candidate> {
  const cands = new Map<string, Candidate>()
  const add = (words: { word: string; first: boolean }[], where: { section?: string; heading?: boolean; head?: boolean }): void => {
    const lower = words.map((w) => w.word.toLowerCase())
    lower[lower.length - 1] = singular(lower[lower.length - 1])
    const key = lower.join(' ')
    let c = cands.get(key)
    if (!c) {
      c = { key, words: lower, tf: 0, forms: new Map(), sections: new Set(), heading: false, abstract: false, caps: 0, head: 0, acronym: false, score: 0 }
      cands.set(key, c)
    }
    if (where.heading) {
      c.heading = true
      return
    }
    c.tf++
    if (where.head) c.head++
    const surface = words.map((w) => w.word)
    surface[surface.length - 1] = singularSurface(surface[surface.length - 1])
    // A capital at the start of a sentence says nothing about the term itself.
    const form = (words[0].first ? [surface[0][0].toLowerCase() + surface[0].slice(1), ...surface.slice(1)] : surface).join(' ')
    c.forms.set(form, (c.forms.get(form) ?? 0) + 1)
    if (!words[0].first && words.some((w) => /[A-Z]/.test(w.word))) c.caps++
    if (where.section) {
      c.sections.add(where.section)
      if (/^abstract$/i.test(where.section)) c.abstract = true
    }
  }
  const scan = (text: string, where: { section?: string; heading?: boolean }): void => {
    for (const run of runs(text)) {
      for (let n = 1; n <= Math.min(4, run.length); n++) {
        for (let i = 0; i + n <= run.length; i++) add(run.slice(i, i + n), { ...where, head: i + n === run.length })
      }
    }
  }
  for (const s of sentencesOf(index)) if (isProse(s)) scan(s.text, { section: s.section })
  for (const sec of index.sections) scan(sec.title.replace(/^[\d.]+\s*/, ''), { heading: true })
  return cands
}

/** "long short-term memory (LSTM)" style definitions: acronym → long form. */
function acronyms(index: DocIndex): Map<string, string> {
  const found = new Map<string, string>()
  for (const s of sentencesOf(index)) {
    for (const m of s.text.matchAll(/((?:[A-Za-z][\w-]*[ -]){1,7})\(([A-Z][A-Za-z]{1,6}?)s?\)/g)) {
      const letters = m[2].toLowerCase()
      const words = m[1].trim().split(/[ -]/).filter(Boolean)
      const tail = words.slice(-letters.length)
      if (tail.length === letters.length && tail.every((w, i) => w[0].toLowerCase() === letters[i])) {
        // Keep the original spacing and hyphens of the long form.
        const long = m[1].trim().match(new RegExp(`${tail.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ -]')}$`))?.[0]
        if (long) found.set(m[2], long)
      }
    }
  }
  return found
}

// ---------- scoring ----------

function contains(long: string[], short: string[]): boolean {
  outer: for (let i = 0; i + short.length <= long.length; i++) {
    for (let j = 0; j < short.length; j++) if (long[i + j] !== short[j]) continue outer
    return true
  }
  return false
}

function displayForm(c: Candidate): string {
  return [...c.forms.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? c.key
}

function rank(index: DocIndex): Candidate[] {
  const cands = collect(index)
  const acr = acronyms(index)
  for (const [short, long] of acr) {
    const key = long.toLowerCase().split(' ').map((w, i, a) => (i === a.length - 1 ? singular(w) : w)).join(' ')
    const c = cands.get(key)
    if (c) c.acronym = true
    const s = cands.get(short.toLowerCase())
    if (s) s.acronym = true
  }

  const viable = [...cands.values()].filter((c) => {
    if (c.key.length < 2 || c.key.length > 60) return false
    if (c.words.length === 1) {
      const w = c.words[0]
      // Jargon the dictionary has never heard of ("softmax") needs less repetition to be believed.
      const coined = !RANK.has(w) && rarity(w) === 1
      if (GENERIC.has(w) || c.tf < (coined ? 2 : 3) || w.length < 3 || /(?:ly|ed)$/.test(w)) return false
      // A word that nearly always modifies the next one ("positional", "recurrent") is half a term.
      if (c.head < 0.34 * c.tf) return false
      const special = c.heading || c.acronym || w.includes('-') || c.caps >= Math.max(2, c.tf * 0.6)
      // Unknown words are jargon; known English words need a structural reason to count.
      return rarity(w) >= 0.9 || (special && rarity(w) >= 0.6)
    }
    // Multi-word terms must repeat, and may not begin or end with an everyday word.
    const edge = Math.min(rarity(c.words[0]), rarity(c.words[c.words.length - 1]))
    return (c.tf >= 2 || c.acronym) && (edge >= 0.62 || c.heading) && !/ly$/.test(c.words[c.words.length - 1])
  })

  const multi = viable.filter((c) => c.words.length > 1)
  for (const c of viable) {
    // C-value: discount occurrences that are just part of a longer repeated phrase.
    const longer = multi.filter((o) => o.words.length > c.words.length && contains(o.words, c.words))
    const nested = longer.length ? longer.reduce((sum, o) => sum + o.tf, 0) / longer.length : 0
    const free = c.tf - nested
    const base = Math.log2(c.words.length + 1) * Math.log2(1 + Math.max(0, free))
    const rare = c.words.reduce((sum, w) => sum + rarity(w), 0) / c.words.length
    let boost = 1
    if (c.heading) boost *= 1.8
    if (c.acronym) boost *= 1.5
    if (c.abstract) boost *= 1.15
    if (c.caps >= Math.max(2, c.tf * 0.6)) boost *= 1.3
    if (c.words.some((w) => w.includes('-'))) boost *= 1.2
    if (c.sections.size >= 3) boost *= 1.2
    // A single word that mostly lives inside longer terms ("positional") is a fragment, not a term.
    const fragment = c.words.length === 1 && longer.length > 0 && free < 0.5 * c.tf
    // A phrase seen only twice is weak evidence.
    if (c.words.length > 1 && c.tf === 2 && !c.heading && !c.acronym) boost *= 0.6
    c.score = free < 1 || fragment ? 0 : base * rare * rare * boost
  }
  return viable.filter((c) => c.score > 0).sort((a, b) => b.score - a.score)
}

// ---------- definitions ----------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface Found {
  quote: string
  chunkId: number
  /** The best few defining sentences, best first. */
  sentences: Sentence[]
  mentions: number
}

/** The sentences most likely to define a term, by phrasing, position, and section. */
export function findDefinition(index: DocIndex, names: string[]): Found | null {
  const sentences = sentencesOf(index)
  const re = new RegExp(namesPattern(names), 'i')
  const hits = sentences.filter((s) => re.test(s.text))
  if (!hits.length) return null
  const t = `(?:${names.map((n) => esc(n).replace(/[\s-]+/g, '[\\s-]+')).join('|')})(?:e?s)?`
  // The term must stand on its own here, not be the tail of a longer phrase ("additive attention").
  const lead = `(?:^|[,;:(“"]\\s*|\\b(?:the|an?|our|this|each|that|and|of|in|where)\\s+)`
  const after = new RegExp(
    `${lead}${t}["”]?\\W{1,3}(?:\\([^)]{0,40}\\)\\W{0,2})?(?:(?:is|are)\\s+(?:an?|the|one|defined|based|composed|simply)\\b|refers? to|denotes?|means|consists? of|(?:sometimes |also |often )?(?:called|known as|termed))`,
    'i'
  )
  const does = new RegExp(`${lead}${t}\\s+(?:maps|computes?|allows?|takes|produces?|generates?|uses?|relates?|connects?)\\b`, 'i')
  const before = new RegExp(
    `(?:call(?:ed)?|termed|known as|refer(?:red)? to as|referred to as|defin(?:e|es|ed)|introduc(?:e|es|ed)|denot(?:e|es|ed)(?: by| as)?|propos(?:e|es|ed)|namely|so-called)\\W{1,3}(?:the |an? |this |our |it )?["“]?${t}`,
    'i'
  )
  const starts = new RegExp(`^(?:(?:the|an?|our|in an?|each)\\s+)?["“]?${t}`, 'i')
  const quoted = new RegExp(`["“]${t}["”]`, 'i')
  const apposition = new RegExp(`,\\s+(?:the|an?)\\s+${t}\\s*,|\\b(?:named|dubbed)\\s+(?:the\\s+)?${t}`, 'i')
  const scored = hits.map((s, i) => {
    let score = 1 - i / hits.length
    if (after.test(s.text)) score += 3
    else if (does.test(s.text)) score += 1
    if (before.test(s.text)) score += 2
    if (quoted.test(s.text)) score += 2
    if (apposition.test(s.text)) score += 2
    if (starts.test(s.text)) score += 1.2
    if (s.section && re.test(s.section)) score += 2.5
    // Author blocks, captions, and table rows mention terms without explaining them.
    if (s.section === undefined) score -= 3
    if (/^(?:Figure|Table|Fig\.)\s*\d/.test(s.text) || /\b(?:Figure|Table) \d+:/.test(s.text)) score -= 2.5
    if (proseRatio(s.text) < 0.2) score -= 3
    if (/^[a-z(]/.test(s.text)) score -= 1
    if (s.text.length < 45 || s.text.length > 420) score -= 1
    return { s, score }
  })
  scored.sort((a, b) => b.score - a.score || a.s.id - b.s.id)
  const best = scored.slice(0, 3).map((x) => x.s)
  return { quote: best[0].text, chunkId: best[0].chunkId, sentences: best, mentions: new Set(hits.map((h) => h.chunkId)).size }
}

// ---------- the glossary and its graph ----------

/** Terms among `others` that `names` builds on: part of its name, or used in its defining sentence. */
export function dependencies(
  names: string[],
  quote: string | undefined,
  others: Pick<GlossaryTerm, 'term' | 'aliases'>[]
): string[] {
  const self = new RegExp(namesPattern(names), 'gi')
  // Blank out the term itself so "attention" is not found inside "multi-head attention".
  let rest = (quote ?? '').replace(self, (m) => ' '.repeat(m.length))
  const deps: string[] = []
  const byLength = [...others].sort((a, b) => b.term.length - a.term.length)
  for (const o of byLength) {
    if (names.some((n) => n.toLowerCase() === o.term.toLowerCase())) continue
    const re = new RegExp(namesPattern([o.term, ...o.aliases]), 'gi')
    const inName = names[0].toLowerCase() !== o.term.toLowerCase() && new RegExp(namesPattern([o.term]), 'i').test(names[0].replace(/-/g, ' ')) && names[0].length > o.term.length
    const inQuote = re.test(rest)
    if (inName || inQuote) {
      deps.push(o.term)
      rest = rest.replace(new RegExp(namesPattern([o.term, ...o.aliases]), 'gi'), (m) => ' '.repeat(m.length))
    }
  }
  return deps.slice(0, 5)
}

export function buildGlossary(index: DocIndex, limit = 70): GlossaryTerm[] {
  const ranked = rank(index)
  const acr = acronyms(index)
  const longOf = new Map([...acr].map(([short, long]) => [short.toLowerCase(), long]))
  const shortOf = new Map([...acr].map(([short, long]) => [long.toLowerCase(), short]))

  const picked: GlossaryTerm[] = []
  const taken = new Set<string>()
  for (const c of ranked) {
    if (picked.length >= limit) break
    let term = displayForm(c)
    const aliases: string[] = []
    // An acronym and its long form are one entry, named by the long form.
    const long = longOf.get(term.toLowerCase())
    if (long) {
      aliases.push(term)
      term = long
    }
    const short = shortOf.get(term.toLowerCase())
    if (short && !aliases.includes(short)) aliases.push(short)
    const key = term.toLowerCase()
    if (taken.has(key)) continue
    const found = findDefinition(index, [term, ...aliases])
    if (!found) continue
    taken.add(key)
    for (const a of aliases) taken.add(a.toLowerCase())
    picked.push({
      term,
      aliases,
      mentions: found.mentions,
      status: 'pending',
      score: Math.round(c.score * 100) / 100,
      quote: found.quote,
      chunkId: found.chunkId,
      deps: []
    })
  }
  for (const t of picked) t.deps = dependencies([t.term, ...t.aliases], t.quote, picked)
  return picked.sort((a, b) => a.term.localeCompare(b.term))
}
