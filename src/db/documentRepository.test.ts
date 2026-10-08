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
    expect(await repo.load()).toEqual({ doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: false });
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
    expect(r).toEqual({ doc: null, migrated: false, recoveredFromBackup: false, unreadableRowPresent: true });
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
});
