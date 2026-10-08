/**
 * Content-addressed asset ids. Kept free of Dexie so the DOCX reader (which runs in a Web Worker and must not touch IndexedDB)
 * can derive exactly the ids `assetStore` stores under, without importing the database. `assetStore` re-exports both.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export const assetIdFor = (sha: string) => 'a_' + sha.slice(0, 32);
