import { app as n, BrowserWindow as i } from "electron";
import e from "node:path";
import { fileURLToPath as c } from "node:url";
const r = e.dirname(c(import.meta.url));
process.env.APP_ROOT = e.join(r, "..");
const t = process.env.VITE_DEV_SERVER_URL, R = e.join(process.env.APP_ROOT, "dist-electron"), s = e.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = t ? e.join(process.env.APP_ROOT, "public") : s;
let o;
function l() {
  o = new i({
    icon: e.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: e.join(r, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0,
      webSecurity: !1
      // Disable CORS restrictions to communicate intimately with Local APIs across origins
    },
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset"
  }), t ? o.loadURL(t) : o.loadFile(e.join(s, "index.html"));
}
n.on("window-all-closed", () => {
  process.platform !== "darwin" && (n.quit(), o = null);
});
n.on("activate", () => {
  i.getAllWindows().length === 0 && l();
});
n.whenReady().then(l);
export {
  R as MAIN_DIST,
  s as RENDERER_DIST,
  t as VITE_DEV_SERVER_URL
};
