import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Dexie from 'dexie';
import { startDocxImport, ImportCancelled, titleFromFileName, type ImportWorkerHandle, type ImportableFile } from './docxImport';
import { readForImport, DocxImportError } from '../workers/docxImportCore';
import { readDocx, type ImportStage } from '../docx/read';
import { ManuscriptDb } from '../db/manuscriptDb';

const bytes = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const file = (name: string, data: ArrayBuffer): ImportableFile => ({ name, size: data.byteLength, arrayBuffer: async () => data.slice(0) });

/**
 * A worker double that behaves like the real boundary: the request is COPIED in (structuredClone) and the reply is copied out, so
 * anything not cloneable fails here as it would in a browser.
 */
function boundaryWorker(): ImportWorkerHandle & { terminated: number; created: number } {
  const w = {
    terminated: 0,
    created: 0,
    read: async (data: ArrayBuffer, fileName: string, onStage: (s: ImportStage) => void) => {
      const result = await readForImport(structuredClone(data), fileName, onStage);
      return structuredClone(result);
    },
    terminate() { w.terminated++; },
  };
  return w;
}

describe('the worker function (readForImport)', () => {
  it('returns plain data without `original`, and the result survives structuredClone unchanged', async () => {
    for (const name of ['images.docx', 'opaque.docx', 'tables.docx', 'lists.docx', 'unstyled-sections.docx', 'google-export.docx']) {
      const r = await readForImport(bytes(name), name);
      expect('original' in r, name).toBe(false);
      expect(structuredClone(r), name).toEqual(r);
      expect(r.fileName).toBe(name);
    }
  });

  it('is the same read as readDocx apart from the bytes it leaves out', async () => {
    const full = await readDocx(bytes('images.docx'), undefined, 'images.docx');
    const { original: _o, ...rest } = full;
    expect(await readForImport(bytes('images.docx'), 'images.docx')).toEqual(rest);
  });

  it('reports each step, in order, and a callback that throws does not stop the read', async () => {
    const seen: ImportStage[] = [];
    await readForImport(bytes('body-basics.docx'), 'b.docx', s => seen.push(s));
    expect(seen).toEqual(['opening', 'styles', 'body', 'headings', 'report']);
    const r = await readForImport(bytes('body-basics.docx'), 'b.docx', () => { throw new Error('ui blew up'); });
    expect(r.doc.type).toBe('doc');
  });

  it('words the reader refusals for the author: not a docx, macro-enabled, damaged', async () => {
    const text = new TextEncoder().encode('just some text, not a zip file at all, long enough to pass a size check').buffer as ArrayBuffer;
    const a = await readForImport(text, 'notes.docx').catch(e => e);
    expect(a).toBeInstanceOf(DocxImportError);
    expect(a.message).toMatch(/not a Word \(\.docx\) document/);
    const m = await readForImport(bytes('macro.docm'), 'm.docm').catch(e => e);
    expect(m.message).toMatch(/Macro-enabled/);
    const t = await readForImport(bytes('truncated.docx'), 't.docx').catch(e => e);
    expect(t).toBeInstanceOf(DocxImportError);
    // the wording survives Comlink, which carries only name and message
    expect(structuredClone({ name: t.name, message: t.message }).name).toBe('DocxImportError');
  });
});

