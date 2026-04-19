import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  // CORS-free POST via Electron main process (used for APIs without CORS headers)
  netPost: (url, headers, body) => ipcRenderer.invoke('net-post', { url, headers, body }),
  // CORS-free GET via Electron main process
  netGet: (url, headers) => ipcRenderer.invoke('net-get', { url, headers }),
  // Encrypted key storage via OS keychain (safeStorage)
  secureStorage: {
    get: (key) => ipcRenderer.invoke('secure-storage-get', { key }),
    set: (key, value) => ipcRenderer.invoke('secure-storage-set', { key, value }),
    remove: (key) => ipcRenderer.invoke('secure-storage-remove', { key }),
  },
});
