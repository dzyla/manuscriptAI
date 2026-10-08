// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JSONContent } from '@tiptap/core';
import { useDocxImport, type DocxImportDeps } from './useDocxImport';
import { readForImport, type WorkerImportResult } from '../workers/docxImportCore';
import type { ImportStage, ImportWorkerHandle } from '../services/docxImport';
import { loadDocx } from '../test/docxFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => { root?.unmount(); }); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });

let ready: WorkerImportResult;
beforeAll(async () => {
  ready = await readForImport(loadDocx('unstyled-sections.docx'), 'unstyled-sections.docx');
});

const bytes = loadDocx('body-basics.docx');
const file = (name = 'unstyled-sections.docx', data: ArrayBuffer = bytes) => ({ name, size: data.byteLength, arrayBuffer: async () => data.slice(0) });
const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

/** A worker whose read is finished by the test. */
function controlledWorker() {
  let done!: (r: WorkerImportResult) => void;
  let fail!: (e: Error) => void;
  let stage!: (s: ImportStage) => void;
  let name = '';
  const w: ImportWorkerHandle & { terminated: number; finish: (r?: WorkerImportResult) => void; fail: (e: Error) => void; stage: (s: ImportStage) => void } = {
    terminated: 0,
    read: (_d, n, onStage) => new Promise<WorkerImportResult>((res, rej) => { name = n; done = res; fail = rej; stage = onStage; }),
    terminate() { w.terminated++; },
    finish: r => done({ ...(r ?? ready), fileName: name }), // like the real worker, the file name is the one it was given
    fail: e => fail(e),
    stage: s => stage(s),
  };
  return w;
}

function setup(over: Partial<DocxImportDeps> = {}) {
  const workers: ReturnType<typeof controlledWorker>[] = [];
  const notes: Array<[string, string]> = [];
  const commit = vi.fn<DocxImportDeps['commit']>(async () => ({ type: 'doc', content: [] }) as JSONContent);
  const showInEditor = vi.fn();
  const onImported = vi.fn();
  const deps: DocxImportDeps = {
    commit, showInEditor, onImported,
    notify: (m, t) => notes.push([m, t]),
    createWorker: () => { const w = controlledWorker(); workers.push(w); return w; },
    ...over,
  };
  let api!: ReturnType<typeof useDocxImport>;
  function Harness() { api = useDocxImport(deps); return null; }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Harness />); });
  return { get api() { return api; }, workers, notes, commit: deps.commit as ReturnType<typeof vi.fn>, showInEditor, onImported };
}

