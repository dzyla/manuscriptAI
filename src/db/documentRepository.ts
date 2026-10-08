import type { JSONContent } from '@tiptap/core';
import type { ManuscriptDb } from './manuscriptDb';
import type { AssetRow, BackupRow, CommentThread, DocFormat, DocumentMode, DocumentRow, DocxPackageRow } from '../types';
import type { ImportResult } from '../docx/read';
import { prepareAssets, hydrateAssets, collectAssetIds, liveAssetIds, type AssetUrlResolver } from './assetStore';
import { stableStringify } from '../docx/preserve/hash';
import { collectFragmentIds, pruneFragments } from '../docx/preserve/refs';
import type { PreservationStore } from '../docx/preserve/types';
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
  getPreservation(): Promise<PreservationStore | undefined>;
  savePreservation(store: PreservationStore): Promise<void>;
  /**
   * Commit a confirmed .docx import: ONE read-write transaction over the document row, the image assets, the backup ring, the
   * original package and the preservation map. Either all of it lands or none of it does (a failed import leaves the previous
   * document, its package and its assets exactly as they were). The replaced document is kept as a backup that the ring never trims
   * (and that carries the package and preservation map this import overwrites).
   *
   * An explicit user action, so it does not refuse when the current row is unreadable: that row is quarantined instead. Serialised
   * with saves (a save queued earlier completes first; one queued later runs after and so overwrites the import: the caller must
   * stop autosaving while an import is in flight, see `useDocumentStore.importDocx`).
   *
   * `result.doc` is stored as given: apply the accepted headings (`applyHeadings`) BEFORE calling.
   */
  importDocx(result: ImportResult, decisions: { title: string }): Promise<void>;
  listBackups(): Promise<BackupRow[]>;
  restoreBackup(seq: number): Promise<LoadedDocument>;
}

