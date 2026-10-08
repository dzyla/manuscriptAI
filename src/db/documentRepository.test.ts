// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';
import { createDexieRepository, type LoadedDocument, type DocumentRepository } from './documentRepository';
import { htmlToDoc, isValidDoc } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';
import { IMAGE_NODE } from './assetStore';
import { emptyPreservationStore } from '../docx/preserve/types';

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

  it('prunes unreferenced preservation fragments on save', async () => {
    const store = emptyPreservationStore();
    store.fragments = { f1: { xml: '<a/>', relIds: [], nsDecls: {} }, f2: { xml: '<b/>', relIds: [], nsDecls: {} } };
    await repo.savePackage({ documentId: 'current', original: new ArrayBuffer(4), fileName: 'x.docx', preservation: store, importedAt: 1 });
    const d = baseDoc('chip');
    d.docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] }] };
    await repo.save(d);
    const pkg = await repo.getPackage();
    expect(Object.keys(pkg!.preservation.fragments)).toEqual(['f1']);
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
