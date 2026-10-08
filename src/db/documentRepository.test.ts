// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';
import { createDexieRepository, type LoadedDocument, type DocumentRepository } from './documentRepository';
import { htmlToDoc, isValidDoc } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';
import { IMAGE_NODE } from './assetStore';
import { emptyPreservationStore } from '../docx/preserve/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { readDocx, type ImportResult } from '../docx/read';
import { applyHeadings } from '../docx/read/headings';
import { collectAssetIds } from './assetStore';
import { collectFragmentIds } from '../docx/preserve/refs';
import { planLiftedDrawings } from '../docx/preserve/lifted';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
let db: ManuscriptDb;
let repo: DocumentRepository;
let name: string;
const resolver = { urlFor: (r: { id: string }) => `url:${r.id}` };

const baseDoc = (text: string): LoadedDocument => ({
  title: 'T', saveState: 'Draft',
  docJson: htmlToDoc(`<p>${text}</p>`), format: createFormat('nih'), comments: [],
  citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0,
  mode: 'grant', grantInstructions: '', grantTemplateId: null,
});

beforeEach(async () => {
  name = 't-repo-' + Math.random().toString(36).slice(2);
  db = new ManuscriptDb(name);
  repo = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver });
});
afterEach(async () => { db.close(); await Dexie.delete(name); });