export interface RepositoryDeps {
  htmlToDoc(html: string): JSONContent;
  isValidDoc(doc: unknown): boolean;
  /**
   * Rewrite legacy HTML (before it is converted) using the row's citation registry, e.g. plain "[N]" text to
   * citation nodes. Applied ONLY to genuinely legacy rows (no docJson): an HTML round trip would drop hidden
   * attributes (ooxml provenance, style ids) from a v3 or DOCX-imported document. Because it runs inside the
   * legacy conversion, the migrated document is what gets pinned/saved, so it happens exactly once.
   */
  migrateLegacyHtml?(html: string, citationRegistry: Record<string, number>): string;
  resolver?: AssetUrlResolver;
  fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }>;
  maxBackups?: number;
  /** How many replaced-by-import backups are kept (each holds the replaced document's whole package). Default 3. */
  maxImportBackups?: number;
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
  const maxImportBackups = deps.maxImportBackups ?? 3;
  let queue: Promise<unknown> = Promise.resolve();

  /** Convert a stored row to a LoadedDocument (no hydration). Returns null if the body is unusable. */
  function rowToDoc(row: DocumentRow): { doc: LoadedDocument; fromHtml: boolean } | null {
    let docJson: JSONContent | null = null;
    let fromHtml = false;
    if (row.docJson !== undefined) {
      docJson = deps.isValidDoc(row.docJson) ? row.docJson : null;
    } else if (typeof row.content === 'string') {
      docJson = deps.htmlToDoc(
        deps.migrateLegacyHtml ? deps.migrateLegacyHtml(row.content, row.citationRegistry ?? {}) : row.content,
      );
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
    await db.transaction('rw', [db.documents, db.assets, db.autosaveBackups, db.preservationStores], async () => {
      const prev = await db.documents.get('current');
      if (assets.length) await db.assets.bulkPut(assets); // idempotent (content-addressed)
      // Pin only a genuine legacy (pre-v3 HTML) row. A concurrent second migration (e.g. StrictMode
      // double init) finds the already-migrated row and is then an ordinary — usually no-op — save.
      const pin = !!opts.pinPrevious && !!prev && prev.docJson === undefined && typeof prev.content === 'string';
      // Unchanged document: no backup, no rewrite, so the ring never turns over on idle autosaves.
      if (prev && !pin && rowFingerprint(prev) === fingerprint) {
        written = false;
        // saveState is excluded from the fingerprint, so keep the badge on disk current: rewrite only that
        // field of the existing row (same updatedAt, no backup, no GC).
        if (prev.saveState !== row.saveState) await db.documents.put({ ...prev, saveState: row.saveState });
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

      // Fragments are kept while the current row or any remaining backup references them (the same rule as
      // assets), so undoing a deleted equation still finds its XML. Only the small preservation row is touched,
      // and only when something actually has to go; the original package bytes are never rewritten.
      const pres = await db.preservationStores.get('current');
      if (pres) {
        const pruned = pruneFragments(pres.store, keepFragments);
        if (Object.keys(pruned.fragments).length !== Object.keys(pres.store.fragments).length) {
          await db.preservationStores.put({ ...pres, store: pruned, updatedAt: Date.now() });
        }
      }
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

  async function doImport(result: ImportResult, decisions: { title: string }): Promise<void> {
    if (!deps.isValidDoc(result.doc)) {
      // Stored, it would load back as an "unreadable" document. Refuse before anything is written.
      throw new Error('The imported document is not valid for this editor, so it was not imported.');
    }
    const referenced = collectAssetIds(result.doc);
    const drafts = new Map(result.assets.map(a => [a.id, a]));
    // Only the images the document uses are stored: the garbage collector would remove any other, and the document row names the
    // ones it needs, so a figure can never be left without its bytes by a later save.
    const rows: AssetRow[] = [...referenced]
      .filter(id => drafts.has(id))
      .map(id => {
        const a = drafts.get(id)!;
        return { id: a.id, sha256: a.sha256, mime: a.mime, size: a.data.byteLength, data: a.data, createdAt: Date.now() };
      });
    const needExisting = [...referenced].filter(id => !drafts.has(id));
    const title = decisions.title.trim() || 'Untitled Manuscript';

    await db.transaction('rw', [db.documents, db.assets, db.autosaveBackups, db.docxPackages, db.preservationStores], async () => {
      // An image node whose bytes are neither in this import nor already stored would show a blank figure forever.
      if (needExisting.length) {
        const have = new Set((await db.assets.where(':id').anyOf(needExisting).primaryKeys()) as string[]);
        const missing = needExisting.filter(id => !have.has(id));
        if (missing.length) throw new Error(`The imported document refers to ${missing.length} image(s) whose bytes are missing, so it was not imported.`);
      }
      const prev = await db.documents.get('current');
      if (prev) {
        const unreadable = rowToDoc(prev) === null;
        const pkg = await db.docxPackages.get('current');
        const preservation = await db.preservationStores.get('current');
        await db.autosaveBackups.add({
          documentId: 'current',
          savedAt: Date.now(),
          row: prev,
          // Unreadable: kept for forensics like any quarantined row (never a recovery candidate). Readable: pinned, so that ten
          // later autosaves cannot push it out of the ring.
          ...(unreadable ? { quarantined: true as const } : { pinned: true as const }),
          replacedByImport: { ...(pkg ? { package: pkg } : {}), ...(preservation ? { preservation } : {}) },
        });
        const all = await db.autosaveBackups.orderBy('seq').toArray();
        const ring = all.filter(b => !b.quarantined && !b.pinned);
        if (ring.length > maxBackups) await db.autosaveBackups.bulkDelete(ring.slice(0, ring.length - maxBackups).map(b => b.seq!));
        const imports = all.filter(b => b.replacedByImport && b.pinned);
        if (imports.length > maxImportBackups) await db.autosaveBackups.bulkDelete(imports.slice(0, imports.length - maxImportBackups).map(b => b.seq!));
      }
      if (rows.length) await db.assets.bulkPut(rows); // idempotent (content-addressed)
      const now = Date.now();
      await db.documents.put({
        id: 'current',
        title,
        docJson: result.doc,
        format: result.format,
        comments: [],
        schemaVersion: 3,
        saveState: 'Saved',
        citationRegistry: {},
        citationCounter: 0,
        figureRegistry: {},
        figureCounter: 0,
        updatedAt: now,
        // How the author works (not what the document says) carries over; the template belongs to the replaced document.
        mode: prev?.mode ?? 'manuscript',
        grantInstructions: prev?.grantInstructions ?? '',
      });
      await db.docxPackages.put({ documentId: 'current', original: result.original, fileName: result.fileName ?? title, importedAt: now });
      await db.preservationStores.put({ documentId: 'current', store: result.preservation, updatedAt: now });
    });
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

    importDocx(result, decisions) {
      const run = queue.then(() => doImport(result, decisions));
      queue = run.catch(() => undefined);
      return run;
    },

    getPackage: () => db.docxPackages.get('current'),
    async savePackage(pkg) { await db.docxPackages.put(pkg); },

    async getPreservation() {
      return (await db.preservationStores.get('current'))?.store;
    },
    savePreservation(store) {
      // Queued behind in-flight saves so a prune never interleaves with this write.
      const run = queue.then(() => db.preservationStores.put({ documentId: 'current', store, updatedAt: Date.now() }));
      queue = run.catch(() => undefined);
      return run.then(() => undefined);
    },

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
