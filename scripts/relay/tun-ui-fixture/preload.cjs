const { contextBridge, ipcRenderer } = require('electron')

// This fixture has a separate, unprivileged IPC namespace. No production main
// process, native executable, installation or persistent store is loaded.
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel, input) => ipcRenderer.invoke('fixture', channel, input),
    on: () => () => {}
  }
})
