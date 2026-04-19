// src/services/secureStorage.ts

type ElectronSecureStorage = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

function getElectronSecureStorage(): ElectronSecureStorage | null {
  return (window as any).electron?.secureStorage ?? null;
}

export function isEncrypted(): boolean {
  return getElectronSecureStorage() !== null;
}

export async function getItem(key: string): Promise<string | null> {
  const electron = getElectronSecureStorage();
  if (electron) return electron.get(key);
  return localStorage.getItem(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  const electron = getElectronSecureStorage();
  if (electron) return electron.set(key, value);
  localStorage.setItem(key, value);
}

export async function removeItem(key: string): Promise<void> {
  const electron = getElectronSecureStorage();
  if (electron) return electron.remove(key);
  localStorage.removeItem(key);
}

// Call once at app startup (Electron only). Reads legacy localStorage key,
// re-saves via encrypted IPC, then deletes from localStorage.
export async function migrateFromLocalStorage(key: string): Promise<void> {
  if (!isEncrypted()) return;
  const legacy = localStorage.getItem(key);
  if (legacy == null) return;
  await setItem(key, legacy);
  localStorage.removeItem(key);
}
