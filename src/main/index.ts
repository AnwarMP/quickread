import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  ChatRequest,
  DocIndex,
  DocState,
  LibraryEntry,
  LlmStatus,
  OpenedDoc,
  Settings
} from '../shared/types'
import { searchWeb } from './search'

const DEFAULT_SETTINGS: Settings = {
  // QuickRead runs its own Ollama server on this port so it never fights with
  // another Ollama install on the default 11434.
  baseUrl: 'http://127.0.0.1:11435',
  chatModel: 'inkling-2-mini',
  embedModel: 'embeddinggemma-2:270m',
  numCtx: 32768
}

const dataDir = (): string => app.getPath('userData')
const docDir = (id: string): string => join(dataDir(), 'docs', id)

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value))
  await fs.rename(tmp, path)
}

// ---------- settings ----------

let settings: Settings = DEFAULT_SETTINGS

async function loadSettings(): Promise<void> {
  const saved = await readJson<Partial<Settings>>(join(dataDir(), 'settings.json'), {})
  settings = { ...DEFAULT_SETTINGS, ...saved }
}

// ---------- local model server ----------

let ownedServer: ChildProcess | null = null

async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${settings.baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

/** Start an Ollama server on the configured local port if nothing answers there. */
async function ensureServer(): Promise<void> {
  if (await ping()) return
  let url: URL
  try {
    url = new URL(settings.baseUrl)
  } catch {
    return
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || ownedServer) return
  const bin = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'].find((p) => existsSync(p))
  if (!bin) return
  ownedServer = spawn(bin, ['serve'], {
    env: { ...process.env, OLLAMA_HOST: url.host, OLLAMA_FLASH_ATTENTION: '1' },
    stdio: 'ignore'
  })
  ownedServer.on('exit', () => (ownedServer = null))
  for (let i = 0; i < 20 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 300))
}

