import { app as o, BrowserWindow as i, ipcMain as R, net as w } from "electron";
import e from "node:path";
import { fileURLToPath as h } from "node:url";
const s = e.dirname(h(import.meta.url));
process.env.APP_ROOT = e.join(s, "..");
const r = process.env.VITE_DEV_SERVER_URL, P = e.join(process.env.APP_ROOT, "dist-electron"), a = e.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = r ? e.join(process.env.APP_ROOT, "public") : a;
let n;
function c() {
  n = new i({
    icon: e.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: e.join(s, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0,
      webSecurity: !0
    },
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset"
  }), r ? n.loadURL(r) : n.loadFile(e.join(a, "index.html"));
}
o.on("window-all-closed", () => {
  process.platform !== "darwin" && (o.quit(), n = null);
});
o.on("activate", () => {
  i.getAllWindows().length === 0 && c();
});
R.handle("net-post", async (m, { url: l, headers: p, body: d }) => {
  try {
    const t = await w.fetch(l, { method: "POST", headers: p, body: d }), _ = await t.text();
    return { ok: t.ok, status: t.status, text: _ };
  } catch (t) {
    return { ok: !1, status: 0, text: "", error: String(t) };
  }
});
o.whenReady().then(c);
export {
  P as MAIN_DIST,
  a as RENDERER_DIST,
  r as VITE_DEV_SERVER_URL
};
