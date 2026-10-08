import type { JSONContent } from '@tiptap/core';
import type { ManuscriptDb } from './manuscriptDb';
import type { BackupRow, CommentThread, DocFormat, DocumentMode, DocumentRow, DocxPackageRow } from '../types';
import { prepareAssets, hydrateAssets, collectAssetIds, type AssetUrlResolver } from './assetStore';
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
}

export interface DocumentRepository {
  load(): Promise<LoadResult>;
  save(doc: LoadedDocument): Promise<void>;
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

  async function doSave(doc: LoadedDocument): Promise<void> {
    // Async work that is not IndexedDB (hashing, fetching) must happen before the transaction.
    const { doc: storedJson, assets } = await prepareAssets(doc.docJson, { fetchBytes: deps.fetchBytes });
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
    await db.transaction('rw', [db.documents, db.assets, db.autosaveBackups, db.docxPackages], async () => {
      const prev = await db.documents.get('current');
      if (prev) await db.autosaveBackups.add({ documentId: 'current', savedAt: Date.now(), row: prev });
      // Quarantined (unreadable) rows are exempt from the ring: only regular backups are counted/trimmed.
      const all = (await db.autosaveBackups.orderBy('seq').toArray()).filter(b => !b.quarantined);
      const excess = all.length - maxBackups;
      if (excess > 0) await db.autosaveBackups.bulkDelete(all.slice(0, excess).map(b => b.seq!));
      if (assets.length) await db.assets.bulkPut(assets);
      await db.documents.put(row);

      const backups = await db.autosaveBackups.toArray();
      const keepAssets = collectAssetIds(row.docJson);
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
  }

  /** Preserve an unreadable current row outside the backup ring (idempotent per row.updatedAt). */
  async function quarantine(row: DocumentRow): Promise<void> {
    try {
      await db.transaction('rw', db.autosaveBackups, async () => {
        const existing = await db.autosaveBackups.toArray();
        if (existing.some(b => b.quarantined && b.row.updatedAt === row.updatedAt)) return;
        await db.autosaveBackups.add({ documentId: 'current', savedAt: Date.now(), row, quarantined: true });
      });
    } catch (err) {
      console.error('Could not quarantine unreadable document row', err);
    }
  }

  const repo: DocumentRepository = {
    save(doc) {
      const run = queue.then(() => doSave(doc));
      queue = run.catch(() => undefined); // keep the queue alive after a failure
      return run;
    },

    async load() {
      const row = await db.documents.get('current');
      if (!row) return { doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: false };
      const converted = rowToDoc(row);
      if (converted) {
        if (converted.fromHtml) {
          try {
            await repo.save(converted.doc); // pre-migration row becomes the newest backup
          } catch (err) {
            // Legacy row is untouched (transaction rolled back): open the converted document
            // anyway and retry the migration on the next load.
            console.error('Legacy document migration failed; will retry on next load', err);
            return { doc: converted.doc, migrated: false, recoveredFromBackup: false, unreadableRowPresent: false };
          }
          const fresh = rowToDoc((await db.documents.get('current'))!)!;
          return { doc: await hydrate(fresh.doc), migrated: true, recoveredFromBackup: false, unreadableRowPresent: false };
        }
        return { doc: await hydrate(converted.doc), migrated: false, recoveredFromBackup: false, unreadableRowPresent: false };
      }
      await quarantine(row);
      for (const b of await repo.listBackups()) {
        if (b.quarantined) continue;
        const c = rowToDoc(b.row);
        if (c) return { doc: await hydrate(c.doc), migrated: false, recoveredFromBackup: true, unreadableRowPresent: true };
      }
      return { doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: true };
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
