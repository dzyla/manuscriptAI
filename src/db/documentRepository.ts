import type { JSONContent } from '@tiptap/core';
import type { ManuscriptDb } from './manuscriptDb';
import type { AssetRow, BackupRow, CommentThread, DocFormat, DocumentMode, DocumentRow, DocxPackageRow, ImportReportRow, PreservationRow } from '../types';
import type { ImportResult } from '../docx/read';
import { prepareAssets, hydrateAssets, collectAssetIds, liveAssetIds, type AssetUrlResolver } from './assetStore';
import { stableStringify } from '../docx/preserve/hash';
import { collectFragmentIds, pruneFragments } from '../docx/preserve/refs';
import type { PreservationStore } from '../docx/preserve/types';
import { createFormat } from '../services/formatPresets';
import { isBlankDoc } from './placeholder';

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
  /**
   * The .docx import this document is the editable form of (see `DocumentRow.importId`). A save carries it forward; a save without it
   * (the document was replaced by New Manuscript, a workspace file, a template or a text import) detaches the document from its
   * package: the package and preservation map are removed from `current` and kept with the backup of the document they belonged to.
   */
  importId?: string;
  /**
   * Preserved pieces that were copied since the last save (the editor gave each copy a fresh fragment id): the fragment stored under
   * `fromId` is also stored under `toId`, in the same transaction as the document that refers to it. Without this a pasted equation,
   * footnote marker, field, comment anchor or lifted figure would refer to XML that does not exist and be dropped on export.
   */
  fragmentClones?: Array<{ fromId: string; toId: string }>;
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
   * (its package and preservation map are kept with it, in `importBackupParts`), unless it was empty or the untouched placeholder.
   * The new document, package and preservation map share a fresh `importId`, which is returned.
   *
   * An explicit user action, so it does not refuse when the current row is unreadable: that row is quarantined instead. Serialised
   * with saves (a save queued earlier completes first; one queued later runs after and so overwrites the import: the caller must
   * stop autosaving while an import is in flight, see `useDocumentStore.importDocx`).
   *
   * `result.doc` is stored as given: apply the accepted headings (`applyHeadings`) BEFORE calling.
   */
  importDocx(result: ImportResult, decisions: { title: string; acceptedHeadingIndexes?: number[] }): Promise<{ importId: string }>;
  /**
   * The report the open document was imported with (what it kept but does not show: tracked changes, comments, footnote text, headers),
   * or undefined when the open document is not an import. Only returned when it belongs to the open document's import.
   */
  getImportReport(): Promise<ImportReportRow | undefined>;
  /**
   * Undo the newest import: make the document it replaced (with its package and preservation map) the current one again, in one
   * transaction. The import being undone is itself kept as a backup of the same kind, so calling this again restores it (a swap, not
   * a loss). Rejects when there is nothing to restore.
   */
  revertImport(): Promise<void>;
  /** What `revertImport` would restore right now (its title and when it was backed up), or null. Lets the interface name it. */
  peekRevert(): Promise<{ title: string; savedAt: number } | null>;
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
  /** How many replaced-by-import backups are kept (each holds the replaced document's whole package). Default 5. */
  maxImportBackups?: number;
  /** Asset ids that must survive GC because the session can still reference them (default: object-URL cache). */
  liveAssetIds?: () => Iterable<string>;
}

function newImportId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Row identity for no-op detection: everything except bookkeeping fields. */
function rowFingerprint(row: DocumentRow): string {
  const { updatedAt: _u, saveState: _s, ...rest } = row;
  return stableStringify(rest);
}

