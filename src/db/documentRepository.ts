import type { JSONContent } from '@tiptap/core';
import type { ManuscriptDb } from './manuscriptDb';
import type { BackupRow, CommentThread, DocFormat, DocumentMode, DocumentRow, DocxPackageRow } from '../types';
import { prepareAssets, hydrateAssets, collectAssetIds, liveAssetIds, type AssetUrlResolver } from './assetStore';
import { stableStringify } from '../docx/preserve/hash';
import { collectFragmentIds, pruneFragments } from '../docx/preserve/xml';
import { createFormat } from '../services/formatPresets';

export interface LoadedDocument {
  title: string;
  saveState: DocumentRow['saveState'];
  docJson: JSONContent;
  format: DocFormat;
  comments: CommentThread[];
  citationRegistry: Record<string, number>;
  citationCounter: number;
  figureRegistry: Record<string, number>;
  figureCounter: number;
  mode: DocumentMode;
  grantInstructions: string;
  grantTemplateId: string | null;
}

export interface LoadResult {
  doc: LoadedDocument | null;
  migrated: boolean;
  recoveredFromBackup: boolean;
  /** The current row exists but could not be converted (corrupt or written by a newer build). */
  unreadableRowPresent: boolean;
  /** True only if a protected (quarantined) copy of the unreadable row is known to exist. */
  quarantined: boolean;
}

export interface SaveResult {
  /** Non-fatal problems (e.g. an image that had to stay inline). The save itself succeeded. */
  warnings: string[];
  /** False when the document was identical to the stored row and nothing was written. */
  written: boolean;
}

export interface DocumentRepository {
  load(): Promise<LoadResult>;
  save(doc: LoadedDocument): Promise<SaveResult>;
  getPackage(): Promise<DocxPackageRow | undefined>;
  savePackage(pkg: DocxPackageRow): Promise<void>;
  listBackups(): Promise<BackupRow[]>;
  restoreBackup(seq: number): Promise<LoadedDocument>;
}

export interface RepositoryDeps {
  htmlToDoc(html: string): JSONContent;
  isValidDoc(doc: unknown): boolean;
  resolver?: AssetUrlResolver;
  fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }>;
  maxBackups?: number;
  /** Asset ids that must survive GC because the session can still reference them (default: object-URL cache). */
  liveAssetIds?: () => Iterable<string>;
}

/** Row identity for no-op detection: everything except bookkeeping fields. */
function rowFingerprint(row: DocumentRow): string {
  const { updatedAt: _u, saveState: _s, ...rest } = row;
  return stableStringify(rest);
}