async function llmStatus(): Promise<LlmStatus> {
  try {
    await ensureServer()
    const r = await fetch(`${settings.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return { ok: false, models: [], error: `Model server answered ${r.status}` }
    const body = (await r.json()) as { models?: { name: string }[] }
    return { ok: true, models: (body.models ?? []).map((m) => m.name) }
  } catch (e) {
    return { ok: false, models: [], error: `No model server at ${settings.baseUrl} (${String(e)})` }
  }
}

const running = new Map<string, AbortController>()
const noJsonMode = new Set<string>()

async function chat(req: ChatRequest, send: (delta: string) => void): Promise<string> {
  const ctrl = new AbortController()
  running.set(req.id, ctrl)
  try {
    const body: Record<string, unknown> = {
      model: settings.chatModel,
      messages: req.messages,
      stream: true,
      // Lowest reasoning effort: lookups should feel instant, and hidden reasoning costs seconds.
      think: 'low',
      keep_alive: '30m',
      options: { num_ctx: settings.numCtx, temperature: req.temperature ?? 0.2 }
    }
    if (req.json && !noJsonMode.has(settings.chatModel)) body.format = 'json'
    const post = (): Promise<Response> =>
      fetch(`${settings.baseUrl}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: ctrl.signal })
    let res = await post()
    // Some models reject optional features; drop them one at a time and retry.
    // Prompts already ask for JSON, so structured-output mode is only a safety net.
    if (!res.ok && body.format && /structured output|format/i.test(await res.clone().text())) {
      noJsonMode.add(settings.chatModel)
      delete body.format
      res = await post()
    }
    if (res.status === 400 && 'think' in body) {
      delete body.think
      res = await post()
    }
    if (!res.ok || !res.body) {
      throw new Error(`${settings.chatModel}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    let out = ''
    let buf = ''
    const decoder = new TextDecoder()
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as { message?: { content?: string }; error?: string }
        if (msg.error) throw new Error(msg.error)
        const delta = msg.message?.content ?? ''
        if (delta) {
          out += delta
          if (req.stream) send(delta)
        }
      }
    }
    // Strip inline reasoning from models that emit it in the answer text.
    return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  } finally {
    running.delete(req.id)
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 32) {
    const res = await fetch(`${settings.baseUrl}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: settings.embedModel, input: texts.slice(i, i + 32) })
    })
    if (!res.ok) throw new Error(`${settings.embedModel}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { embeddings: number[][] }
    out.push(...body.embeddings)
  }
  return out
}

// ---------- documents ----------

const libraryPath = (): string => join(dataDir(), 'library.json')

async function openDoc(path: string): Promise<OpenedDoc> {
  const data = await fs.readFile(path)
  const id = createHash('sha1').update(data).digest('hex').slice(0, 16)
  const state = await readJson<DocState | null>(join(docDir(id), 'state.json'), null)
  const index = await readJson<DocIndex | null>(join(docDir(id), 'index.json'), null)
  return { id, path, data: new Uint8Array(data), state, index }
}

async function saveState(state: DocState): Promise<void> {
  await writeJson(join(docDir(state.id), 'state.json'), state)
  const lib = await readJson<LibraryEntry[]>(libraryPath(), [])
  const entry: LibraryEntry = {
    id: state.id,
    path: state.path,
    title: state.title || basename(state.path),
    opened: state.opened
  }
  await writeJson(libraryPath(), [entry, ...lib.filter((e) => e.id !== state.id)].slice(0, 200))
}

function toPdfUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web links can be downloaded')
  if (/(^|\.)arxiv\.org$/.test(url.hostname)) {
    url.protocol = 'https:'
    url.pathname = url.pathname.replace(/^\/abs\//, '/pdf/')
  }
  return url
}

async function downloadPdf(raw: string): Promise<string> {
  const url = toPdfUrl(raw)
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('That link did not return a PDF')
  const dir = join(dataDir(), 'downloads')
  await fs.mkdir(dir, { recursive: true })
  const name = (basename(url.pathname).replace(/[^\w.-]/g, '_') || 'paper').replace(/\.pdf$/i, '')
  const path = join(dir, `${name}.pdf`)
  await fs.writeFile(path, bytes)
  return path
}

// ---------- window ----------

// A PDF passed on the command line or opened with the app from Finder.
let pendingPath: string | null = process.argv.slice(1).find((a) => /\.pdf$/i.test(a) && existsSync(a)) ?? null

app.on('open-file', (e, path) => {
  e.preventDefault()
  const win = BrowserWindow.getAllWindows()[0]
  if (win) win.webContents.send('app:open-path', path)
  else pendingPath = path
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ece9d8',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  await loadSettings()
  void ensureServer()

  ipcMain.handle('doc:pick', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('app:initial-path', () => {
    const p = pendingPath
    pendingPath = null
    return p
  })
  ipcMain.handle('doc:open', (_e, path: string) => openDoc(path))
  ipcMain.handle('doc:save-state', (_e, state: DocState) => saveState(state))
  ipcMain.handle('doc:save-index', (_e, id: string, index: DocIndex) =>
    writeJson(join(docDir(id), 'index.json'), index)
  )
  ipcMain.handle('library:list', async () => {
    const lib = await readJson<LibraryEntry[]>(libraryPath(), [])
    return lib.filter((e) => existsSync(e.path))
  })
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', async (_e, next: Settings) => {
    settings = { ...DEFAULT_SETTINGS, ...next }
    await writeJson(join(dataDir(), 'settings.json'), settings)
    return settings
  })
  ipcMain.handle('llm:status', () => llmStatus())
  ipcMain.handle('llm:chat', (e, req: ChatRequest) =>
    chat(req, (delta) => {
      if (!e.sender.isDestroyed()) e.sender.send('llm:delta', req.id, delta)
    })
  )
  ipcMain.handle('llm:abort', (_e, id: string) => running.get(id)?.abort())
  ipcMain.handle('llm:embed', (_e, texts: string[]) => embed(texts))
  ipcMain.handle('web:search', (_e, query: string) => searchWeb(query))
  ipcMain.handle('web:open', async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle('web:download-pdf', (_e, url: string) => downloadPdf(url))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => ownedServer?.kill())
// Also stop the model server when the app is killed rather than quit.
process.on('exit', () => ownedServer?.kill())
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit())