export function createDexieRepository(db: ManuscriptDb, deps: RepositoryDeps): DocumentRepository {
  const maxBackups = deps.maxBackups ?? 10;
  const maxImportBackups = deps.maxImportBackups ?? 5;
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
        ...(row.importId ? { importId: row.importId } : {}),
      },
    };
  }

  /** Remove backups together with the package and preservation map kept for them. */
  async function deleteBackups(seqs: number[]): Promise<void> {
    if (!seqs.length) return;
    await db.autosaveBackups.bulkDelete(seqs);
    await db.importBackupParts.bulkDelete(seqs);
  }

  /** A document with nothing in it that is worth a backup slot: never edited, or still the placeholder. Never true for an imported document. */
  function isTrivialRow(row: DocumentRow): boolean {
    if (row.importId || row.comments?.length) return false;
    const converted = rowToDoc(row);
    if (!converted) return false; // unreadable is never "nothing"
    return isBlankDoc(converted.doc.docJson);
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
      ...(doc.importId ? { importId: doc.importId } : {}),
    };
    const fingerprint = rowFingerprint(row);
    const live = new Set(deps.liveAssetIds ? deps.liveAssetIds() : liveAssetIds());
    let written = true;
    await db.transaction('rw', [db.documents, db.assets, db.autosaveBackups, db.preservationStores, db.docxPackages, db.importBackupParts, db.importReports], async () => {
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
      // The document is leaving its import (New Manuscript, a workspace file, a template, a text import): its package and preservation
      // map are not this document's any more. They go with the backup of the document they belonged to, not into the new one.
      const detaching = !!prev?.importId && prev.importId !== row.importId;
      if (prev) {
        const seq = (await db.autosaveBackups.add({ documentId: 'current', savedAt: Date.now(), row: prev, ...(pin ? { pinned: true as const } : {}) })) as number;
        if (detaching) {
          const pkg = await db.docxPackages.get('current');
          const preservation = await db.preservationStores.get('current');
          const importReport = await db.importReports.get('current');
          if (pkg || preservation || importReport) {
            await db.importBackupParts.put({ seq, ...(pkg ? { package: pkg } : {}), ...(preservation ? { preservation } : {}), ...(importReport ? { importReport } : {}) });
          }
        }
      }
      if (detaching) {
        await db.docxPackages.delete('current');
        await db.preservationStores.delete('current');
        await db.importReports.delete('current');
      }
      // Quarantined (unreadable) and pinned (pre-migration) rows are exempt from the ring.
      const all = (await db.autosaveBackups.orderBy('seq').toArray()).filter(b => !b.quarantined && !b.pinned);
      const excess = all.length - maxBackups;
      if (excess > 0) await deleteBackups(all.slice(0, excess).map(b => b.seq!));
      await db.documents.put(row);

      if (doc.fragmentClones?.length) {
        const p = await db.preservationStores.get('current');
        if (p) {
          const fragments = { ...p.store.fragments };
          let changed = false;
          for (const { fromId, toId } of doc.fragmentClones) {
            const f = fragments[fromId];
            if (!f || fragments[toId]) continue; // nothing stored for the original (not an imported piece), or already cloned
            fragments[toId] = { ...f, relIds: [...f.relIds], nsDecls: { ...f.nsDecls }, ...(f.lifted ? { lifted: f.lifted.map(l => ({ ...l })) } : {}) };
            changed = true;
          }
          if (changed) await db.preservationStores.put({ ...p, store: { ...p.store, fragments }, updatedAt: Date.now() });
        }
      }

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

  interface Replacement {
    row: DocumentRow;
    pkg?: DocxPackageRow;
    preservation?: PreservationRow;
    importReport?: ImportReportRow;
    assets: AssetRow[];
    /** Asset ids the new document uses that are not in `assets`: they must already be stored. */
    needExisting: string[];
  }

  /**
   * Make `r` the current document, inside a transaction the caller opened: back up the document it replaces (with its package and
   * preservation map), then write the assets, the row and the package. The caller opens the transaction over the tables named in
   * `REPLACE_TABLES`.
   */
  async function replaceCurrent(r: Replacement): Promise<void> {
    // An image node whose bytes are neither in this import nor already stored would show a blank figure forever.
    if (r.needExisting.length) {
      const have = new Set((await db.assets.where(':id').anyOf(r.needExisting).primaryKeys()) as string[]);
      const missing = r.needExisting.filter(id => !have.has(id));
      if (missing.length) throw new Error(`The document refers to ${missing.length} image(s) whose bytes are missing, so it was not imported.`);
    }
    const prev = await db.documents.get('current');
    // An empty or placeholder document is not worth a slot (four imports over fresh installs would otherwise push real work out).
    if (prev && !isTrivialRow(prev)) {
      const unreadable = rowToDoc(prev) === null;
      const pkg = await db.docxPackages.get('current');
      const preservation = await db.preservationStores.get('current');
      const importReport = await db.importReports.get('current');
      const seq = (await db.autosaveBackups.add({
        documentId: 'current',
        savedAt: Date.now(),
        row: prev,
        // Unreadable: kept for forensics like any quarantined row (never a recovery candidate). Readable: pinned, so that ten
        // later autosaves cannot push it out of the ring.
        ...(unreadable ? { quarantined: true as const } : { pinned: true as const }),
        replacedByImport: true as const,
      })) as number;
      if (pkg || preservation || importReport) {
        await db.importBackupParts.put({ seq, ...(pkg ? { package: pkg } : {}), ...(preservation ? { preservation } : {}), ...(importReport ? { importReport } : {}) });
      }
      const all = await db.autosaveBackups.orderBy('seq').toArray();
      const ring = all.filter(b => !b.quarantined && !b.pinned);
      if (ring.length > maxBackups) await deleteBackups(ring.slice(0, ring.length - maxBackups).map(b => b.seq!));
      const imports = all.filter(b => b.replacedByImport && b.pinned);
      if (imports.length > maxImportBackups) await deleteBackups(imports.slice(0, imports.length - maxImportBackups).map(b => b.seq!));
    }
    if (r.assets.length) await db.assets.bulkPut(r.assets); // idempotent (content-addressed)
    await db.documents.put(r.row);
    if (r.pkg) await db.docxPackages.put(r.pkg);
    else await db.docxPackages.delete('current');
    if (r.preservation) await db.preservationStores.put(r.preservation);
    else await db.preservationStores.delete('current');
    if (r.importReport) await db.importReports.put(r.importReport);
    else await db.importReports.delete('current');
  }
  const REPLACE_TABLES = [db.documents, db.assets, db.autosaveBackups, db.docxPackages, db.preservationStores, db.importBackupParts, db.importReports];

  async function doImport(result: ImportResult, decisions: { title: string; acceptedHeadingIndexes?: number[] }): Promise<{ importId: string }> {
    if (!deps.isValidDoc(result.doc)) {
      // Stored, it would load back as an "unreadable" document. Refuse before anything is written.
      throw new Error('The imported document is not valid for this editor, so it was not imported.');
    }
    const referenced = collectAssetIds(result.doc);
    const drafts = new Map(result.assets.map(a => [a.id, a]));
    // Only the images the document uses are stored: the garbage collector would remove any other, and the document row names the
    // ones it needs, so a figure can never be left without its bytes by a later save.
    const assets: AssetRow[] = [...referenced]
      .filter(id => drafts.has(id))
      .map(id => {
        const a = drafts.get(id)!;
        return { id: a.id, sha256: a.sha256, mime: a.mime, size: a.data.byteLength, data: a.data, createdAt: Date.now() };
      });
    const title = decisions.title.trim() || 'Untitled Manuscript';
    const importId = newImportId();
    const now = Date.now();
    await db.transaction('rw', REPLACE_TABLES, async () => {
      const prev = await db.documents.get('current');
      await replaceCurrent({
        row: {
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
          importId,
        },
        pkg: { documentId: 'current', original: result.original, fileName: result.fileName ?? title, importedAt: now, importId },
        preservation: { documentId: 'current', store: result.preservation, updatedAt: now, importId },
        importReport: {
          documentId: 'current', importId, ...(result.fileName ? { fileName: result.fileName } : {}),
          report: result.report, headingCandidates: result.headingCandidates,
          acceptedHeadingIndexes: decisions.acceptedHeadingIndexes ?? [], importedAt: now,
        },
        assets,
        needExisting: [...referenced].filter(id => !drafts.has(id)),
      });
    });
    return { importId };
  }

  /**
   * The newest backup an import took of the document it replaced and that can be opened again. `replacedByImport` is what keeps a
   * pinned legacy-migration backup (also pinned, but not an import's) from being chosen; a readable-row check is kept as a guard
   * (pinned import backups are always readable, so the two overlap).
   */
  function pickRevertTarget(backupsOldestFirst: BackupRow[]): BackupRow | undefined {
    return [...backupsOldestFirst].reverse().find(b => b.replacedByImport && b.pinned && rowToDoc(b.row));
  }

  async function doRevert(): Promise<void> {
    await db.transaction('rw', REPLACE_TABLES, async () => {
      const target = pickRevertTarget(await db.autosaveBackups.orderBy('seq').toArray());
      if (!target) throw new Error('There is no replaced document to restore.');
      const parts = await db.importBackupParts.get(target.seq!);
      await replaceCurrent({
        row: { ...target.row, saveState: 'Saved', updatedAt: Date.now() },
        ...(parts?.package ? { pkg: parts.package } : {}),
        ...(parts?.preservation ? { preservation: parts.preservation } : {}),
        ...(parts?.importReport ? { importReport: parts.importReport } : {}),
        assets: [],
        needExisting: [...collectAssetIds(target.row.docJson)],
      });
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

    revertImport() {
      const run = queue.then(() => doRevert());
      queue = run.catch(() => undefined);
      return run;
    },

    async getImportReport() {
      const [row, report] = await Promise.all([db.documents.get('current'), db.importReports.get('current')]);
      return row?.importId && report?.importId === row.importId ? report : undefined;
    },

    async peekRevert() {
      const target = pickRevertTarget(await db.autosaveBackups.orderBy('seq').toArray());
      return target ? { title: target.row.title, savedAt: target.savedAt } : null;
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
