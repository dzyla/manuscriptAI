"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  // CORS-free POST via Electron main process (used for APIs without CORS headers)
  netPost: (url, headers, body) => electron.ipcRenderer.invoke("net-post", { url, headers, body }),
  // CORS-free GET via Electron main process
  netGet: (url, headers) => electron.ipcRenderer.invoke("net-get", { url, headers }),
  // Encrypted key storage via OS keychain (safeStorage)
  secureStorage: {
    get: (key) => electron.ipcRenderer.invoke("secure-storage-get", { key }),
    set: (key, value) => electron.ipcRenderer.invoke("secure-storage-set", { key, value }),
    remove: (key) => electron.ipcRenderer.invoke("secure-storage-remove", { key })
  }
});