describe('DocumentRepository', () => {
  it('fresh install: no document', async () => {
    expect(await repo.load()).toEqual({ doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false });
  });

  it('save then load round-trips and never persists HTML', async () => {
    await repo.save(baseDoc('hello'));
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(row?.schemaVersion).toBe(3);
    const { doc } = await repo.load();
    expect(JSON.stringify(doc?.docJson)).toContain('hello');
    expect(doc?.format.preset).toBe('nih');
    expect(doc?.mode).toBe('grant');
  });

  it('migrates a legacy HTML row once and backs up the original', async () => {
    await db.documents.put({ id: 'current', title: 'Legacy', content: `<p>old <strong>text</strong></p><img src="${PNG}">`, saveState: 'Saved', citationRegistry: { s1: 1 }, citationCounter: 1, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    const r = await repo.load();
    expect(r.migrated).toBe(true);
    expect(JSON.stringify(r.doc?.docJson)).toContain('old');
    expect(r.doc?.format.preset).toBe('nih');
    expect(r.doc?.citationRegistry).toEqual({ s1: 1 });
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(await db.assets.count()).toBe(1);
    const backups = await repo.listBackups();
    expect(backups[0].row.content).toContain('old');
    // image hydrated to a resolver URL
    const imgNode = r.doc!.docJson.content!.flatMap(n => [n, ...(n.content ?? [])]).find(n => n.type === IMAGE_NODE);
    expect(imgNode?.attrs?.src).toMatch(/^url:a_/);
    expect((await repo.load()).migrated).toBe(false);
  });

  it('keeps at most maxBackups backups', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 3 });
    for (let i = 0; i < 6; i++) await small.save(baseDoc('v' + i));
    const b = await small.listBackups();
    expect(b).toHaveLength(3);
    expect(JSON.stringify(b[0].row.docJson)).toContain('v4');
  });

  it('overlapping saves complete in call order (last write wins)', async () => {
    const p1 = repo.save(baseDoc('first'));
    const p2 = repo.save(baseDoc('second'));
    await Promise.all([p1, p2]);
    const { doc } = await repo.load();
    expect(JSON.stringify(doc?.docJson)).toContain('second');
  });

  it('a failing transaction leaves the previous document intact', async () => {
    await repo.save(baseDoc('good'));
    const unhook = db.assets.hook('creating', () => { throw new Error('disk full'); });
    const withImage = baseDoc('bad');
    withImage.docJson = htmlToDoc(`<p>bad</p><img src="${PNG}">`);
    await expect(repo.save(withImage)).rejects.toThrow(/disk full/);
    expect(await repo.listBackups()).toHaveLength(0); // rolled back atomically: no backup of 'good' either
    db.assets.hook('creating').unsubscribe(unhook as any);
    const { doc } = await repo.load();
    expect(JSON.stringify(doc?.docJson)).toContain('good');
    // queue still usable after a failure
    await repo.save(baseDoc('after'));
    expect(JSON.stringify((await repo.load()).doc?.docJson)).toContain('after');
  });

  it('recovers from a corrupt docJson using the newest valid backup', async () => {
    await repo.save(baseDoc('v1'));
    await repo.save(baseDoc('v2'));
    const row = await db.documents.get('current');
    await db.documents.put({ ...row!, docJson: { type: 'doc', content: [{ type: 'hologram' }] } as any });
    const r = await repo.load();
    expect(r.recoveredFromBackup).toBe(true);
    expect(r.unreadableRowPresent).toBe(true);
    expect(JSON.stringify(r.doc?.docJson)).toContain('v1');
    const q = (await repo.listBackups()).filter(b => b.quarantined);
    expect(q).toHaveLength(1);
    expect(JSON.stringify(q[0].row.docJson)).toContain('hologram');
  });

  const corruptCurrent = () => db.documents.put({ id: 'current', title: 'Future', docJson: { type: 'doc', content: [{ type: 'hologram' }] } as any, saveState: 'Saved', updatedAt: 42, schemaVersion: 99 } as any);

  it('unreadable current row with no valid backup: quarantined, survives the ring', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 3 });
    await corruptCurrent();
    const r = await small.load();
    expect(r).toEqual({ doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: true, quarantined: true });
    expect((await small.listBackups()).filter(b => b.quarantined)).toHaveLength(1);
    for (let i = 0; i < 12; i++) await small.save(baseDoc('s' + i));
    const all = await small.listBackups();
    expect(all.filter(b => b.quarantined)).toHaveLength(1);
    expect(JSON.stringify(all.find(b => b.quarantined)!.row.docJson)).toContain('hologram');
    expect(all.filter(b => !b.quarantined)).toHaveLength(3);
  });

  it('loading an unreadable row repeatedly quarantines it only once', async () => {
    await corruptCurrent();
    await repo.load();
    await repo.load();
    expect((await repo.listBackups()).filter(b => b.quarantined)).toHaveLength(1);
  });

  it('quarantined rows are never restorable', async () => {
    await corruptCurrent();
    await repo.load();
    const q = (await repo.listBackups()).find(b => b.quarantined)!;
    await expect(repo.restoreBackup(q.seq!)).rejects.toThrow();
  });

  it('garbage-collects assets no longer referenced by the doc or any backup', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 1 });
    const withImage = baseDoc('img');
    withImage.docJson = htmlToDoc(`<p>img</p><img src="${PNG}">`);
    await small.save(withImage);
    expect(await db.assets.count()).toBe(1);
    await small.save(baseDoc('no image 1')); // backup still references the image
    expect(await db.assets.count()).toBe(1);
    await small.save(baseDoc('no image 2')); // image-bearing row fell out of the ring
    expect(await db.assets.count()).toBe(0);
  });

  it('prunes fragments no row or remaining backup references', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 1 });
    const store = emptyPreservationStore();
    store.fragments = { f1: { xml: '<a/>', relIds: [], nsDecls: {} }, f2: { xml: '<b/>', relIds: [], nsDecls: {} } };
    await small.savePreservation(store);
    const d = baseDoc('chip');
    d.docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] }] };
    await small.save(d);
    // f2 was never referenced by the saved row or any backup: gone. f1 is live.
    expect(Object.keys((await small.getPreservation())!.fragments)).toEqual(['f1']);
    await small.save(baseDoc('no chip 1')); // backup still references f1
    expect(Object.keys((await small.getPreservation())!.fragments)).toEqual(['f1']);
    await small.save(baseDoc('no chip 2')); // chip-bearing row fell out of the 1-slot ring
    expect(Object.keys((await small.getPreservation())!.fragments)).toEqual([]);
  });

  it('a corrupt backup row never blocks saving or triggers garbage collection', async () => {
    const withImage = baseDoc('img');
    withImage.docJson = htmlToDoc(`<p>img</p><img src="${PNG}">`);
    await repo.save(withImage);
    await db.autosaveBackups.add({ documentId: 'current', savedAt: 1, row: { id: 'current', title: 'x', saveState: 'Saved', updatedAt: 1, docJson: { type: 'doc', content: 'garbage' } } as any });
    await repo.save(baseDoc('next'));
    expect(JSON.stringify((await repo.load()).doc?.docJson)).toContain('next');
    expect(await db.assets.count()).toBe(1); // GC skipped because a backup could not be scanned
  });

  it('a failed migration save still opens the document and leaves the legacy row intact', async () => {
    await db.documents.put({ id: 'current', title: 'Legacy', content: `<p>old</p><img src="${PNG}">`, saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    const failer = () => { throw new Error('disk full'); };
    db.assets.hook('creating', failer);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await repo.load();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    db.assets.hook('creating').unsubscribe(failer);
    expect(r.doc).not.toBeNull();
    expect(r.migrated).toBe(false);
    expect((await db.documents.get('current'))?.content).toContain('old');
    expect((await repo.load()).migrated).toBe(true); // retried successfully
  });

  const findImage = (d: LoadedDocument | null | undefined) =>
    d?.docJson.content!.flatMap(n => [n, ...(n.content ?? [])]).find(n => n.type === IMAGE_NODE);
  const withImg = (text: string, src = PNG): LoadedDocument => ({ ...baseDoc(text), docJson: htmlToDoc(`<p>${text}</p><img src="${src}">`) });

  describe('C2: live editor references survive asset GC', () => {
    // A resolver whose URLs stay fetchable for the session, like real object URLs.
    const live = new Map<string, { mime: string; data: ArrayBuffer }>();
    const liveResolver = { urlFor: (r: { id: string; mime: string; data: ArrayBuffer }) => { live.set(`blob:live/${r.id}`, { mime: r.mime, data: r.data }); return `blob:live/${r.id}`; } };
    const liveFetch = async (url: string) => { const b = live.get(url); if (!b) throw new Error('revoked'); return b; };

    it('undo/paste of an image after its asset row was collected re-ingests the bytes', async () => {
      const r = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver: liveResolver, fetchBytes: liveFetch, liveAssetIds: () => [] });
      await r.save(withImg('a'));
      const loaded = (await r.load()).doc!;
      expect(findImage(loaded)?.attrs?.src).toMatch(/^blob:live\//);
      for (let i = 0; i < 11; i++) await r.save(baseDoc('a' + i)); // image deleted, ring rotates
      expect(await db.assets.count()).toBe(0);
      await r.save(loaded); // undo brings back the node with its session blob: URL
      const img = findImage((await r.load()).doc);
      expect(img?.attrs?.src).toMatch(/^blob:live\//);
      expect(await db.assets.count()).toBe(1);
    });

    it('never collects assets that are live in this session', async () => {
      let liveIds: string[] = [];
      const r = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, liveAssetIds: () => liveIds });
      await r.save(withImg('a'));
      liveIds = [...(await db.assets.toCollection().primaryKeys()) as string[]];
      for (let i = 0; i < 11; i++) await r.save(baseDoc('a' + i));
      expect(await db.assets.count()).toBe(1);
      liveIds = [];
      await r.save(baseDoc('final'));
      expect(await db.assets.count()).toBe(0);
    });
  });

  describe('C3: one bad image never blocks saving', () => {
    it('saves documents with malformed data URLs and reports warnings', async () => {
      const res1 = await repo.save(withImg('x', 'data:image/png;base64,@@@notbase64'));
      expect(res1.warnings).toHaveLength(1);
      await repo.save(withImg('y', 'data:image/svg+xml;utf8,<svg>100%</svg>'));
      expect(JSON.stringify((await repo.load()).doc?.docJson)).toContain('y');
    });

    it('a legacy row containing a bad image migrates and later saves succeed', async () => {
      await db.documents.put({ id: 'current', title: 'L', content: '<p>legacy</p><img src="data:image/png;base64,@@@">', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
      const r = await repo.load();
      expect(r.migrated).toBe(true);
      expect((await db.documents.get('current'))?.content).toBeUndefined();
      await repo.save({ ...r.doc!, title: 'edited' });
      expect((await db.documents.get('current'))?.title).toBe('edited');
    });
  });

  describe('C4: migration returns the document it migrated', () => {
    const legacy = () => db.documents.put({ id: 'current', title: 'Legacy', content: `<p>legacy body</p><img src="${PNG}">`, saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });

    it('a save that lands between migration and return does not replace the migrated document', async () => {
      await legacy();
      // Simulate another save landing right after the migration save, before load() returns.
      const realGet = db.documents.get.bind(db.documents);
      let outside = 0;
      const spy = vi.spyOn(db.documents, 'get').mockImplementation(((key: any) => {
        if (!Dexie.currentTransaction && ++outside === 2) {
          return repo.save(baseDoc('intruder')).then(() => realGet(key));
        }
        return realGet(key);
      }) as any);
      const r = await repo.load();
      spy.mockRestore();
      expect(r.migrated).toBe(true);
      expect(JSON.stringify(r.doc?.docJson)).toContain('legacy body');
      expect(findImage(r.doc)?.attrs?.src).toMatch(/^url:a_/);
    });

    it('a save queued before load resolves does not change what load returns', async () => {
      await legacy();
      const p = repo.load();
      const s = repo.save(baseDoc('early'));
      const r = await p;
      await s;
      expect(JSON.stringify(r.doc?.docJson)).toContain('legacy body');
    });
  });

  describe('I1: backup ring hygiene', () => {
    it('identical saves are no-ops: no backup churn, no rewrite', async () => {
      await repo.save(baseDoc('same'));
      await repo.save(baseDoc('same'));
      const before = await repo.listBackups();
      const rowBefore = await db.documents.get('current');
      for (let i = 0; i < 20; i++) await repo.save({ ...baseDoc('same'), saveState: i % 2 ? 'Saved' : 'Auto-saved' });
      expect(await repo.listBackups()).toEqual(before);
      expect((await db.documents.get('current'))?.updatedAt).toBe(rowBefore?.updatedAt);
    });

    it('an identical save with a changed saveState updates only that field (no backup, same updatedAt)', async () => {
      await repo.save({ ...baseDoc('same'), saveState: 'Draft' });
      await repo.save({ ...baseDoc('same'), saveState: 'Draft' });
      const before = await db.documents.get('current');
      const backupsBefore = await repo.listBackups();
      await repo.save({ ...baseDoc('same'), saveState: 'Auto-saved' });
      const after = await db.documents.get('current');
      expect(after?.saveState).toBe('Auto-saved');
      expect(after).toEqual({ ...before, saveState: 'Auto-saved' });
      expect(await repo.listBackups()).toEqual(backupsBefore);
    });

    it('a document with an image is not rewritten when unchanged', async () => {
      const r = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver: { urlFor: a => `blob:session/${a.id}` } });
      await r.save(withImg('pic'));
      const loaded = (await r.load()).doc!; // hydrated: src is a session blob: URL
      const n = (await r.listBackups()).length;
      await r.save(loaded);
      await r.save(loaded);
      expect(await r.listBackups()).toHaveLength(n);
    });

    it('the pre-migration legacy row is pinned: never trimmed, still recoverable', async () => {
      const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 3 });
      await db.documents.put({ id: 'current', title: 'Legacy', content: '<p>original legacy</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
      await small.load();
      for (let i = 0; i < 20; i++) await small.save(baseDoc('edit ' + i));
      const all = await small.listBackups();
      const pinned = all.filter(b => b.pinned);
      expect(pinned).toHaveLength(1);
      expect(pinned[0].row.content).toContain('original legacy');
      expect(all.filter(b => !b.pinned && !b.quarantined)).toHaveLength(3);
      const restored = await small.restoreBackup(pinned[0].seq!);
      expect(JSON.stringify(restored.docJson)).toContain('original legacy');
    });
  });

  it('I1: concurrent loads of a legacy row (React StrictMode double init) pin only the legacy row', async () => {
    await db.documents.put({ id: 'current', title: 'Legacy', content: '<p>twice</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    const [a, b] = await Promise.all([repo.load(), repo.load()]);
    expect(JSON.stringify(a.doc?.docJson)).toContain('twice');
    expect(JSON.stringify(b.doc?.docJson)).toContain('twice');
    const backups = await repo.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].pinned).toBe(true);
    expect(backups[0].row.content).toContain('twice');
  });

  describe('I2: quarantine honesty', () => {
    it('reports quarantined: false when the protected copy could not be written', async () => {
      await corruptCurrent();
      const failer = () => { throw new Error('quota'); };
      db.autosaveBackups.hook('creating', failer);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await repo.load();
      errSpy.mockRestore();
      db.autosaveBackups.hook('creating').unsubscribe(failer);
      expect(r.unreadableRowPresent).toBe(true);
      expect(r.quarantined).toBe(false);
    });

    it('reports quarantined: true on repeat loads (copy already exists)', async () => {
      await corruptCurrent();
      await repo.load();
      expect((await repo.load()).quarantined).toBe(true);
    });
  });
});

