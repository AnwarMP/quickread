/// <reference types="vite/client" />
import type { QrApi } from '../../shared/types'

declare global {
  interface Window {
    qr: QrApi
  }
}