describe('useDocxImport', () => {
  it('reads (with the file name and size), shows the steps, then offers the report', async () => {
    const t = setup();
    await act(async () => { void t.api.start(file()); });
    await tick();
    expect(t.api.state).toMatchObject({ phase: 'reading', fileName: 'unstyled-sections.docx', size: bytes.byteLength, stage: null });
    act(() => { t.workers[0].stage('body'); });
    expect(t.api.state).toMatchObject({ phase: 'reading', stage: 'body' });
    await act(async () => { t.workers[0].finish(); });
    expect(t.api.state?.phase).toBe('review');
    expect((t.api.state as { result: { original: ArrayBuffer; fileName: string } }).result.fileName).toBe('unstyled-sections.docx');
    expect((t.api.state as { result: { original: ArrayBuffer } }).result.original.byteLength).toBe(bytes.byteLength);
    expect(t.commit).not.toHaveBeenCalled(); // nothing is written until the author confirms
    expect(t.workers[0].terminated).toBe(1);
  });

  it('cancelling the read clears everything, ends the worker, never commits, and a new import can start at once', async () => {
    const t = setup();
    await act(async () => { void t.api.start(file('a.docx')); });
    await tick();
    act(() => { t.api.cancelRead(); });
    expect(t.api.state).toBeNull();
    expect(t.workers[0].terminated).toBe(1);
    // import B straight away: the cancelled A settling afterwards must not clobber it
    await act(async () => { void t.api.start(file('b.docx')); });
    await tick();
    expect(t.api.state).toMatchObject({ phase: 'reading', fileName: 'b.docx' });
    await act(async () => { t.workers[0].finish(); }); // A's late result, from a worker that was meant to be dead
    expect(t.api.state).toMatchObject({ phase: 'reading', fileName: 'b.docx' });
    expect(t.commit).not.toHaveBeenCalled();
    expect(t.notes).toEqual([]); // no "failed" message for a cancel
  });

  it('a second file chosen while one is being read or reviewed is refused, not interleaved', async () => {
    const t = setup();
    await act(async () => { void t.api.start(file('a.docx')); });
    await tick();
    await act(async () => { await t.api.start(file('b.docx')); });
    expect(t.workers).toHaveLength(1);
    expect(t.notes).toEqual([['An import is already in progress.', 'info']]);
    await act(async () => { t.workers[0].finish(); });
    await act(async () => { await t.api.start(file('c.docx')); }); // still refused while the report is open
    expect(t.workers).toHaveLength(1);
    expect(t.api.state).toMatchObject({ phase: 'review' });
  });

  it('confirm commits once with the accepted headings and the file name as title, shows the document in the editor, then closes', async () => {
    const committed: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
    const t = setup({ commit: vi.fn(async () => committed) });
    await act(async () => { void t.api.start(file()); });
    await tick();
    await act(async () => { t.workers[0].finish(); });
    const accepted = ready.headingCandidates.slice(0, 2);
    await act(async () => { void t.api.confirm(accepted); void t.api.confirm(accepted); }); // a double click
    await tick();
    expect(t.commit).toHaveBeenCalledTimes(1);
    expect(t.api.state).toBeNull();
    expect(t.showInEditor).toHaveBeenCalledTimes(1);
    expect(t.showInEditor).toHaveBeenCalledWith(committed);
    expect(t.onImported).toHaveBeenCalledTimes(1);
    expect(t.notes.at(-1)).toEqual(['Imported unstyled-sections.docx', 'success']);
  });

  it('offers the action the app supplies (Restore previous document) with the success message, and none when it supplies none', async () => {
    const action = { label: 'Restore previous document', onClick: vi.fn() };
    const got: unknown[] = [];
    const t = setup({ afterImportAction: () => action, notify: (m, ty, a) => { got.push([m, ty, a]); } });
    await act(async () => { void t.api.start(file()); });
    await tick();
    await act(async () => { t.workers[0].finish(); });
    await act(async () => { await t.api.confirm([]); });
    expect(got.at(-1)).toEqual(['Imported unstyled-sections.docx', 'success', action]);
    const t2 = setup({ afterImportAction: () => undefined });
    await act(async () => { void t2.api.start(file()); });
    await tick();
    await act(async () => { t2.workers[0].finish(); });
    await act(async () => { await t2.api.confirm([]); });
    expect(t2.notes.at(-1)?.[1]).toBe('success');
  });

  it('commit is called exactly once with title and accepted headings (and with the result that was reviewed)', async () => {
    const t = setup();
    await act(async () => { void t.api.start(file('My grant.docx')); });
    await tick();
    await act(async () => { t.workers[0].finish(); });
    const reviewed = (t.api.state as { result: unknown }).result;
    const accepted = ready.headingCandidates.slice(1, 3);
    await act(async () => { void t.api.confirm(accepted); void t.api.confirm(accepted); });
    await tick();
    expect(t.commit).toHaveBeenCalledTimes(1);
    expect(t.commit).toHaveBeenCalledWith(reviewed, { title: 'My grant', acceptedHeadings: accepted });
  });

  it('a failed commit leaves the report open for a retry, tells the author the document is unchanged, and does not touch the editor', async () => {
    let fail = true;
    const t = setup({ commit: vi.fn(async () => { if (fail) throw new DOMException('quota exceeded', 'QuotaExceededError'); return { type: 'doc' } as JSONContent; }) });
    await act(async () => { void t.api.start(file()); });
    await tick();
    await act(async () => { t.workers[0].finish(); });
    await act(async () => { await t.api.confirm([]); });
    expect(t.api.state).toMatchObject({ phase: 'review', committing: false });
    expect(t.showInEditor).not.toHaveBeenCalled();
    expect(t.notes.at(-1)?.[1]).toBe('error');
    expect(t.notes.at(-1)?.[0]).toMatch(/your document is unchanged.*quota exceeded/);
    fail = false;
    await act(async () => { await t.api.confirm([]); });
    expect(t.api.state).toBeNull();
    expect(t.showInEditor).toHaveBeenCalledTimes(1);
  });

  it('cancelling the report discards the result without committing; it cannot be cancelled while the commit is running', async () => {
    let release!: () => void;
    const t = setup({ commit: vi.fn(() => new Promise<JSONContent>(res => { release = () => res({ type: 'doc' }); })) });
    await act(async () => { void t.api.start(file()); });
    await tick();
    await act(async () => { t.workers[0].finish(); });
    await act(async () => { void t.api.confirm([]); });
    act(() => { t.api.cancelReview(); });
    expect(t.api.state).toMatchObject({ phase: 'review', committing: true }); // ignored
    await act(async () => { release(); });
    expect(t.api.state).toBeNull();

    await act(async () => { void t.api.start(file()); });
    await tick();
    await act(async () => { t.workers[1].finish(); });
    act(() => { t.api.cancelReview(); });
    expect(t.api.state).toBeNull();
    expect(t.commit).toHaveBeenCalledTimes(1); // only the first
    await act(async () => { void t.api.start(file()); });
    await tick();
    expect(t.api.state?.phase).toBe('reading'); // free to import again
  });

  it('a file that cannot be read reports why, closes, and leaves the next import free', async () => {
    const t = setup();
    await act(async () => { void t.api.start(file('notes.docx')); });
    await tick();
    await act(async () => { t.workers[0].fail(new Error('This file is not a Word (.docx) document.')); });
    expect(t.api.state).toBeNull();
    expect(t.notes.at(-1)).toEqual(['Could not import notes.docx: This file is not a Word (.docx) document.', 'error']);
    await act(async () => { void t.api.start(file()); });
    await tick();
    expect(t.api.state?.phase).toBe('reading');
  });

  it('an empty file is refused before any worker starts', async () => {
    const t = setup();
    await act(async () => { await t.api.start(file('empty.docx', new ArrayBuffer(0))); });
    expect(t.workers).toHaveLength(0);
    expect(t.notes.at(-1)).toEqual(['Could not import empty.docx: This file is empty.', 'error']);
    expect(t.api.state).toBeNull();
  });

  it('closing the page area while a read is running ends the worker', async () => {
    const t = setup();
    await act(async () => { void t.api.start(file()); });
    await tick();
    act(() => { root!.unmount(); });
    root = null;
    expect(t.workers[0].terminated).toBe(1);
  });
});
