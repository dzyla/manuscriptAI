// @vitest-environment jsdom
/**
 * End to end, on documents the app has to open: the file's bytes, across a worker boundary (a double that copies the request in and
 * the reply out, as a real Worker does), through the confirmed-import transaction into IndexedDB, and back out of a FRESH load.
 *
 * The committed fixtures always run. The author's own documents (fixtures/private, gitignored) run when present, with the counts
 * established when they were read; only counts and structure are asserted or printed, never text.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { db } from '../db/manuscriptDb';
import { createDexieRepository } from '../db/documentRepository';
import { useDocumentStore } from '../stores/useDocumentStore';
import { htmlToDoc, isValidDoc } from '../extensions/schema';
import { collectAssetIds, IMAGE_NODE } from '../db/assetStore';
import { startDocxImport, type ImportWorkerHandle } from './docxImport';
import { readForImport } from '../workers/docxImportCore';
import { summarizeReport } from '../docx/fidelity';
import { planLiftedDrawings } from '../docx/preserve/lifted';
import { collectFragmentIds } from '../docx/preserve/refs';
import { loadDocx } from '../test/docxFixtures';

const resolver = { urlFor: (r: { id: string }) => `blob:test/${r.id}` };
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => `blob:test/${b.size}-${Math.random().toString(36).slice(2)}`, revokeObjectURL: () => {} }));

// The request is copied in and the reply copied out, as a real Worker does. (Under jsdom, structuredClone makes buffers of Node's
// realm, which the zip reader does not recognise: the copy in is re-made with this environment's ArrayBuffer.)
const copyIn = (data: ArrayBuffer): ArrayBuffer => {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(new Uint8Array(structuredClone(data)));
  return out;
};
const boundaryWorker = (): ImportWorkerHandle => ({
  read: async (data, fileName, onStage) => structuredClone(await readForImport(copyIn(data), fileName, onStage)),
  terminate: () => {},
});

const walk = (n: JSONContent, fn: (x: JSONContent) => void): void => {
  fn(n);
  (n.content ?? []).forEach(c => walk(c, fn));
};
const count = (doc: JSONContent, type: string): number => {
  let k = 0;
  walk(doc, n => { if (n.type === type) k++; });
  return k;
};
/** Byte equality that is fast on megabytes (the matchers' deep equality on typed arrays is not). */
const sameBytes = (a: ArrayBuffer, b: ArrayBuffer): boolean => Buffer.from(a).equals(Buffer.from(b));
const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));

beforeEach(async () => {
  await db.delete();
  await db.open();
  useDocumentStore.getState().resetDocument();
  useDocumentStore.setState({ loadStatus: 'loading', blockedByUnreadable: false });
  await useDocumentStore.getState().initialize();
});

interface Expect {
  tables: number;
  images: number;
  /** Pictures that are only a link in the source: image nodes without bytes. */
  linkedImages?: number;
  headingCandidates: number;
  summary?: string;
}

async function importThroughEverything(name: string, dir: 'fixtures' | 'private', acceptAll: boolean) {
  const data = loadDocx(name, dir);
  const t0 = performance.now();
  const result = await startDocxImport({ name, size: data.byteLength, arrayBuffer: async () => data.slice(0) }, boundaryWorker).promise;
  const readMs = performance.now() - t0;
  const accepted = acceptAll ? result.headingCandidates : [];
  const t1 = performance.now();
  const docJson = await useDocumentStore.getState().importDocx(result, { title: name, acceptedHeadings: accepted });
  const commitMs = performance.now() - t1;
  const t2 = performance.now();
  const fresh = await createDexieRepository(db, { htmlToDoc, isValidDoc, resolver }).load(); // a repository that remembers nothing
  const loadMs = performance.now() - t2;
  return { data, result, accepted, docJson, fresh, readMs, commitMs, loadMs };
}

