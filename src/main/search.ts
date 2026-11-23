import type { Resource } from '../shared/types'

// Free, key-less sources. Only the search query leaves the machine.
const UA = { 'User-Agent': 'quickread-desktop/0.1' }

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) })
    return r.ok ? ((await r.json()) as T) : null
  } catch {
    return null
  }
}

const strip = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

async function wikipedia(q: string): Promise<Resource[]> {
  const body = await getJson<{ query?: { search?: { title: string; snippet: string }[] } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=2&srsearch=${encodeURIComponent(q)}`
  )
  return (body?.query?.search ?? []).map((s) => ({
    title: s.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
    source: 'Wikipedia',
    snippet: strip(s.snippet)
  }))
}

async function arxiv(q: string): Promise<Resource[]> {
  try {
    const r = await fetch(
      // Long queries are almost always paper titles, which match best as a quoted title search.
      `https://export.arxiv.org/api/query?max_results=3&search_query=${encodeURIComponent(
        q.split(' ').length >= 5 ? `ti:"${q.replace(/"/g, '')}"` : `all:${q}`
      )}`,
      { headers: UA, signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return []
    const xml = await r.text()
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const pick = (tag: string): string => strip(m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '')
      const url = pick('id').replace(/^http:/, 'https:')
      return {
        title: pick('title'),
        url,
        source: 'arXiv',
        snippet: pick('summary').slice(0, 260),
        pdfUrl: url.replace('/abs/', '/pdf/'),
        year: Number(pick('published').slice(0, 4)) || undefined
      }
    })
  } catch {
    return []
  }
}

interface OpenAlexWork {
  title?: string
  id: string
  doi?: string
  publication_year?: number
  cited_by_count?: number
  open_access?: { oa_url?: string }
  primary_location?: { landing_page_url?: string; pdf_url?: string; source?: { display_name?: string } }
}

async function openAlex(q: string): Promise<Resource[]> {
  const body = await getJson<{ results?: OpenAlexWork[] }>(
    `https://api.openalex.org/works?per-page=3&search=${encodeURIComponent(q)}`
  )
  return (body?.results ?? [])
    .filter((w) => w.title)
    .map((w) => {
      const oa = w.open_access?.oa_url ?? w.primary_location?.pdf_url
      const venue = w.primary_location?.source?.display_name
      return {
        title: strip(w.title ?? ''),
        url: w.primary_location?.landing_page_url ?? w.doi ?? oa ?? w.id,
        source: 'OpenAlex',
        snippet: [venue, w.cited_by_count ? `${w.cited_by_count.toLocaleString()} citations` : '']
          .filter(Boolean)
          .join(' · '),
        pdfUrl: oa && /arxiv\.org|\.pdf($|\?)/.test(oa) ? oa : undefined,
        year: w.publication_year
      }
    })
}

export async function searchWeb(query: string): Promise<Resource[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!q) return []
  const groups = await Promise.all([wikipedia(q), arxiv(q), openAlex(q)])
  const seen = new Set<string>()
  return groups.flat().filter((r) => {
    const key = r.title.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