describe('preservation storage', () => {
  it('never rewrites the original package bytes on save', async () => {
    const big = new ArrayBuffer(1024);
    await repo.savePackage({ documentId: 'current', original: big, fileName: 'x.docx', importedAt: 1 });
    await repo.savePreservation({ ...emptyPreservationStore(), fragments: { f1: { xml: '<a/>', relIds: [], nsDecls: {} } } });
    let packageWrites = 0;
    const hook = () => { packageWrites++; };
    db.docxPackages.hook('updating', hook);
    const d = baseDoc('chip');
    d.docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] }] };
    await repo.save(d);
    await repo.save({ ...d, title: 'again' });
    db.docxPackages.hook('updating').unsubscribe(hook);
    expect(packageWrites).toBe(0);
    expect((await repo.getPackage())?.original.byteLength).toBe(1024);
  });

  it('keeps a fragment whose atom was deleted until the backup ring forgets it', async () => {
    await repo.savePreservation({ ...emptyPreservationStore(), fragments: { f1: { xml: '<a/>', relIds: [], nsDecls: {} } } });
    const withChip = baseDoc('chip');
    withChip.docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] }] };
    await repo.save(withChip);
    await repo.save(baseDoc('deleted the equation'));
    expect((await repo.getPreservation())?.fragments.f1).toBeDefined(); // still recoverable by undo
  });

  it('does not write the preservation row when nothing needs pruning', async () => {
    await repo.savePreservation({ ...emptyPreservationStore(), fragments: { f1: { xml: '<a/>', relIds: [], nsDecls: {} } } });
    const d = baseDoc('chip');
    d.docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] }] };
    await repo.save(d);
    let writes = 0;
    const hook = () => { writes++; };
    db.preservationStores.hook('updating', hook);
    await repo.save({ ...d, title: 'again' });
    await repo.save({ ...d, title: 'and again' });
    db.preservationStores.hook('updating').unsubscribe(hook);
    expect(writes).toBe(0);
  });
});

describe('Dexie v4 upgrade', () => {
  it('moves an existing preservation field from docxPackages into preservationStores without losing data', async () => {
    const legacyName = 't-mig-' + Math.random().toString(36).slice(2);
    const old = new Dexie(legacyName);
    old.version(3).stores({
      documents: 'id', sources: 'id, order', chatHistory: 'id, order', suggestions: 'id',
      historyItems: 'id, timestamp', versionSnapshots: 'id, timestamp', grantTemplates: 'id, updatedAt',
      assets: 'id, sha256', docxPackages: 'documentId', autosaveBackups: '++seq, documentId, savedAt',
    });
    const store = { ...emptyPreservationStore(), fragments: { f1: { xml: '<m:oMath/>', relIds: ['rId5'], nsDecls: { m: 'urn:m' } } } };
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    await old.table('docxPackages').put({ documentId: 'current', original: bytes, fileName: 'thesis.docx', preservation: store, importedAt: 42 });
    await old.table('documents').put({ id: 'current', title: 'keep me', content: '<p>x</p>', saveState: 'Saved', updatedAt: 1 });
    old.close();

    const upgraded = new ManuscriptDb(legacyName);
    try {
      const pres = await upgraded.preservationStores.get('current');
      expect(pres?.store).toEqual(store);
      const pkg = (await upgraded.docxPackages.get('current')) as unknown as Record<string, unknown>;
      expect(pkg.fileName).toBe('thesis.docx');
      expect(pkg.importedAt).toBe(42);
      expect(new Uint8Array(pkg.original as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect('preservation' in pkg).toBe(false);
      expect((await upgraded.documents.get('current'))?.title).toBe('keep me');
    } finally {
      upgraded.close();
      await Dexie.delete(legacyName);
    }
  });

  it('upgrades a v3 database that has no package at all', async () => {
    const legacyName = 't-mig-' + Math.random().toString(36).slice(2);
    const old = new Dexie(legacyName);
    old.version(3).stores({
      documents: 'id', sources: 'id, order', chatHistory: 'id, order', suggestions: 'id',
      historyItems: 'id, timestamp', versionSnapshots: 'id, timestamp', grantTemplates: 'id, updatedAt',
      assets: 'id, sha256', docxPackages: 'documentId', autosaveBackups: '++seq, documentId, savedAt',
    });
    await old.table('documents').put({ id: 'current', title: 'still here', content: '<p>x</p>', saveState: 'Saved', updatedAt: 1 });
    old.close();
    const upgraded = new ManuscriptDb(legacyName);
    try {
      expect(await upgraded.preservationStores.count()).toBe(0);
      expect((await upgraded.documents.get('current'))?.title).toBe('still here');
    } finally {
      upgraded.close();
      await Dexie.delete(legacyName);
    }
  });
});

// ─── importDocx: one transaction ──────────────────────────────────────────────────────────────────────────────

const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(join(process.cwd(), 'src/test/fixtures/docx', name));
  // Copied into an ArrayBuffer made by THIS environment's constructor: under jsdom, a Buffer's own buffer comes from another realm and
  // the zip reader does not recognise it.
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
};
const textOfDoc = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOfDoc).join(''));
const images = (doc: JSONContent): JSONContent[] => (doc.type === IMAGE_NODE ? [doc] : []).concat((doc.content ?? []).flatMap(images));

