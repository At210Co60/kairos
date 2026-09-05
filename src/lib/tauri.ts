/**
 * 桌面桥接 shim：Electron preload 暴露 window.kairos。
 * 接口签名与原 Tauri API 保持一致（invoke / listen / getCurrentWindow），
 * 面板代码只替换 import 来源，逻辑零改动。
 */

type Args = Record<string, unknown>

declare global {
  interface Window {
    kairos?: {
      invoke: (cmd: string, args?: Args) => Promise<unknown>
      on: (event: string, cb: (payload: unknown) => void) => () => void
      minimize: () => void
      close: () => void
      notify: (title: string, body: string) => void
    }
  }
}

/** 桌面桥可用（Electron 环境）；纯浏览器预览时为 false */
export const inTauri = typeof window !== 'undefined' && !!window.kairos

export async function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  if (!window.kairos) throw new Error('桌面桥不可用（非 Electron 环境）')
  return (await window.kairos.invoke(cmd, args)) as T
}

export function listen<T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<() => void> {
  if (!window.kairos) return Promise.resolve(() => {})
  const off = window.kairos.on(event, (payload) => handler({ payload: payload as T }))
  return Promise.resolve(off)
}

export function getCurrentWindow() {
  return {
    minimize: () => window.kairos?.minimize(),
    close: () => window.kairos?.close(),
  }
}

export function notify(title: string, body: string) {
  window.kairos?.notify(title, body)
}