describe('startDocxImport', () => {
  it('reads through the worker boundary, re-attaches this thread\'s own bytes as `original`, forwards the steps and ends the worker', async () => {
    const data = bytes('images.docx');
    const w = boundaryWorker();
    const stages: ImportStage[] = [];
    const run = startDocxImport(file('images.docx', data), () => { w.created++; return w; }, s => stages.push(s));
    const result = await run.promise;
    expect(new Uint8Array(result.original)).toEqual(new Uint8Array(data));
    expect(result.original.byteLength).toBeGreaterThan(0); // copied to the worker, not transferred: not detached
    expect(result.fileName).toBe('images.docx');
    expect(result.assets.length).toBeGreaterThan(0);
    expect(stages).toEqual(['opening', 'styles', 'body', 'headings', 'report']);
    expect(w.created).toBe(1);
    expect(w.terminated).toBe(1);
  });

  it('rejects an empty file without starting a worker', async () => {
    const w = boundaryWorker();
    const run = startDocxImport(file('empty.docx', new ArrayBuffer(0)), () => { w.created++; return w; });
    await expect(run.promise).rejects.toThrow('This file is empty.');
    expect(w.created).toBe(0);
  });

  it('rejects a file that is not a docx with the author-facing message, and ends the worker', async () => {
    const w = boundaryWorker();
    const junk = new TextEncoder().encode('%PDF-1.7 this is not a word document, it is padded out to pass the size check').buffer as ArrayBuffer;
    const run = startDocxImport(file('paper.docx', junk), () => w);
    await expect(run.promise).rejects.toThrow(/not a Word \(\.docx\) document/);
    expect(w.terminated).toBe(1);
  });

  it('a failure to start the worker is a rejection, not a hang', async () => {
    const run = startDocxImport(file('b.docx', bytes('body-basics.docx')), () => { throw new Error('no workers here'); });
    await expect(run.promise).rejects.toThrow('no workers here');
  });

  describe('cancellation', () => {
    /** A worker whose read finishes only when the test says so (or never, once terminated). */
    function slowWorker() {
      let finish: (() => void) | null = null;
      const w = {
        terminated: 0,
        read: (data: ArrayBuffer, name: string, onStage: (s: ImportStage) => void) => new Promise<Awaited<ReturnType<typeof readForImport>>>((resolve, reject) => {
          onStage('opening');
          finish = () => readForImport(structuredClone(data), name, onStage).then(r => resolve(structuredClone(r)), reject);
        }),
        terminate() { w.terminated++; },
        complete: () => finish?.(),
      };
      return w;
    }

    it('cancelling while the worker reads rejects with ImportCancelled, terminates the worker and writes nothing', async () => {
      const dbName = 't-cancel-' + Math.random().toString(36).slice(2);
      const db = new ManuscriptDb(dbName);
      try {
        const w = slowWorker();
        const stages: ImportStage[] = [];
        const run = startDocxImport(file('images.docx', bytes('images.docx')), () => w, s => stages.push(s));
        await vi.waitFor(() => expect(stages).toEqual(['opening']));
        run.cancel();
        await expect(run.promise).rejects.toBeInstanceOf(ImportCancelled);
        expect(w.terminated).toBe(1);
        // a read that still finishes after the cancel (a terminated worker cannot, but the double can) is not delivered or reported
        w.complete();
        await new Promise(r => setTimeout(r, 20));
        expect(stages).toEqual(['opening']);
        // no partial state anywhere: the reader never writes, so a cancelled read leaves no assets, rows or packages behind
        for (const t of [db.documents, db.assets, db.docxPackages, db.preservationStores, db.autosaveBackups]) expect(await t.count()).toBe(0);
      } finally {
        db.close();
        await Dexie.delete(dbName);
      }
    });

    it('cancelling twice, or after the read finished, does nothing more', async () => {
      const w = boundaryWorker();
      const run = startDocxImport(file('b.docx', bytes('body-basics.docx')), () => w);
      const result = await run.promise;
      run.cancel();
      run.cancel();
      expect(w.terminated).toBe(1); // ended once, when the read ended
      expect(result.doc.type).toBe('doc');
    });

    it('cancelling before the file bytes are available never starts a worker', async () => {
      let release!: (b: ArrayBuffer) => void;
      const slowFile: ImportableFile = { name: 'a.docx', size: 10, arrayBuffer: () => new Promise(r => { release = r; }) };
      const w = boundaryWorker();
      const run = startDocxImport(slowFile, () => { w.created++; return w; });
      run.cancel();
      release(bytes('body-basics.docx'));
      await expect(run.promise).rejects.toBeInstanceOf(ImportCancelled);
      await new Promise(r => setTimeout(r, 10));
      expect(w.created).toBe(0);
    });
  });

  it('two imports at once are independent (cancelling one leaves the other to finish)', async () => {
    const a = boundaryWorker();
    const b = boundaryWorker();
    const ra = startDocxImport(file('a.docx', bytes('images.docx')), () => a);
    const rb = startDocxImport(file('b.docx', bytes('body-basics.docx')), () => b);
    ra.cancel();
    await expect(ra.promise).rejects.toBeInstanceOf(ImportCancelled);
    const result = await rb.promise;
    expect(result.fileName).toBe('b.docx');
    expect(b.terminated).toBe(1);
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and keeps the rest', () => {
    expect(titleFromFileName('SNFS research plan.final.docx')).toBe('SNFS research plan.final');
    expect(titleFromFileName('grant.docx')).toBe('grant');
    expect(titleFromFileName('.docx')).toBe('Untitled Manuscript');
    expect(titleFromFileName('')).toBe('Untitled Manuscript');
  });
});

describe('worker modules stay out of the DOM and React', () => {
  it('imports none of React, the editor schema, TipTap React or a DOM global', () => {
    for (const f of ['../workers/docxImportWorker.ts', '../workers/docxImportCore.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from 'react'|@tiptap\/react|extensions\/schema'|\.tsx'/);
      expect(src, f).not.toMatch(/\bwindow\.|\bdocument\.(create|get|query)|new Blob\(|localStorage|indexedDB/);
      expect(src, f).not.toMatch(/db\/manuscriptDb|documentRepository|useDocumentStore/); // the worker reads; only the main thread commits
    }
  });
});