describe('DocumentRepository.importDocx', () => {
  let imported: ImportResult;
  let plain: ImportResult;
  beforeEach(async () => {
    imported = await readDocx(fixture('images.docx'), undefined, 'images.docx');
    plain = await readDocx(fixture('body-basics.docx'), undefined, 'body-basics.docx');
  });

  it('writes the document, its images, the package and the preservation map together, and loads back', async () => {
    expect(imported.assets.length).toBeGreaterThan(0);
    await repo.importDocx(imported, { title: 'My import' });

    const row = await db.documents.get('current');
    expect(row?.title).toBe('My import');
    expect(row?.schemaVersion).toBe(3);
    expect(row?.docJson).toEqual(imported.doc);
    expect(row?.format).toEqual(imported.format);
    expect(row?.saveState).toBe('Saved');

    const pkg = await repo.getPackage();
    expect(pkg?.fileName).toBe('images.docx');
    expect(new Uint8Array(pkg!.original)).toEqual(new Uint8Array(fixture('images.docx')));
    expect(await repo.getPreservation()).toEqual(imported.preservation);

    const need = collectAssetIds(imported.doc);
    expect(need.size).toBeGreaterThan(0);
    for (const id of need) expect(await db.assets.get(id), id).toBeDefined();

    const loaded = await repo.load();
    expect(loaded.unreadableRowPresent).toBe(false);
    expect(loaded.doc?.title).toBe('My import');
    // every picture is hydrated from its stored bytes, none is left blank
    for (const img of images(loaded.doc!.docJson).filter(i => i.attrs?.assetId)) expect(img.attrs?.src, String(img.attrs?.assetId)).toMatch(/^url:/);
  });

  it('keeps the replaced document as a backup that later autosaves cannot push out, with its package and preservation map', async () => {
    await repo.importDocx(plain, { title: 'first' });
    const first = (await repo.load()).doc!;
    await repo.save({ ...first, title: 'first, edited' }); // carries the import's id, as the store does
    await repo.importDocx(imported, { title: 'second' });

    const backups = await repo.listBackups();
    const replaced = backups.find(b => b.replacedByImport);
    expect(replaced?.pinned).toBe(true);
    expect(replaced?.row.title).toBe('first, edited');
    const parts = await db.importBackupParts.get(replaced!.seq!);
    expect(parts?.package?.fileName).toBe('body-basics.docx');
    expect(parts?.preservation?.store).toEqual(plain.preservation);
    expect(replaced!.row.importId).toBe(parts?.package?.importId);
    // the current package is the new one
    expect((await repo.getPackage())?.fileName).toBe('images.docx');

    // ten more distinct saves turn the ordinary ring over, but not the import backup
    for (let i = 0; i < 12; i++) await repo.save(baseDoc('edit ' + i));
    expect((await repo.listBackups()).some(b => b.replacedByImport && b.row.title === 'first, edited')).toBe(true);
    expect((await db.importBackupParts.get(replaced!.seq!))?.package?.fileName).toBe('body-basics.docx');
  });

  it('the package and preservation map are not read, and not part of a backup row, when the ring is scanned on every save', async () => {
    await repo.importDocx(plain, { title: 'first' });
    await repo.importDocx(imported, { title: 'second' });
    const rows = await db.autosaveBackups.toArray();
    expect(rows.length).toBeGreaterThan(0);
    for (const b of rows) {
      expect(JSON.stringify(Object.keys(b))).not.toMatch(/package|preservation|original/);
      expect(b.replacedByImport === undefined || b.replacedByImport === true).toBe(true);
    }
    let reads = 0;
    const count = () => { reads++; };
    db.importBackupParts.hook('reading', (o) => { count(); return o; });
    const loaded = (await repo.load()).doc!;
    await repo.save({ ...loaded, title: 'an ordinary autosave' });
    await repo.save({ ...loaded, title: 'another one' });
    expect(reads).toBe(0);
  });

  it('keeps only the latest few replaced-by-import backups', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxImportBackups: 2 });
    await small.save(baseDoc('original'));
    for (const t of ['a', 'b', 'c', 'd']) await small.importDocx(plain, { title: t });
    const kept = (await small.listBackups()).filter(b => b.replacedByImport).map(b => b.row.title);
    expect(kept).toEqual(['c', 'b']); // newest first; 'original' and 'a' were let go
    // and what was let go took its package and map with it (no orphan parts)
    const seqs = new Set((await small.listBackups()).map(b => b.seq));
    const parts = await db.importBackupParts.toArray();
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) expect(seqs.has(p.seq), String(p.seq)).toBe(true);
  });

  it('a failure writing the assets leaves the previous document, package, preservation map and assets exactly as they were', async () => {
    await repo.importDocx(plain, { title: 'previous' });
    const before = {
      row: await db.documents.get('current'),
      pkg: await db.docxPackages.get('current'),
      pres: await db.preservationStores.get('current'),
      assets: await db.assets.toArray(),
      backups: await db.autosaveBackups.toArray(),
    };
    const boom = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    db.assets.hook('creating', boom);
    try {
      await expect(repo.importDocx(imported, { title: 'doomed' })).rejects.toThrow();
    } finally {
      db.assets.hook('creating').unsubscribe(boom);
    }
    expect(await db.documents.get('current')).toEqual(before.row);
    expect(await db.docxPackages.get('current')).toEqual(before.pkg);
    expect(await db.preservationStores.get('current')).toEqual(before.pres);
    expect(await db.assets.toArray()).toEqual(before.assets);
    expect(await db.autosaveBackups.toArray()).toEqual(before.backups); // not even the backup of the previous row
    // nothing of the failed import is left: its images are not stored
    for (const a of imported.assets) expect(await db.assets.get(a.id)).toBeUndefined();
    // and the repository still works afterwards
    await repo.importDocx(imported, { title: 'retry' });
    expect((await repo.load()).doc?.title).toBe('retry');
  });

  it('a failure after the assets were written (the package) rolls the assets back too', async () => {
    await repo.save(baseDoc('previous'));
    const boom = () => { throw new Error('disk full'); };
    db.docxPackages.hook('creating', boom);
    try {
      await expect(repo.importDocx(imported, { title: 'doomed' })).rejects.toThrow('disk full');
    } finally {
      db.docxPackages.hook('creating').unsubscribe(boom);
    }
    expect(await db.assets.count()).toBe(0);
    expect((await db.documents.get('current'))?.title).toBe('T');
    expect(await db.autosaveBackups.count()).toBe(0);
  });

  it('refuses a document the editor could not read back, before writing anything', async () => {
    await repo.save(baseDoc('previous'));
    const bad = { ...plain, doc: { type: 'doc', content: [{ type: 'hologram' }] } as JSONContent };
    await expect(repo.importDocx(bad, { title: 'x' })).rejects.toThrow(/not valid/);
    expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('previous');
    expect(await db.docxPackages.count()).toBe(0);
  });

  it('refuses a document whose image has neither bytes in the import nor a stored asset, instead of storing a blank figure', async () => {
    await repo.save(baseDoc('previous'));
    const stripped = { ...imported, assets: [] };
    await expect(repo.importDocx(stripped, { title: 'x' })).rejects.toThrow(/missing/);
    expect(await db.docxPackages.count()).toBe(0);
    expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('previous');
  });

  it('stores only the images the document uses (an unreferenced draft would be collected and is never written)', async () => {
    const extra = { id: 'a_unused', sha256: 'f'.repeat(64), mime: 'image/png', data: new Uint8Array([1, 2, 3]).buffer };
    await repo.importDocx({ ...imported, assets: [...imported.assets, extra] }, { title: 'x' });
    expect(await db.assets.get('a_unused')).toBeUndefined();
    expect(await db.assets.count()).toBe(collectAssetIds(imported.doc).size);
  });

  it('images survive the next save and its garbage collection (a figure is never blanked by an ordinary autosave)', async () => {
    await repo.importDocx(imported, { title: 'x' });
    const loaded = (await repo.load()).doc!;
    await repo.save({ ...loaded, saveState: 'Draft', title: 'edited' });
    for (const id of collectAssetIds(imported.doc)) expect(await db.assets.get(id), id).toBeDefined();
    // the same with a repository that knows of no session URLs, and after the backup ring has turned over
    for (let i = 0; i < 12; i++) await repo.save({ ...loaded, title: 'edit ' + i });
    for (const id of collectAssetIds(imported.doc)) expect(await db.assets.get(id), id).toBeDefined();
  });

  it('is an explicit replacement: it succeeds over an unreadable row, which is quarantined rather than lost', async () => {
    await db.documents.put({
      id: 'current', title: 'Broken', saveState: 'Saved', docJson: { type: 'doc', content: [{ type: 'hologram' }] },
      citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    } as never);
    await repo.importDocx(plain, { title: 'fresh' });
    const backups = await repo.listBackups();
    expect(backups.some(b => b.quarantined && b.row.title === 'Broken')).toBe(true);
    const loaded = await repo.load();
    expect(loaded.unreadableRowPresent).toBe(false);
    expect(loaded.recoveredFromBackup).toBe(false);
    expect(loaded.doc?.title).toBe('fresh');
  });

  it('carries over how the author works (mode, funder instructions) but not the replaced document\'s template', async () => {
    await repo.save({ ...baseDoc('x'), mode: 'grant', grantInstructions: 'page limit 12', grantTemplateId: 'r01' });
    await repo.importDocx(plain, { title: 'x' });
    const row = await db.documents.get('current');
    expect(row?.mode).toBe('grant');
    expect(row?.grantInstructions).toBe('page limit 12');
    expect(row?.grantTemplateId).toBeUndefined();
    expect(row?.comments).toEqual([]);
    expect(row?.citationRegistry).toEqual({});
  });

  it('two imports started together both complete, in call order, as one document each time (the last wins; the first is the backup)', async () => {
    await repo.save(baseDoc('original'));
    const p1 = repo.importDocx(plain, { title: 'one' });
    const p2 = repo.importDocx(imported, { title: 'two' });
    await Promise.all([p1, p2]);
    expect(await db.documents.count()).toBe(1);
    expect((await repo.load()).doc?.title).toBe('two');
    expect((await repo.getPackage())?.fileName).toBe('images.docx');
    const titles = (await repo.listBackups()).filter(b => b.replacedByImport).map(b => b.row.title);
    expect(titles).toEqual(['one', 'T']); // 'one' replaced by 'two'; the original (title 'T') replaced by 'one'
  });

  it('a failed import does not poison the queue for the saves behind it', async () => {
    const bad = { ...plain, doc: { type: 'doc', content: [{ type: 'hologram' }] } as JSONContent };
    const p1 = repo.importDocx(bad, { title: 'x' }).catch(e => e);
    const p2 = repo.save(baseDoc('after'));
    expect(await p1).toBeInstanceOf(Error);
    await p2;
    expect(JSON.stringify((await repo.load()).doc?.docJson)).toContain('after');
  });

  it('applies exactly the headings it is given (the repository stores the document as received)', async () => {
    const un = await readDocx(fixture('unstyled-sections.docx'), undefined, 'u.docx');
    expect(un.headingCandidates.length).toBeGreaterThan(1);
    const some = [un.headingCandidates[0]];
    await repo.importDocx({ ...un, doc: applyHeadings(un.doc, some) }, { title: 'x' });
    const doc = (await repo.load()).doc!.docJson;
    const headings = (doc.content ?? []).filter(n => n.type === 'heading');
    expect(headings.map(textOfDoc)).toEqual([some[0].text]);
  });

  it('the document row, the package and the preservation map carry one fresh importId, and a save keeps it', async () => {
    const { importId } = await repo.importDocx(plain, { title: 'x' });
    expect(importId).toBeTruthy();
    expect((await db.documents.get('current'))?.importId).toBe(importId);
    expect((await db.docxPackages.get('current'))?.importId).toBe(importId);
    expect((await db.preservationStores.get('current'))?.importId).toBe(importId);
    const loaded = (await repo.load()).doc!;
    expect(loaded.importId).toBe(importId);
    await repo.save({ ...loaded, title: 'edited' });
    expect((await db.documents.get('current'))?.importId).toBe(importId);
    expect((await db.docxPackages.get('current'))?.fileName).toBe('body-basics.docx');
    const second = await repo.importDocx(imported, { title: 'y' });
    expect(second.importId).not.toBe(importId);
  });

  it('a save without the importId detaches the document: the package and map leave `current` and go with the backup of the document they belonged to', async () => {
    const { importId } = await repo.importDocx(plain, { title: 'imported' });
    await repo.save(baseDoc('a new manuscript')); // what New Manuscript / a workspace file / a template / a text import persist
    expect((await db.documents.get('current'))?.importId).toBeUndefined();
    expect(await db.docxPackages.get('current')).toBeUndefined();
    expect(await db.preservationStores.get('current')).toBeUndefined();
    const b = (await repo.listBackups()).find(x => x.row.importId === importId)!;
    const parts = await db.importBackupParts.get(b.seq!);
    expect(parts?.package?.importId).toBe(importId);
    expect(parts?.preservation?.store).toEqual(plain.preservation);
    // an ordinary save of a document that was never imported leaves an (unrelated) package alone
  });

  it('a document that was never imported does not touch a package it does not own', async () => {
    await repo.save(baseDoc('plain'));
    await repo.savePackage({ documentId: 'current', original: new ArrayBuffer(4), fileName: 'legacy.docx', importedAt: 1 });
    await repo.save(baseDoc('plain, edited'));
    expect((await repo.getPackage())?.fileName).toBe('legacy.docx');
  });

  it('a save already queued behind a slow asset fetch cannot overwrite an import started after it (the import waits its turn, then wins)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = createDexieRepository(db, {
      htmlToDoc, isValidDoc, resolver,
      fetchBytes: async () => { await gate; return { mime: 'image/png', data: new Uint8Array([1, 2, 3]).buffer }; },
    });
    const withBlob: LoadedDocument = {
      ...baseDoc('old document'),
      docJson: { type: 'doc', content: [{ type: IMAGE_NODE, attrs: { src: 'blob:http://x/1', assetId: null } }] } as JSONContent,
    };
    const pendingSave = slow.save(withBlob); // in flight: waiting for the fetch inside the queue
    const pendingImport = slow.importDocx(plain, { title: 'the import' });
    await new Promise(r => setTimeout(r, 30));
    expect(await db.documents.count()).toBe(0); // the import has not jumped the queue
    release();
    await Promise.all([pendingSave, pendingImport]);
    expect((await db.documents.get('current'))?.title).toBe('the import');
    expect((await slow.listBackups()).some(b => b.row.title === 'T')).toBe(true); // the save landed first and is what the import replaced
  });

  it('imports over a blank or placeholder document do not use backup slots (they would push real work out)', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxImportBackups: 2 });
    await small.save(baseDoc('real work'));
    await small.importDocx(plain, { title: 'one' }); // replaces real work: backed up
    for (const blank of ['', 'Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.']) {
      await small.save({ ...baseDoc(blank), title: 'blank' }); // detaches 'one' (an ordinary ring backup), then is blank itself
      await small.importDocx(plain, { title: 'again' });
    }
    await small.save({ ...baseDoc(''), title: 'blank' });
    await small.importDocx(plain, { title: 'once more' });
    const slots = (await small.listBackups()).filter(b => b.replacedByImport);
    expect(slots).toHaveLength(1); // exactly one slot, and it is the real work
    expect(slots[0].row.title).toBe('T');
    expect(JSON.stringify(slots[0].row.docJson)).toContain('real work');
  });

  it('text typed into the placeholder paragraph is work, not a blank document', async () => {
    const typed = 'Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.the aims of this grant are';
    await repo.save(baseDoc(typed));
    await repo.importDocx(plain, { title: 'x' });
    const kept = (await repo.listBackups()).filter(b => b.replacedByImport);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0].row.docJson)).toContain('the aims of this grant are');
  });

  it('a document with only an image, or comments, is not blank', async () => {
    const withImage: LoadedDocument = { ...baseDoc(''), docJson: htmlToDoc(`<p></p><img src="${PNG}">`) };
    await repo.save(withImage);
    await repo.importDocx(plain, { title: 'x' });
    expect((await repo.listBackups()).filter(b => b.replacedByImport)).toHaveLength(1);
    await repo.save({ ...baseDoc(''), comments: [{ id: 'c1' } as never] });
    await repo.importDocx(plain, { title: 'y' });
    expect((await repo.listBackups()).filter(b => b.replacedByImport)).toHaveLength(2);
  });

  it('trims the ordinary ring when an import adds to it, and never touches pinned or quarantined backups', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 2 });
    await small.save(baseDoc('real work'));
    const row = (await db.documents.get('current'))!;
    for (let i = 0; i < 5; i++) await db.autosaveBackups.add({ documentId: 'current', savedAt: i, row: { ...row, title: 'ring ' + i } });
    await db.autosaveBackups.add({ documentId: 'current', savedAt: 9, row: { ...row, title: 'pinned' }, pinned: true });
    await db.autosaveBackups.add({ documentId: 'current', savedAt: 9, row: { ...row, title: 'quarantined' }, quarantined: true });
    await small.importDocx(plain, { title: 'x' });
    const left = (await small.listBackups()).map(b => b.row.title).sort();
    expect(left).toEqual(['T', 'pinned', 'quarantined', 'ring 3', 'ring 4'].sort());
  });

  describe('revertImport', () => {
    it('brings back the replaced document with its own package and map, in one step, and a second revert brings the import back', async () => {
      const a = await repo.importDocx(plain, { title: 'A' });
      const aDoc = (await repo.load()).doc!;
      await repo.save({ ...aDoc, title: 'A, edited' });
      const b = await repo.importDocx(imported, { title: 'B' });
      expect((await repo.getPackage())?.importId).toBe(b.importId);

      await repo.revertImport();
      const back = (await repo.load()).doc!;
      expect(back.title).toBe('A, edited');
      expect(back.importId).toBe(a.importId);
      expect(back.docJson.content?.map(textOfDoc)).toEqual(aDoc.docJson.content?.map(textOfDoc));
      expect((await repo.getPackage())?.fileName).toBe('body-basics.docx');
      expect((await repo.getPackage())?.importId).toBe(a.importId);
      expect(await repo.getPreservation()).toEqual(plain.preservation);
      // nothing was lost: B is itself a backup now, with its package
      const swap = (await repo.listBackups()).find(x => x.row.importId === b.importId && x.replacedByImport)!;
      expect((await db.importBackupParts.get(swap.seq!))?.package?.fileName).toBe('images.docx');

      await repo.revertImport();
      const again = (await repo.load()).doc!;
      expect(again.title).toBe('B');
      expect(again.importId).toBe(b.importId);
      expect((await repo.getPackage())?.fileName).toBe('images.docx');
      expect(await repo.getPreservation()).toEqual(imported.preservation);
      for (const id of collectAssetIds(imported.doc)) expect(await db.assets.get(id), id).toBeDefined();
    });

    it('restores a document that was not an import (and so has no package): the import\'s package leaves `current`', async () => {
      await repo.save(baseDoc('my own work'));
      await repo.importDocx(plain, { title: 'B' });
      expect(await repo.getPackage()).toBeDefined();
      await repo.revertImport();
      expect(JSON.stringify((await repo.load()).doc?.docJson)).toContain('my own work');
      expect(await repo.getPackage()).toBeUndefined();
      expect(await repo.getPreservation()).toBeUndefined();
      expect((await db.documents.get('current'))?.importId).toBeUndefined();
    });

    it('keeps its images: the replaced document\'s figures are still stored and hydrate', async () => {
      await repo.importDocx(imported, { title: 'A' });
      await repo.importDocx(plain, { title: 'B' });
      // saves after the import (garbage collection) must not have dropped A's figures, which only the backup refers to
      for (let i = 0; i < 3; i++) await repo.save({ ...(await repo.load()).doc!, title: 'B' + i });
      await repo.revertImport();
      const doc = (await repo.load()).doc!;
      for (const img of images(doc.docJson).filter(i => i.attrs?.assetId)) expect(img.attrs?.src, String(img.attrs?.assetId)).toMatch(/^url:/);
    });

    it('rejects, changing nothing, when there is nothing to restore', async () => {
      await repo.importDocx(plain, { title: 'over a blank document' });
      const before = { row: await db.documents.get('current'), pkg: await db.docxPackages.get('current'), n: await db.autosaveBackups.count() };
      await expect(repo.revertImport()).rejects.toThrow(/nothing to restore|no replaced document/i);
      expect(await db.documents.get('current')).toEqual(before.row);
      expect(await db.docxPackages.get('current')).toEqual(before.pkg);
      expect(await db.autosaveBackups.count()).toBe(before.n);
    });

    it('is atomic: a failure while writing leaves the imported document, package and backups as they were', async () => {
      await repo.save(baseDoc('my own work'));
      await repo.importDocx(plain, { title: 'B' });
      const before = {
        row: await db.documents.get('current'), pkg: await db.docxPackages.get('current'), pres: await db.preservationStores.get('current'),
        backups: await db.autosaveBackups.toArray(), parts: await db.importBackupParts.toArray(),
      };
      const boom = () => { throw new Error('disk full'); };
      db.docxPackages.hook('deleting', boom);
      try {
        await expect(repo.revertImport()).rejects.toThrow('disk full');
      } finally {
        db.docxPackages.hook('deleting').unsubscribe(boom);
      }
      expect(await db.documents.get('current')).toEqual(before.row);
      expect(await db.docxPackages.get('current')).toEqual(before.pkg);
      expect(await db.preservationStores.get('current')).toEqual(before.pres);
      expect(await db.autosaveBackups.toArray()).toEqual(before.backups);
      expect(await db.importBackupParts.toArray()).toEqual(before.parts);
    });

    it('never restores a quarantined (unreadable) row as the document', async () => {
      await db.documents.put({
        id: 'current', title: 'Broken', saveState: 'Saved', docJson: { type: 'doc', content: [{ type: 'hologram' }] },
        citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
      } as never);
      await repo.importDocx(plain, { title: 'fresh' });
      await expect(repo.revertImport()).rejects.toThrow();
      expect((await repo.load()).doc?.title).toBe('fresh');
    });
  });

  describe('revertImport and the blank-document rule: each rule on its own', () => {
    it('runs in turn with saves: a save already waiting on a slow fetch lands first, then the restore wins', async () => {
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const slow = createDexieRepository(db, {
        htmlToDoc, isValidDoc, resolver,
        fetchBytes: async () => { await gate; return { mime: 'image/png', data: new Uint8Array([1, 2, 3]).buffer }; },
      });
      await slow.save({ ...baseDoc('my own work'), title: 'W' });
      await slow.importDocx(plain, { title: 'the import' });
      const withBlob: LoadedDocument = {
        ...baseDoc('late autosave'), title: 'S',
        docJson: { type: 'doc', content: [{ type: IMAGE_NODE, attrs: { src: 'blob:http://x/1', assetId: null } }] } as JSONContent,
      };
      const pendingSave = slow.save(withBlob);
      const pendingRevert = slow.revertImport();
      await new Promise(r => setTimeout(r, 30));
      expect((await db.documents.get('current'))?.title).toBe('the import'); // the restore has not jumped the queue
      release();
      await Promise.all([pendingSave, pendingRevert]);
      expect((await db.documents.get('current'))?.title).toBe('W');
    });

    it('never picks a pinned legacy-migration backup: with no import backup there is nothing to restore', async () => {
      await db.documents.put({ id: 'current', title: 'Legacy', content: '<p>old text</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
      expect((await repo.load()).migrated).toBe(true);
      expect((await repo.listBackups()).some(b => b.pinned && !b.replacedByImport)).toBe(true); // the pre-migration row is pinned
      await expect(repo.revertImport()).rejects.toThrow(/nothing|no replaced/i);
      expect(await repo.peekRevert()).toBeNull();
      expect((await repo.load()).doc?.title).toBe('Legacy');
    });

    it('refuses when the replaced document\'s images are gone, changing nothing', async () => {
      await repo.importDocx(imported, { title: 'A' });
      await repo.importDocx(plain, { title: 'B' });
      const before = { row: await db.documents.get('current'), pkg: await db.docxPackages.get('current'), n: await db.autosaveBackups.count() };
      await db.assets.clear(); // what a quota eviction or a manual clean-up could do
      await expect(repo.revertImport()).rejects.toThrow(/missing/);
      expect(await db.documents.get('current')).toEqual(before.row);
      expect(await db.docxPackages.get('current')).toEqual(before.pkg);
      expect(await db.autosaveBackups.count()).toBe(before.n);
    });

    it('marks the restored document Saved, whatever its backed-up row said (it is exactly what is stored)', async () => {
      await repo.save({ ...baseDoc('my own work'), saveState: 'Draft' });
      await repo.importDocx(plain, { title: 'B' });
      expect((await repo.listBackups()).find(b => b.replacedByImport)?.row.saveState).toBe('Draft');
      await repo.revertImport();
      expect((await db.documents.get('current'))?.saveState).toBe('Saved');
    });

    it('an imported document is never blank, even with no text in it (its package would be lost with it)', async () => {
      const empty = { ...plain, doc: { type: 'doc', content: [{ type: 'paragraph' }] } as JSONContent };
      await repo.importDocx(empty, { title: 'empty import' });
      await repo.importDocx(imported, { title: 'next' });
      const kept = (await repo.listBackups()).filter(b => b.replacedByImport);
      expect(kept).toHaveLength(1);
      expect(kept[0].row.title).toBe('empty import');
      expect((await db.importBackupParts.get(kept[0].seq!))?.package?.fileName).toBe('body-basics.docx');
    });

    it.each([
      ['a line break', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }] }],
      ['a horizontal rule', { type: 'doc', content: [{ type: 'paragraph' }, { type: 'horizontalRule' }] }],
    ])('a document whose only content is %s is not blank', async (_name, docJson) => {
      await repo.save({ ...baseDoc(''), title: 'only an atom', docJson: docJson as JSONContent });
      await repo.importDocx(plain, { title: 'x' });
      expect((await repo.listBackups()).filter(b => b.replacedByImport).map(b => b.row.title)).toEqual(['only an atom']);
    });

    it('keeps five replaced documents by default', async () => {
      for (let i = 0; i < 6; i++) {
        await repo.save({ ...baseDoc('work ' + i), title: 'W' + i });
        await repo.importDocx(plain, { title: 'import ' + i });
      }
      const kept = (await repo.listBackups()).filter(b => b.replacedByImport);
      expect(kept.map(b => b.row.title)).toEqual(['W5', 'W4', 'W3', 'W2', 'W1']);
    });

    it('peekRevert names the newest replaced document, which is what revertImport restores', async () => {
      expect(await repo.peekRevert()).toBeNull();
      await repo.save({ ...baseDoc('first work'), title: 'First' });
      await repo.importDocx(plain, { title: 'one' });
      await repo.save({ ...(await repo.load()).doc!, title: 'one, edited' });
      await repo.importDocx(imported, { title: 'two' });
      const peek = await repo.peekRevert();
      expect(peek?.title).toBe('one, edited');
      await repo.revertImport();
      expect((await repo.load()).doc?.title).toBe(peek?.title);
    });

    it('after an import over a blank document the restore still names an EARLIER document, so the interface can say which', async () => {
      await repo.save({ ...baseDoc('first work'), title: 'First' });
      await repo.importDocx(plain, { title: 'one' }); // backs up First
      await repo.save({ ...baseDoc(''), title: 'blank' }); // New Manuscript
      await repo.importDocx(imported, { title: 'two' }); // over a blank document: no new backup
      expect((await repo.peekRevert())?.title).toBe('First');
    });
  });

  describe('copies of preserved pieces (fragmentClones)', () => {
    const withCopy = (doc: JSONContent, fromId: string, toId: string): JSONContent => {
      let done = false;
      const walkCopy = (n: JSONContent): JSONContent[] => {
        const kids = n.content ? { content: n.content.flatMap(walkCopy) } : {};
        const self = { ...n, ...kids };
        if (!done && n.type && n.attrs?.fragmentId === fromId) {
          done = true;
          return [self, { ...self, attrs: { ...n.attrs, fragmentId: toId } }];
        }
        return [self];
      };
      return walkCopy(doc)[0];
    };

    it('stores the XML of a pasted equation under its new id in the same save, so the copy can be exported', async () => {
      const r = await readDocx(fixture('opaque.docx'), undefined, 'opaque.docx');
      await repo.importDocx(r, { title: 'x' });
      const loaded = (await repo.load()).doc!;
      const fromId = [...collectFragmentIds(loaded.docJson)][0];
      expect(fromId).toBeDefined();
      const pasted = withCopy(loaded.docJson, fromId, 'f_pasted');
      expect(collectFragmentIds(pasted).has('f_pasted')).toBe(true);

      await repo.save({ ...loaded, docJson: pasted, fragmentClones: [{ fromId, toId: 'f_pasted' }] });
      const pres = (await db.preservationStores.get('current'))!.store;
      expect(pres.fragments.f_pasted).toEqual(pres.fragments[fromId]);
      expect(pres.fragments.f_pasted).not.toBe(pres.fragments[fromId]);
      for (const id of collectFragmentIds(pasted)) expect(pres.fragments[id], id).toBeDefined();
    });

    it('without the clone the copy is left pointing at nothing (what the unwired editor did)', async () => {
      const r = await readDocx(fixture('opaque.docx'), undefined, 'opaque.docx');
      await repo.importDocx(r, { title: 'x' });
      const loaded = (await repo.load()).doc!;
      const fromId = [...collectFragmentIds(loaded.docJson)][0];
      await repo.save({ ...loaded, docJson: withCopy(loaded.docJson, fromId, 'f_pasted') });
      expect((await db.preservationStores.get('current'))!.store.fragments.f_pasted).toBeUndefined();
    });

    it('a pasted picture lifted from a Word paragraph is a `copy` the writer can emit, because its XML is stored', async () => {
      await repo.importDocx(imported, { title: 'x' });
      const loaded = (await repo.load()).doc!;
      const pic = images(loaded.docJson).find(i => i.attrs?.fragmentId && i.attrs?.anchorBlockId)!;
      expect(pic).toBeDefined();
      const fromId = String(pic.attrs!.fragmentId);
      await repo.save({ ...loaded, docJson: withCopy(loaded.docJson, fromId, 'f_pic_copy'), fragmentClones: [{ fromId, toId: 'f_pic_copy' }] });
      const pres = (await db.preservationStores.get('current'))!.store;
      const saved = (await repo.load()).doc!.docJson;
      const emits = planLiftedDrawings(saved, pres).emit.filter(e => e.why === 'copy');
      expect(emits).toHaveLength(1);
      expect(pres.fragments[emits[0].fragmentId], 'the copy\'s fragment exists').toBeDefined();
    });

    it('ignores a clone whose original was never stored (a document that is not an import), and one already made', async () => {
      await repo.save(baseDoc('plain'));
      await repo.save({ ...baseDoc('plain 2'), fragmentClones: [{ fromId: 'nope', toId: 'f_x' }] });
      expect(await db.preservationStores.count()).toBe(0);
      const r = await readDocx(fixture('opaque.docx'), undefined, 'opaque.docx');
      await repo.importDocx(r, { title: 'x' });
      const loaded = (await repo.load()).doc!;
      const fromId = [...collectFragmentIds(loaded.docJson)][0];
      const doc = withCopy(loaded.docJson, fromId, 'f_c');
      await repo.save({ ...loaded, docJson: doc, fragmentClones: [{ fromId, toId: 'f_c' }] });
      const once = (await db.preservationStores.get('current'))!;
      await repo.save({ ...loaded, docJson: doc, title: 'again', fragmentClones: [{ fromId, toId: 'f_c' }] });
      expect((await db.preservationStores.get('current'))!.store.fragments.f_c).toEqual(once.store.fragments.f_c);
    });
  });

  describe('the stored import report', () => {
    it('is stored with the import and returned for the open document, with the accepted headings', async () => {
      const un = await readDocx(fixture('unstyled-sections.docx'), undefined, 'u.docx');
      const { importId } = await repo.importDocx({ ...un, doc: applyHeadings(un.doc, un.headingCandidates.slice(0, 2)) }, { title: 'x', acceptedHeadingIndexes: un.headingCandidates.slice(0, 2).map(h => h.index) });
      const stored = await repo.getImportReport();
      expect(stored?.importId).toBe(importId);
      expect(stored?.fileName).toBe('u.docx');
      expect(stored?.report).toEqual(un.report);
      expect(stored?.headingCandidates).toEqual(un.headingCandidates);
      expect(stored?.acceptedHeadingIndexes).toEqual(un.headingCandidates.slice(0, 2).map(h => h.index));
      // survives ordinary saves
      await repo.save({ ...(await repo.load()).doc!, title: 'edited' });
      expect((await repo.getImportReport())?.importId).toBe(importId);
    });

    it('is not offered for a document that is not an import, goes with the package to the backup, and comes back with a restore', async () => {
      await repo.save({ ...baseDoc('my own work'), title: 'W' });
      expect(await repo.getImportReport()).toBeUndefined();
      const { importId } = await repo.importDocx(imported, { title: 'B' });
      expect((await repo.getImportReport())?.importId).toBe(importId);
      await repo.save(baseDoc('a new manuscript')); // detaches
      expect(await repo.getImportReport()).toBeUndefined();
      expect(await db.importReports.count()).toBe(0);
      const old = (await repo.listBackups()).find(b => b.row.importId === importId)!;
      expect((await db.importBackupParts.get(old.seq!))?.importReport?.report).toEqual(imported.report);
    });

    it('a restore puts the right report back, and the one it replaces goes to the backup', async () => {
      const a = await repo.importDocx(plain, { title: 'A' });
      const b = await repo.importDocx(imported, { title: 'B' });
      expect((await repo.getImportReport())?.importId).toBe(b.importId);
      await repo.revertImport();
      const back = await repo.getImportReport();
      expect(back?.importId).toBe(a.importId);
      expect(back?.report).toEqual(plain.report);
      await repo.revertImport();
      expect((await repo.getImportReport())?.report).toEqual(imported.report);
    });

    it('a failed import writes no report', async () => {
      const boom = () => { throw new Error('disk full'); };
      db.importReports.hook('creating', boom);
      try {
        await expect(repo.importDocx(plain, { title: 'x' })).rejects.toThrow('disk full');
      } finally {
        db.importReports.hook('creating').unsubscribe(boom);
      }
      expect(await db.importReports.count()).toBe(0);
      expect(await db.documents.count()).toBe(0);
    });
  });
});
