"use strict";const e=require("electron");e.contextBridge.exposeInMainWorld("electron",{platform:process.platform,netPost:(t,o,r)=>e.ipcRenderer.invoke("net-post",{url:t,headers:o,body:r})});