export function createDexieRepository(db: ManuscriptDb, deps: RepositoryDeps): DocumentRepository {
  const maxBackups = deps.maxBackups ?? 10;
  let queue: Promise<unknown> = Promise.resolve();

  /** Convert a stored row to a LoadedDocument (no hydration). Returns null if the body is unusable. */
  function rowToDoc(row: DocumentRow): { doc: LoadedDocument; fromHtml: boolean } | null {
    let docJson: JSONContent | null = null;
    let fromHtml = false;
    if (row.docJson !== undefined) {
      docJson = deps.isValidDoc(row.docJson) ? row.docJson : null;
    } else if (typeof row.content === 'string') {
      docJson = deps.htmlToDoc(row.content);
      fromHtml = true;
    }
    if (!docJson) return null;
    return {
      fromHtml,
      doc: {
        title: row.title,
        saveState: row.saveState,
        docJson,
        format: row.format ?? createFormat('nih'),
        comments: row.comments ?? [],
        citationRegistry: row.citationRegistry ?? {},
        citationCounter: row.citationCounter ?? 0,
        figureRegistry: row.figureRegistry ?? {},
        figureCounter: row.figureCounter ?? 0,
        mode: row.mode ?? 'manuscript',
        grantInstructions: row.grantInstructions ?? '',
        grantTemplateId: row.grantTemplateId ?? null,
      },
    };
  }

  async function hydrate(doc: LoadedDocument): Promise<LoadedDocument> {
    const docJson = await hydrateAssets(doc.docJson, id => db.assets.get(id), deps.resolver);
    return { ...doc, docJson };
  }

  interface SaveOutcome extends SaveResult { row: DocumentRow }

  async function doSave(doc: LoadedDocument, opts: { pinPrevious?: boolean } = {}): Promise<SaveOutcome> {
    // Async work that is not IndexedDB (hashing, fetching) must happen before the transaction.
    // Which referenced assets still have a row? A node whose asset was collected but which still carries
    // live bytes (undo/paste of a session blob: URL) is re-ingested rather than left dangling.
    const referenced = [...collectAssetIds(doc.docJson)];
    // Keys only: never pull every image's bytes out of IndexedDB just to check existence.
    const existingAssetIds = new Set(
      referenced.length ? ((await db.assets.where(':id').anyOf(referenced).primaryKeys()) as string[]) : [],
    );
    const { doc: storedJson, assets, warnings } = await prepareAssets(doc.docJson, { fetchBytes: deps.fetchBytes, existingAssetIds });
    const row: DocumentRow = {
      id: 'current',
      title: doc.title,
      docJson: storedJson,
      format: doc.format,
      comments: doc.comments,
      schemaVersion: 3,
      saveState: doc.saveState,
      citationRegistry: doc.citationRegistry,
      citationCounter: doc.citationCounter,
      figureRegistry: doc.figureRegistry,
      figureCounter: doc.figureCounter,
      updatedAt: Date.now(),
      mode: doc.mode,
      grantInstructions: doc.grantInstructions,
      grantTemplateId: doc.grantTemplateId ?? undefined,
    };
    const fingerprint = rowFingerprint(row);
    const live = new Set(deps.liveAssetIds ? deps.liveAssetIds() : liveAssetIds());
    let written = true;
    await db.transaction('rw', [db.documents, db.assets, db.autosaveBackups, db.docxPackages], async () => {
      const prev = await db.documents.get('current');
      if (assets.length) await db.assets.bulkPut(assets); // idempotent (content-addressed)
      // Pin only a genuine legacy (pre-v3 HTML) row. A concurrent second migration (e.g. StrictMode
      // double init) finds the already-migrated row and is then an ordinary — usually no-op — save.
      const pin = !!opts.pinPrevious && !!prev && prev.docJson === undefined && typeof prev.content === 'string';
      // Unchanged document: no backup, no rewrite, so the ring never turns over on idle autosaves.
      if (prev && !pin && rowFingerprint(prev) === fingerprint) {
        written = false;
        return;
      }
      if (prev) {
        await db.autosaveBackups.add({ documentId: 'current', savedAt: Date.now(), row: prev, ...(pin ? { pinned: true as const } : {}) });
      }
      // Quarantined (unreadable) and pinned (pre-migration) rows are exempt from the ring.
      const all = (await db.autosaveBackups.orderBy('seq').toArray()).filter(b => !b.quarantined && !b.pinned);
      const excess = all.length - maxBackups;
      if (excess > 0) await db.autosaveBackups.bulkDelete(all.slice(0, excess).map(b => b.seq!));
      await db.documents.put(row);

      const backups = await db.autosaveBackups.toArray();
      const keepAssets = collectAssetIds(row.docJson);
      live.forEach(id => keepAssets.add(id));
      const keepFragments = collectFragmentIds(row.docJson!);
      // A corrupt backup must never abort the save or cause deletions we cannot justify:
      // if any backup cannot be scanned, skip garbage collection for this save.
      let scannable = true;
      for (const b of backups) {
        try {
          collectAssetIds(b.row.docJson).forEach(id => keepAssets.add(id));
          if (b.row.docJson) collectFragmentIds(b.row.docJson).forEach(id => keepFragments.add(id));
        } catch {
          scannable = false;
        }
      }
      if (!scannable) return;
      const allAssetIds = (await db.assets.toCollection().primaryKeys()) as string[];
      const dead = allAssetIds.filter(id => !keepAssets.has(id));
      if (dead.length) await db.assets.bulkDelete(dead);

      const pkg = await db.docxPackages.get('current');
      if (pkg) await db.docxPackages.put({ ...pkg, preservation: pruneFragments(pkg.preservation, keepFragments) });
    });
    return { row, warnings, written };
  }

  /** Serialize all writes: a save never interleaves with another save. */
  function enqueue(doc: LoadedDocument, opts?: { pinPrevious?: boolean }): Promise<SaveOutcome> {
    const run = queue.then(() => doSave(doc, opts));
    queue = run.catch(() => undefined); // keep the queue alive after a failure
    return run;
  }

  /**
   * Preserve an unreadable current row outside the backup ring (idempotent per row.updatedAt).
   * Returns true only if a quarantined copy is confirmed to exist afterwards.
   */
  async function quarantine(row: DocumentRow): Promise<boolean> {
    const isCopy = (b: BackupRow) => !!b.quarantined && b.row.updatedAt === row.updatedAt;
    try {
      await db.transaction('rw', db.autosaveBackups, async () => {
        const existing = await db.autosaveBackups.toArray();
        if (existing.some(isCopy)) return;
        await db.autosaveBackups.add({ documentId: 'current', savedAt: Date.now(), row, quarantined: true });
      });
    } catch (err) {
      console.error('Could not quarantine unreadable document row', err);
    }
    try {
      return (await db.autosaveBackups.toArray()).some(isCopy);
    } catch {
      return false;
    }
  }

  const repo: DocumentRepository = {
    async save(doc) {
      const { warnings, written } = await enqueue(doc);
      return { warnings, written };
    },

    async load() {
      const ok = { migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false };
      const row = await db.documents.get('current');
      if (!row) return { doc: null, ...ok };
      const converted = rowToDoc(row);
      if (converted) {
        if (converted.fromHtml) {
          let saved: SaveOutcome;
          try {
            // The pre-migration row becomes a pinned backup: never trimmed, still recoverable.
            saved = await enqueue(converted.doc, { pinPrevious: true });
          } catch (err) {
            // Legacy row is untouched (transaction rolled back): open the converted document
            // anyway and retry the migration on the next load.
            console.error('Legacy document migration failed; will retry on next load', err);
            return { doc: converted.doc, ...ok };
          }
          // Return exactly what was migrated. Re-reading the row could observe a later queued save.
          return { doc: await hydrate({ ...converted.doc, docJson: saved.row.docJson! }), ...ok, migrated: true };
        }
        return { doc: await hydrate(converted.doc), ...ok };
      }
      const quarantined = await quarantine(row);
      for (const b of await repo.listBackups()) {
        if (b.quarantined) continue;
        const c = rowToDoc(b.row);
        if (c) return { doc: await hydrate(c.doc), migrated: false, recoveredFromBackup: true, unreadableRowPresent: true, quarantined };
      }
      return { doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: true, quarantined };
    },

    getPackage: () => db.docxPackages.get('current'),
    async savePackage(pkg) { await db.docxPackages.put(pkg); },

    async listBackups() {
      return (await db.autosaveBackups.orderBy('seq').toArray()).reverse();
    },

    async restoreBackup(seq) {
      const b = await db.autosaveBackups.get(seq);
      const c = b && !b.quarantined ? rowToDoc(b.row) : null;
      if (!c) throw new Error(`Backup ${seq} is missing or unreadable`);
      return hydrate(c.doc);
    },
  };
  return repo;
}