function describeImport(name: string, dir: 'fixtures' | 'private', want: Expect) {
  describe(`${dir === 'private' ? 'private ' : ''}${name}`, () => {
    it('reads, commits and loads back with its images, headings, package and read-only content intact', { timeout: 120_000 }, async () => {
      const r = await importThroughEverything(name, dir, true);
      const loaded = r.fresh.doc!;
      expect(r.fresh.unreadableRowPresent).toBe(false);
      expect(loaded).not.toBeNull();

      // what the reader found is what came back
      expect(count(r.result.doc, 'table')).toBe(want.tables);
      expect(count(loaded.docJson, 'table')).toBe(want.tables);
      expect(r.result.headingCandidates).toHaveLength(want.headingCandidates);
      if (want.summary) expect(summarizeReport(r.result.report)).toBe(want.summary);

      // every image: present in the loaded document, with bytes in the store, hydrated, and byte-identical to what the file held
      const imgs: JSONContent[] = [];
      walk(loaded.docJson, n => { if (n.type === IMAGE_NODE) imgs.push(n); });
      expect(imgs).toHaveLength(want.images);
      const ids = collectAssetIds(loaded.docJson);
      expect(ids.size).toBe(r.result.assets.length);
      for (const id of ids) {
        const row = await db.assets.get(id);
        expect(row, id).toBeDefined();
        const draft = r.result.assets.find(a => a.id === id)!;
        expect(row!.size).toBe(draft.data.byteLength);
        expect(sameBytes(row!.data, draft.data), id).toBe(true);
      }
      // a picture with bytes is hydrated; one that is only a link in the source (no bytes anywhere) is a placeholder, and must stay one
      for (const img of imgs.filter(i => i.attrs?.assetId)) expect(String(img.attrs?.src), String(img.attrs?.assetId)).toMatch(/^blob:test\//);
      expect(imgs.filter(i => !i.attrs?.assetId)).toHaveLength(want.linkedImages ?? 0);

      // accepting every candidate gives exactly that many headings, and nothing else became one
      expect(count(loaded.docJson, 'heading')).toBe(want.headingCandidates);
      expect(count(r.result.doc, 'heading')).toBe(0); // the reader applied none
      const headingTexts = (loaded.docJson.content ?? []).filter(n => n.type === 'heading').map(n => textOf(n).trim());
      expect(headingTexts).toEqual(r.result.headingCandidates.map(h => h.text));

      // the package and the preservation map are stored, whole
      const pkg = await db.docxPackages.get('current');
      expect(pkg?.fileName).toBe(name);
      expect(sameBytes(pkg!.original, r.data)).toBe(true);
      const pres = (await db.preservationStores.get('current'))!.store;
      expect(pres).toEqual(r.result.preservation);
      // the Word style ids a writer needs are stored with the map, not lost with the read
      expect(pres.styles).toBeDefined();
      expect(Object.keys(pres.styles!.wordIdByAppId).length + pres.styles!.backfilled.length).toBe(Object.keys(r.result.format.styles).length);

      // the writer's contract is intact: an untouched imported document asks for no strip and no re-emit
      expect(planLiftedDrawings(loaded.docJson, pres)).toEqual({ strip: [], emit: [] });
      for (const id of collectFragmentIds(loaded.docJson)) expect(pres.fragments[id], id).toBeDefined();

      console.log(
        `[a2 e2e] ${name}: ${r.data.byteLength} bytes; read through the worker boundary ${r.readMs.toFixed(0)} ms, commit ${r.commitMs.toFixed(0)} ms, fresh load ${r.loadMs.toFixed(0)} ms; ` +
        `${imgs.length} images, ${r.result.assets.reduce((n, a) => n + a.data.byteLength, 0)} image bytes, ${r.accepted.length} headings accepted`,
      );
    });

    it('rejecting every candidate imports no heading at all', { timeout: 120_000 }, async () => {
      const r = await importThroughEverything(name, dir, false);
      expect(count(r.fresh.doc!.docJson, 'heading')).toBe(0);
    });

    it('the first autosave after the import, and the ones after it, do not lose an image', { timeout: 120_000 }, async () => {
      const r = await importThroughEverything(name, dir, true);
      const before = (await db.assets.toArray()).map(a => a.id).sort();
      expect(before.length).toBe(r.result.assets.length);
      // the store now holds the document as the editor would report it (images carry session blob: URLs)
      const s = useDocumentStore.getState();
      expect(await s.persist()).toBe(true);
      s.setTitle('edited');
      for (let i = 0; i < 12; i++) { useDocumentStore.getState().setTitle('edit ' + i); await useDocumentStore.getState().persist(); }
      expect((await db.assets.toArray()).map(a => a.id).sort()).toEqual(before);
      const again = await createDexieRepository(db, { htmlToDoc, isValidDoc, resolver }).load();
      for (const id of collectAssetIds(again.doc!.docJson)) expect(await db.assets.get(id), id).toBeDefined();
      // the preserved XML the writer needs is still all there after those saves (the saves prune fragments nothing refers to)
      const pres = (await db.preservationStores.get('current'))!.store;
      expect(pres).toEqual(r.result.preservation);
      for (const id of collectFragmentIds(again.doc!.docJson)) expect(pres.fragments[id], id).toBeDefined();
    });
  });
}

/** Import `first`, then `second` over it, then restore: the first comes back whole, with its own package, map and pictures. */
function describeRevert(first: string, second: string, dir: 'fixtures' | 'private') {
  it(`importing ${second} over ${first} and restoring brings ${first} back exactly, and restoring again brings ${second} back`, { timeout: 120_000 }, async () => {
    const a = await importThroughEverything(first, dir, true);
    const aDoc = a.fresh.doc!;
    const aIds = [...collectAssetIds(aDoc.docJson)].sort();
    const b = await importThroughEverything(second, dir, true);
    expect((await db.docxPackages.get('current'))?.fileName).toBe(second);

    await useDocumentStore.getState().revertImport();
    const back = (await createDexieRepository(db, { htmlToDoc, isValidDoc, resolver }).load()).doc!;
    expect(back.title).toBe(first);
    expect(back.importId).toBe(aDoc.importId);
    expect([...collectAssetIds(back.docJson)].sort()).toEqual(aIds);
    for (const id of aIds) expect(await db.assets.get(id), id).toBeDefined();
    expect(count(back.docJson, 'heading')).toBe(count(aDoc.docJson, 'heading'));
    expect(count(back.docJson, 'tableRow')).toBe(count(aDoc.docJson, 'tableRow'));
    expect((back.docJson.content ?? []).map(textOf)).toEqual((aDoc.docJson.content ?? []).map(textOf));
    const pkg = (await db.docxPackages.get('current'))!;
    expect(pkg.fileName).toBe(first);
    expect(sameBytes(pkg.original, a.data)).toBe(true);
    const pres = (await db.preservationStores.get('current'))!.store;
    expect(pres).toEqual(a.result.preservation);
    expect(planLiftedDrawings(back.docJson, pres)).toEqual({ strip: [], emit: [] });

    await useDocumentStore.getState().revertImport();
    const again = (await createDexieRepository(db, { htmlToDoc, isValidDoc, resolver }).load()).doc!;
    expect(again.title).toBe(second);
    expect(again.importId).toBe(b.fresh.doc!.importId);
    expect(sameBytes((await db.docxPackages.get('current'))!.original, b.data)).toBe(true);
  });
}

// Committed fixtures: always run.
describe('restore (committed fixtures)', () => describeRevert('images.docx', 'unstyled-sections.docx', 'fixtures'));
describeImport('images.docx', 'fixtures', { tables: 0, images: 6, linkedImages: 1, headingCandidates: 0 });
describeImport('unstyled-sections.docx', 'fixtures', { tables: 0, images: 0, headingCandidates: 7 });

// The author's own documents: counts established when they were read.
const havePrivate = (f: string) => existsSync(join(process.cwd(), 'fixtures/private', f));
describe.skipIf(!havePrivate('r01.docx'))('r01.docx (private)', () => {
  describeImport('r01.docx', 'private', {
    tables: 0,
    images: 10,
    headingCandidates: 9,
    summary: 'Imported 45 tracked changes · 52 comments · 8 warnings',
  });
  it('keeps tracked changes, comments and the warnings as separate figures, and lifts all 10 pictures with their captions', { timeout: 120_000 }, async () => {
    const r = await importThroughEverything('r01.docx', 'private', true);
    const c = r.result.report.counts;
    expect([c.trackedChange, c.formatChange, c.comment, r.result.report.warnings.length]).toEqual([32, 13, 52, 8]);
    const lifted = Object.values(r.result.preservation.blocks).flatMap(b => b.lifted ?? []);
    expect(lifted).toHaveLength(10);
    const stored = (await db.preservationStores.get('current'))!.store;
    expect(Object.values(stored.blocks).flatMap(b => b.lifted ?? [])).toHaveLength(10);
  });
});
describe.skipIf(!havePrivate('snsf.docx') || !havePrivate('r01.docx'))('restore (private)', () => describeRevert('snsf.docx', 'r01.docx', 'private'));
describe.skipIf(!havePrivate('snsf.docx'))('snsf.docx (private)', () => {
  describeImport('snsf.docx', 'private', {
    tables: 1,
    images: 3,
    headingCandidates: 9,
    summary: 'Imported 20 pages · 5 lists · 22 citations · 1 bibliography · 4 warnings',
  });
  it('keeps the 17-row table through the commit', { timeout: 120_000 }, async () => {
    const r = await importThroughEverything('snsf.docx', 'private', true);
    expect(count(r.fresh.doc!.docJson, 'tableRow')).toBe(17);
    expect(count(r.fresh.doc!.docJson, 'tableRow')).toBe(count(r.result.doc, 'tableRow'));
    expect(r.result.report.counts.list).toBe(5);
    expect(r.result.report.counts.externalCitation).toBe(22);
  });
});
