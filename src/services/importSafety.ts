/**
 * A second way back for the document an import is about to replace: a Version History snapshot, which the existing Version History
 * popup lists and restores. (The first is the repository's pinned backup, restored by `revertImport`.) The snapshot is HTML, so it
 * is the text and basic formatting, not the Word-specific content the backup keeps.
 */
import type { ManuscriptDb } from '../db/manuscriptDb';
import { inlineAssetImages } from '../db/assetStore';
import type { VersionSnapshot } from '../types';
import { isBlankDoc } from '../db/placeholder';
import { htmlToDoc } from '../extensions/schema';

/**
 * True for HTML with nothing in it worth keeping, by the same test as everywhere else (`isBlankDoc`): no text or only the placeholder,
 * and no image, line break, rule, citation or other non-text content. Anything it cannot read is NOT blank (the safe answer is to ask).
 */
export function isBlankHtml(html: string): boolean {
  try {
    return isBlankDoc(htmlToDoc(html));
  } catch {
    return false;
  }
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
      // the random part: two imports in the same millisecond must not share an id (the second would overwrite the first)
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/**
 * The button text for restoring the document an import replaced. It names that document: the restore goes to the newest backup an
 * import took, which after an import over a blank document is an EARLIER one, and a button that only said "previous document" would
 * not say which.
 */
export function revertLabel(target: { title: string }): string {
  const t = target.title.trim() || 'Untitled Manuscript';
  return `Restore previous document: "${t.length > 40 ? `${t.slice(0, 39)}…` : t}"`;
}
