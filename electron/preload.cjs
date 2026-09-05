// Kairos — preload：向渲染层暴露最小桌面桥（window.kairos）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kairos', {
  // 命令调用：与原 Tauri invoke 命令名一一对应
  invoke: (cmd, args) => ipcRenderer.invoke('kairos:invoke', cmd, args),
  // 事件订阅：主进程 send('kairos:event:<name>', payload)
  on: (event, cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on(`kairos:event:${event}`, listener)
    return () => ipcRenderer.removeListener(`kairos:event:${event}`, listener)
  },
  minimize: () => ipcRenderer.send('kairos:win', 'minimize'),
  close: () => ipcRenderer.send('kairos:win', 'close'),
  notify: (title, body) => ipcRenderer.send('kairos:notify', { title, body }),
})
