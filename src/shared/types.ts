export interface Chunk {
  id: number
  page: number
  /** PDF-space coordinates of the chunk's first line (origin bottom-left). */
  x: number
  y: number
  text: string
  section?: string
  /** True for bibliography text, which is excluded from retrieval. */
  ref?: boolean
  /** Where each source line starts: character offset in `text`, page, and PDF-space y. */
  lines?: { o: number; p: number; y: number }[]
}

export interface Reference {
  key: string
  text: string
  page: number
  x: number
  y: number
}

export interface Section {
  title: string
  page: number
  x: number
  y: number
}

export interface DocIndex {
  version: number
  title: string
  pages: number
  chunks: Chunk[]
  refs: Reference[]
  sections: Section[]
  embedModel?: string
  embeddings?: number[][]
}

export interface GlossaryTerm {
  term: string
  aliases: string[]
  mentions: number
  status: 'pending' | 'ready' | 'error'
  summary?: string
  quote?: string
  chunkId?: number
  error?: string
  /** True when the reader looked this up by hand rather than the indexer finding it. */
  manual?: boolean
  /** Importance from the statistical ranking. */
  score?: number
  /** Other glossary terms this one builds on: the edges of the term graph. */
  deps?: string[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Highlight {
  id: string
  page: number
  /** Rectangles as fractions of the page box, so they survive zooming. */
  rects: Rect[]
  text: string
  color: string
  note?: string
  created: number
}

export interface Bookmark {
  id: string
  page: number
  label: string
  created: number
}

export interface Resource {
  title: string
  url: string
  source: string
  snippet?: string
  pdfUrl?: string
  year?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status?: string
  pending?: boolean
  resources?: Resource[]
  paperRefs?: Reference[]
}

export interface DocState {
  id: string
  path: string
  title: string
  lastPage: number
  opened: number
  highlights: Highlight[]
  bookmarks: Bookmark[]
  glossary: GlossaryTerm[]
  glossaryDone?: boolean
  /** 2 = built by the statistical indexer. */
  glossaryVersion?: number
  chat: ChatMessage[]
}

export interface LibraryEntry {
  id: string
  path: string
  title: string
  opened: number
}

export interface Settings {
  baseUrl: string
  chatModel: string
  embedModel: string
  numCtx: number
}

export interface LlmStatus {
  ok: boolean
  models: string[]
  error?: string
}

export interface ChatRequest {
  id: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  json?: boolean
  stream?: boolean
  temperature?: number
}

export interface OpenedDoc {
  id: string
  path: string
  data: Uint8Array
  state: DocState | null
  index: DocIndex | null
}

export interface QrApi {
  pickPdf(): Promise<string | null>
  openDoc(path: string): Promise<OpenedDoc>
  saveState(state: DocState): Promise<void>
  saveIndex(id: string, index: DocIndex): Promise<void>
  library(): Promise<LibraryEntry[]>
  getSettings(): Promise<Settings>
  setSettings(s: Settings): Promise<Settings>
  llmStatus(): Promise<LlmStatus>
  chat(req: ChatRequest): Promise<string>
  abort(id: string): Promise<void>
  embed(texts: string[]): Promise<number[][]>
  search(query: string): Promise<Resource[]>
  openExternal(url: string): Promise<void>
  downloadPdf(url: string): Promise<string>
  pathForFile(file: File): string
  initialPath(): Promise<string | null>
  onOpenPath(cb: (path: string) => void): () => void
  onDelta(cb: (id: string, delta: string) => void): () => void
}
