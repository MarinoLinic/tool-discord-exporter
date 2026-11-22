const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('archive', {
  call: (action, input) => ipcRenderer.invoke('archive:call', action, input),
  progress: listener => ipcRenderer.on('archive:progress', (_, data) => listener(data)),
});
