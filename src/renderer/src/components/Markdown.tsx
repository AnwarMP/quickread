import type { ReactNode } from 'react'

interface Props {
  text: string
  onPage?: (page: number) => void
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[p\.?\s*\d+\]|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*]*\*)/g

function inline(text: string, onPage?: (page: number) => void): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    const page = /^\[p\.?\s*(\d+)\]$/.exec(part)
    if (page) {
      return (
        <button key={i} className="page-ref" onClick={() => onPage?.(Number(page[1]))}>
          p. {page[1]}
        </button>
      )
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    if (link) {
      return (
        <a key={i} href={link[2]} onClick={(e) => (e.preventDefault(), void window.qr.openExternal(link[2]))}>
          {link[1]}
        </a>
      )
    }
    if (/^\*[^*]+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>
    return part
  })
}

/** A small Markdown subset: enough for model answers without pulling in a parser. */
export function Markdown({ text, onPage }: Props): ReactNode {
  const out: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i])
      i++
      out.push(<pre key={out.length}>{code.join('\n')}</pre>)
      continue
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(<h4 key={out.length}>{inline(heading[1], onPage)}</h4>)
      i++
      continue
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      for (; i < lines.length && bullet.test(lines[i]); i++) items.push(lines[i].replace(bullet, ''))
      const lis = items.map((it, k) => <li key={k}>{inline(it, onPage)}</li>)
      out.push(ordered ? <ol key={out.length}>{lis}</ol> : <ul key={out.length}>{lis}</ul>)
      continue
    }
    if (line.startsWith('>')) {
      const quote: string[] = []
      for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''))
      out.push(<blockquote key={out.length}>{inline(quote.join(' '), onPage)}</blockquote>)
      continue
    }
    const para: string[] = []
    for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*(?:[-*•]|\d+[.)])\s+)/.test(lines[i]); i++) {
      para.push(lines[i])
    }
    out.push(<p key={out.length}>{inline(para.join(' '), onPage)}</p>)
  }
  return <div className="md">{out}</div>
}
