/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  const component: DefineComponent<{}, {}, any>
  export default component
}
interface ImportMetaEnv {
  readonly VITE_GITHUB_CLIENT_ID: string
  readonly VITE_GITHUB_CLIENT_SECRET: string
  readonly VITE_GITHUB_REDIRECT_URI: string
  readonly VITE_LOG_IPC_CALL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    api: {
      copyText: (text: string) => void
      copyImage: (imageDataUrl: string) => void
      getPathForFile: (file: File) => string
      getWindowId: () => number | null
      getWebContentsId: () => number
      debugLog: (label: string, payload: unknown) => void
      openExternal?: (url: string) => Promise<boolean> | void
    }
  }
}

export {}
