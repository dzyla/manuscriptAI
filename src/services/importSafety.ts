/**
 * A second way back for the document an import is about to replace: a Version History snapshot, which the existing Version History
 * popup lists and restores. (The first is the repository's pinned backup, restored by `revertImport`.) The snapshot is HTML, so it
 * is the text and basic formatting, not the Word-specific content the backup keeps.
 */
import type { ManuscriptDb } from '../db/manuscriptDb';
import { inlineAssetImages } from '../db/assetStore';
import type { VersionSnapshot } from '../types';
import { isBlankText } from '../db/placeholder';

/** True for a document with nothing in it worth keeping: empty, or the untouched placeholder text. */
export function isBlankHtml(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  return isBlankText(html.replace(/<[^>]*>/g, ' '));
}

/**
 * Returns the snapshot written, or null when there was nothing to keep or it could not be written. It never throws: a snapshot is a
 * convenience, and the import has its own backup.
 */
export async function snapshotBeforeImport(
  db: Pick<ManuscriptDb, 'versionSnapshots' | 'assets'>,
  doc: { title: string; content: string; importing: string },
): Promise<VersionSnapshot | null> {
  if (isBlankHtml(doc.content)) return null;
  try {
    const text = doc.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const snapshot: VersionSnapshot = {
      id: `snap-${Date.now()}`,
      name: `Before importing ${doc.importing}`,
      timestamp: Date.now(),
      title: doc.title,
      // Self-contained copy: session blob: image URLs would be dead after a reload.
      content: await inlineAssetImages(doc.content, { getAsset: id => db.assets.get(id) }),
      wordCount: text.split(/\s+/).filter(Boolean).length,
    };
    await db.versionSnapshots.put(snapshot);
    return snapshot;
  } catch (err) {
    console.error('Could not write a Version History snapshot before the import', err);
    return null;
  }
}
