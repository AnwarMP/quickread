import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { QrApi } from '../shared/types'

const api: QrApi = {
  pickPdf: () => ipcRenderer.invoke('doc:pick'),
  openDoc: (path) => ipcRenderer.invoke('doc:open', path),
  saveState: (state) => ipcRenderer.invoke('doc:save-state', state),
  saveIndex: (id, index) => ipcRenderer.invoke('doc:save-index', id, index),
  library: () => ipcRenderer.invoke('library:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  llmStatus: () => ipcRenderer.invoke('llm:status'),
  chat: (req) => ipcRenderer.invoke('llm:chat', req),
  abort: (id) => ipcRenderer.invoke('llm:abort', id),
  embed: (texts) => ipcRenderer.invoke('llm:embed', texts),
  search: (query) => ipcRenderer.invoke('web:search', query),
  openExternal: (url) => ipcRenderer.invoke('web:open', url),
  downloadPdf: (url) => ipcRenderer.invoke('web:download-pdf', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  initialPath: () => ipcRenderer.invoke('app:initial-path'),
  onOpenPath: (cb) => {
    const fn = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('app:open-path', fn)
    return () => ipcRenderer.removeListener('app:open-path', fn)
  },
  onDelta: (cb) => {
    const fn = (_e: unknown, id: string, delta: string): void => cb(id, delta)
    ipcRenderer.on('llm:delta', fn)
    return () => ipcRenderer.removeListener('llm:delta', fn)
  }
}

contextBridge.exposeInMainWorld('qr', api)
