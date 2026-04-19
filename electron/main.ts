import { app, BrowserWindow, ipcMain, net, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, '..');

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - SystemJS only
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

let win: BrowserWindow | null;

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    width: 1280,
    height: 800,
    titleBarStyle: 'hiddenInset',
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handler: POST requests via Electron net module (bypasses CORS — no browser preflight)
ipcMain.handle('net-post', async (_event, { url, headers, body }: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => {
  try {
    const response = await net.fetch(url, { method: 'POST', headers, body });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: String(err) };
  }
});

// IPC handler: GET requests via Electron net module (bypasses CORS)
ipcMain.handle('net-get', async (_event, { url, headers }: {
  url: string;
  headers: Record<string, string>;
}) => {
  try {
    const response = await net.fetch(url, { method: 'GET', headers });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: String(err) };
  }
});

// Secure storage: encrypt/decrypt API keys using OS keychain via safeStorage
function getSecureStorePath(): string {
  return path.join(app.getPath('userData'), 'secure-store.json');
}

function readSecureStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(getSecureStorePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecureStore(store: Record<string, string>): void {
  fs.writeFileSync(getSecureStorePath(), JSON.stringify(store), 'utf-8');
}

ipcMain.handle('secure-storage-set', (_event, { key, value }: { key: string; value: string }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    const store = readSecureStore();
    store[key] = value;
    writeSecureStore(store);
    return;
  }
  const store = readSecureStore();
  store[key] = safeStorage.encryptString(value).toString('base64');
  writeSecureStore(store);
});

ipcMain.handle('secure-storage-get', (_event, { key }: { key: string }): string | null => {
  const store = readSecureStore();
  const raw = store[key];
  if (raw == null) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
});

ipcMain.handle('secure-storage-remove', (_event, { key }: { key: string }) => {
  const store = readSecureStore();
  delete store[key];
  writeSecureStore(store);
});

app.whenReady().then(createWindow);
