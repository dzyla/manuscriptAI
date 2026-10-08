// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useDocumentStore, documentRepository } from './useDocumentStore';
import { htmlToDoc } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';
import { readDocx } from '../docx/read';
import { loadDocx } from '../test/docxFixtures';

vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:test/${Math.random().toString(36).slice(2)}`, revokeObjectURL: () => {} }));

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
  useDocumentStore.getState().resetDocument();
  useDocumentStore.setState({ loadStatus: 'loading', blockedByUnreadable: false });
});

const unreadableRow = () => db.documents.put({
  id: 'current', title: 'Broken', saveState: 'Saved',
  docJson: { type: 'doc', content: [{ type: 'hologram' }] },
  citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
} as any);

describe('useDocumentStore (v3)', () => {
  it('fresh install loads NIH defaults without a recovery flag', async () => {
    await useDocumentStore.getState().initialize();
    const s = useDocumentStore.getState();
    expect(s.format.preset).toBe('nih');
    expect(s.lastLoad).toEqual({ migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false });
    expect(s.loadStatus).toBe('ready');
  });

  it('flags an unreadable current row (no backups) and keeps NIH defaults', async () => {
    await db.documents.put({
      id: 'current', title: 'Broken', saveState: 'Saved',
      docJson: { type: 'doc', content: [{ type: 'hologram' }] },
      citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    } as any);
    await useDocumentStore.getState().initialize();
    const s = useDocumentStore.getState();
    expect(s.lastLoad.unreadableRowPresent).toBe(true);
    expect(s.lastLoad.recoveredFromBackup).toBe(false);
    expect(s.format.preset).toBe('nih');
  });

  it('migrates a legacy row: content is derived HTML, docJson is canonical', async () => {
    await db.documents.put({ id: 'current', title: 'Legacy', content: '<h2>Aims</h2><p>old text</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    await useDocumentStore.getState().initialize();
    const s = useDocumentStore.getState();
    expect(s.lastLoad.migrated).toBe(true);
    expect(s.title).toBe('Legacy');
    expect(s.content).toContain('old text');
    expect(JSON.stringify(s.docJson)).toContain('old text');
  });

  it('persist writes docJson from the editor, not HTML', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>from editor</p>'));
    await useDocumentStore.getState().persist();
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(JSON.stringify(row?.docJson)).toContain('from editor');
  });

  it('persist falls back to converting content when the editor has not reported yet', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.setState({ docJson: null, content: '<p>only html</p>' });
    await useDocumentStore.getState().persist();
    expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('only html');
  });

  it('format changes persist', async () => {
    await useDocumentStore.getState().initialize();
    const { setFormat } = useDocumentStore.getState();
    const f = structuredClone(useDocumentStore.getState().format);
    f.page.marginsIn.left = 1;
    setFormat(f);
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>x</p>'));
    await useDocumentStore.getState().persist();
    expect((await db.documents.get('current'))?.format?.page.marginsIn.left).toBe(1);
  });

  describe('C4: never save over a document that was not loaded', () => {
    it('persist before initialize writes nothing', async () => {
      useDocumentStore.getState().setDocJson(htmlToDoc('<p>too early</p>'));
      expect(await useDocumentStore.getState().persist()).toBe(false);
      expect(await db.documents.get('current')).toBeUndefined();
    });

    it('a failed load blocks every save and leaves the stored row untouched', async () => {
      await documentRepository.save({ ...{ title: 'Real', saveState: 'Saved', docJson: htmlToDoc('<p>real grant</p>') }, format: useDocumentStore.getState().format, comments: [], citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, mode: 'grant', grantInstructions: '', grantTemplateId: null });
      const loadSpy = vi.spyOn(documentRepository, 'load').mockRejectedValueOnce(new Error('IDB exploded'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await useDocumentStore.getState().initialize();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      loadSpy.mockRestore();
      expect(useDocumentStore.getState().loadStatus).toBe('failed');
      const backupsBefore = await db.autosaveBackups.count();
      useDocumentStore.getState().setDocJson(htmlToDoc('<p>defaults</p>'));
      for (let i = 0; i < 3; i++) expect(await useDocumentStore.getState().persist()).toBe(false);
      expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('real grant');
      expect(await db.autosaveBackups.count()).toBe(backupsBefore);
    });

    it('a loaded document that cannot be applied to the store counts as a failed load', async () => {
      const bad = { title: 'X', saveState: 'Saved' as const, docJson: { type: 'doc', content: [{ type: 'hologram' }] }, format: useDocumentStore.getState().format, comments: [], citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, mode: 'grant' as const, grantInstructions: '', grantTemplateId: null };
      const loadSpy = vi.spyOn(documentRepository, 'load').mockResolvedValueOnce({ doc: bad, migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await useDocumentStore.getState().initialize();
      errSpy.mockRestore();
      loadSpy.mockRestore();
      expect(useDocumentStore.getState().loadStatus).toBe('failed');
      expect(await useDocumentStore.getState().persist()).toBe(false);
    });

    it('an unreadable row with nothing recovered blocks saving until an explicit replace', async () => {
      await unreadableRow();
      await useDocumentStore.getState().initialize();
      const s = useDocumentStore.getState();
      expect(s.loadStatus).toBe('ready');
      expect(s.blockedByUnreadable).toBe(true);
      expect(s.lastLoad.quarantined).toBe(true);
      s.setDocJson(htmlToDoc('<p>defaults</p>'));
      expect(await s.persist()).toBe(false);
      expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('hologram');
      // Explicit user action (New Manuscript) lifts the block.
      useDocumentStore.getState().resetDocument();
      expect(useDocumentStore.getState().blockedByUnreadable).toBe(false);
      useDocumentStore.getState().setDocJson(htmlToDoc('<p>new work</p>'));
      expect(await useDocumentStore.getState().persist()).toBe(true);
      expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('new work');
    });

    it('allowOverwrite (workspace load / template) lifts the unreadable block', async () => {
      await unreadableRow();
      await useDocumentStore.getState().initialize();
      useDocumentStore.getState().allowOverwrite();
      useDocumentStore.getState().setDocJson(htmlToDoc('<p>loaded workspace</p>'));
      expect(await useDocumentStore.getState().persist()).toBe(true);
    });

    it('allowOverwrite clears a failed load status so a deliberate replacement is written', async () => {
      useDocumentStore.setState({ loadStatus: 'failed' });
      useDocumentStore.getState().setDocJson(htmlToDoc('<p>replacement</p>'));
      expect(await useDocumentStore.getState().persist()).toBe(false);
      expect(await db.documents.get('current')).toBeUndefined();
      useDocumentStore.getState().allowOverwrite();
      expect(useDocumentStore.getState().loadStatus).toBe('ready');
      expect(await useDocumentStore.getState().persist()).toBe(true);
      expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('replacement');
    });

    it('a save requested while a legacy document migrates cannot overwrite it', async () => {
      await db.documents.put({ id: 'current', title: 'Legacy', content: '<p>legacy grant text</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
      const init = useDocumentStore.getState().initialize();
      const early = useDocumentStore.getState().persist(); // e.g. title onBlur before init finished
      await Promise.all([init, early]);
      expect(useDocumentStore.getState().content).toContain('legacy grant text');
      expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('legacy grant text');
      const backups = await db.autosaveBackups.toArray();
      expect(backups).toHaveLength(1); // only the pinned pre-migration row; no defaults in the ring
      expect(backups[0].pinned).toBe(true);
    });
  });
});

describe('useDocumentStore.importDocx', () => {
  const textOf = (n: any): string => (n.type === 'text' ? n.text : (n.content ?? []).map(textOf).join(''));

  it('saves what is on screen first, so the backup of the replaced document holds the latest edits', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>typed since the last autosave</p>'));
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const replaced = (await db.autosaveBackups.toArray()).find(b => b.replacedByImport);
    expect(JSON.stringify(replaced?.row.docJson)).toContain('typed since the last autosave');
  });

  it('does not start when the pre-import save fails, and changes nothing', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>unsaved work</p>'));
    const boom = () => { throw new Error('disk full'); };
    db.documents.hook('creating', boom);
    db.documents.hook('updating', boom);
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    try {
      await expect(useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] })).rejects.toThrow();
    } finally {
      db.documents.hook('creating').unsubscribe(boom);
      db.documents.hook('updating').unsubscribe(boom);
    }
    expect(JSON.stringify(useDocumentStore.getState().docJson)).toContain('unsaved work');
    expect(await db.docxPackages.count()).toBe(0);
    // and a later import is allowed (the in-flight flag was released)
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    expect(useDocumentStore.getState().title).toBe('Imported');
  });

  it('puts the committed document in the store, lifts the unreadable-document block, and leaves no pending document for the editor to re-apply', async () => {
    await unreadableRow();
    await useDocumentStore.getState().initialize();
    expect(useDocumentStore.getState().blockedByUnreadable).toBe(true);
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    const docJson = await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const s = useDocumentStore.getState();
    expect(s.blockedByUnreadable).toBe(false);
    expect(s.loadStatus).toBe('ready');
    expect(s.pendingDocument).toBeNull();
    expect(s.docJson).toBe(docJson);
    expect(s.title).toBe('Imported');
    expect(s.saveState).toBe('Saved');
    expect(s.content).toContain(textOf(r.doc).slice(0, 12));
    expect(await s.persist()).toBe(true); // saving works again
  });

  it('applies exactly the accepted headings: none by default, and only those that are passed', async () => {
    const r = await readDocx(loadDocx('unstyled-sections.docx'), undefined, 'u.docx');
    expect(r.headingCandidates.length).toBeGreaterThan(1);
    await useDocumentStore.getState().initialize();
    const none = await useDocumentStore.getState().importDocx(r, { title: 'x', acceptedHeadings: [] });
    expect((none.content ?? []).filter(n => n.type === 'heading')).toHaveLength(0);
    const two = r.headingCandidates.slice(0, 2);
    const some = await useDocumentStore.getState().importDocx(r, { title: 'x', acceptedHeadings: two });
    expect((some.content ?? []).filter(n => n.type === 'heading').map(textOf)).toEqual(two.map(h => h.text));
    // the result the caller holds was not mutated by applying headings
    expect((r.doc.content ?? []).filter(n => n.type === 'heading')).toHaveLength(0);
  });

  it('autosave cannot write the replaced document back over the import while it is being committed', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>old document</p>'));
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    const pending = useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    // the 30 s autosave (or a title blur) fires right now, with the OLD document still in the store
    const during = await useDocumentStore.getState().persist();
    await pending;
    expect(during).toBe(false);
    expect((await db.documents.get('current'))?.title).toBe('Imported');
    expect(JSON.stringify((await db.documents.get('current'))?.docJson)).not.toContain('old document');
    // once the import is over, saving is back
    expect(await useDocumentStore.getState().persist()).toBe(true);
    expect((await db.documents.get('current'))?.title).toBe('Imported');
  });

  it('refuses a second import while one is running (the first completes, nothing is interleaved)', async () => {
    await useDocumentStore.getState().initialize();
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    const first = useDocumentStore.getState().importDocx(r, { title: 'first', acceptedHeadings: [] });
    await expect(useDocumentStore.getState().importDocx(r, { title: 'second', acceptedHeadings: [] })).rejects.toThrow(/already in progress/);
    await first;
    expect(useDocumentStore.getState().title).toBe('first');
    expect((await db.documents.get('current'))?.title).toBe('first');
  });

  it('does not run while the stored document is still loading (the load could finish second and replace the import)', async () => {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    useDocumentStore.setState({ loadStatus: 'loading' });
    await expect(useDocumentStore.getState().importDocx(r, { title: 'x', acceptedHeadings: [] })).rejects.toThrow(/still loading/);
    expect(await db.documents.count()).toBe(0);
    // and the refusal did not leave the in-flight flag set
    useDocumentStore.setState({ loadStatus: 'ready' });
    await useDocumentStore.getState().importDocx(r, { title: 'x', acceptedHeadings: [] });
    expect((await db.documents.get('current'))?.title).toBe('x');
  });

  it('a failed import leaves the document in the store and on disk as it was', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>mine</p>'));
    await useDocumentStore.getState().persist();
    const before = await db.documents.get('current');
    const r = await readDocx(loadDocx('images.docx'), undefined, 'images.docx');
    const boom = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    db.assets.hook('creating', boom);
    try {
      await expect(useDocumentStore.getState().importDocx(r, { title: 'doomed', acceptedHeadings: [] })).rejects.toThrow();
    } finally {
      db.assets.hook('creating').unsubscribe(boom);
    }
    expect(await db.documents.get('current')).toEqual(before);
    expect(useDocumentStore.getState().title).not.toBe('doomed');
    expect(JSON.stringify(useDocumentStore.getState().docJson)).toContain('mine');
    expect(await db.docxPackages.count()).toBe(0);
    expect(await db.assets.count()).toBe(0);
  });
});

describe('useDocumentStore after an import: the whole store follows the committed row', () => {
  const NIH = createFormat('nih');

  it('every field equals what was loaded, none keeps the replaced document\'s value, and the next autosave does not undo the import', async () => {
    await useDocumentStore.getState().initialize();
    // a document that HAS comments, registries, a mode and a template: a reset that did nothing could not pass
    useDocumentStore.setState({
      title: 'Old title', docJson: htmlToDoc('<p>old work</p>'), format: { ...NIH, defaults: { ...NIH.defaults, fontFamily: 'Papyrus', fontSizePt: 17 } },
      comments: [{ id: 'c1', quote: 'old', messages: [] } as never], citationRegistry: { s1: 1, s2: 2 }, citationCounter: 2,
      figureRegistry: { f1: 1 }, figureCounter: 1, mode: 'grant', grantInstructions: 'funder says 12 pages', grantTemplateId: 'r01',
    });
    const r = await readDocx(loadDocx('images.docx'), undefined, 'images.docx');
    const returned = await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const s = useDocumentStore.getState();
    const row = (await db.documents.get('current'))!;
    const loaded = (await documentRepository.load()).doc!;

    expect(s.title).toBe('Imported');
    expect(s.format).toEqual(r.format);
    expect(s.format.defaults.fontFamily).not.toBe('Papyrus');
    expect(s.format).toEqual(row.format);
    expect(s.comments).toEqual([]);
    expect(s.citationRegistry).toEqual({});
    expect(s.citationCounter).toBe(0);
    expect(s.figureRegistry).toEqual({});
    expect(s.figureCounter).toBe(0);
    expect(s.mode).toBe('grant'); // carried over: how the author works
    expect(s.grantInstructions).toBe('funder says 12 pages');
    expect(s.grantTemplateId).toBeNull(); // belonged to the replaced document
    expect(s.saveState).toBe('Saved');
    expect(s.loadStatus).toBe('ready');
    expect(s.blockedByUnreadable).toBe(false);
    expect(s.pendingDocument).toBeNull();
    expect(s.importId).toBe(row.importId);
    expect(s.importId).toBeTruthy();
    expect(s.lastLoad).toEqual({ migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false });
    expect(s.docJson).toBe(returned);
    expect(s.docJson).toEqual(loaded.docJson);

    // the regression this guards: the next autosave must write the imported format, not the replaced one
    expect(await useDocumentStore.getState().persist()).toBe(true);
    const after = (await db.documents.get('current'))!;
    expect(after.format).toEqual(r.format);
    expect(after.title).toBe('Imported');
    expect(after.importId).toBe(row.importId);
    expect((await db.docxPackages.get('current'))?.importId).toBe(row.importId);
  });

  it('an import is a deliberate replacement: it also recovers a store whose load had failed', async () => {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    useDocumentStore.setState({ loadStatus: 'failed' });
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    expect(useDocumentStore.getState().loadStatus).toBe('ready');
    expect(await useDocumentStore.getState().persist()).toBe(true);
  });

  it('if the committed document cannot be read back, the store still follows the disk (the next autosave must not write the old document over the import)', async () => {
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>old work</p>'));
    useDocumentStore.setState({ title: 'Old title', grantTemplateId: 'r01', mode: 'grant', grantInstructions: 'keep me' });
    const r = await readDocx(loadDocx('images.docx'), undefined, 'images.docx');
    vi.spyOn(documentRepository, 'load').mockRejectedValueOnce(new Error('read failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const s = useDocumentStore.getState();
    expect(s.title).toBe('Imported');
    expect(s.format).toEqual(r.format);
    expect(s.importId).toBe((await db.documents.get('current'))?.importId);
    // the replaced document's template must not be re-attached by the next autosave; how the author works carries over, as on disk
    expect(s.grantTemplateId).toBeNull();
    expect(s.mode).toBe('grant');
    expect(s.grantInstructions).toBe('keep me');
    expect(JSON.stringify(s.docJson)).not.toContain('old work');
    expect(s.loadStatus).toBe('ready');
    // images are usable in the editor straight away
    const imgs: any[] = [];
    const walk = (n: any) => { if (n.type === 'resizableImage') imgs.push(n); (n.content ?? []).forEach(walk); };
    walk(doc);
    for (const i of imgs.filter(i => i.attrs.assetId)) expect(i.attrs.src).toMatch(/^blob:/);
    // and an autosave keeps the import
    expect(await s.persist()).toBe(true);
    const row = (await db.documents.get('current'))!;
    expect(row.title).toBe('Imported');
    expect(row.importId).toBe((await db.docxPackages.get('current'))?.importId);
    expect(row.format).toEqual(r.format);
    expect(row.grantTemplateId).toBeUndefined();
    expect(row.mode).toBe('grant');
  });

  it('a pasted preserved piece is stored with the save of the document that holds it, then forgotten; replacing the document drops what was pending', async () => {
    const r = await readDocx(loadDocx('opaque.docx'), undefined, 'opaque.docx');
    await useDocumentStore.getState().initialize();
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const docJson = useDocumentStore.getState().docJson!;
    const ids: string[] = [];
    const walk = (n: any) => { if (n.attrs?.fragmentId) ids.push(n.attrs.fragmentId); (n.content ?? []).forEach(walk); };
    walk(docJson);
    const fromId = ids[0];
    // the editor pastes a copy: a document with a second atom under a new id, and tells the store
    const paste = (n: any): any => {
      const kids = n.content ? { content: n.content.flatMap((c: any) => (c.attrs?.fragmentId === fromId ? [paste(c), { ...c, attrs: { ...c.attrs, fragmentId: 'f_pasted' } }] : [paste(c)])) } : {};
      return { ...n, ...kids };
    };
    useDocumentStore.getState().setDocJson(paste(docJson));
    useDocumentStore.getState().queueFragmentClone(fromId, 'f_pasted');
    expect((await db.preservationStores.get('current'))!.store.fragments.f_pasted).toBeUndefined(); // not before a save
    expect(await useDocumentStore.getState().persist()).toBe(true);
    const frag = (await db.preservationStores.get('current'))!.store.fragments;
    expect(frag.f_pasted).toEqual(frag[fromId]);
    // forgotten once written: a later save does not need it again
    useDocumentStore.getState().setTitle('later');
    await useDocumentStore.getState().persist();
    expect((await db.preservationStores.get('current'))!.store.fragments.f_pasted).toEqual(frag[fromId]);

    // clones queued for a document that is then replaced are not applied to the next one
    useDocumentStore.getState().queueFragmentClone(fromId, 'f_stale');
    useDocumentStore.getState().resetDocument();
    await db.docxPackages.clear();
    await useDocumentStore.getState().persist();
    expect(await db.preservationStores.get('current')).toBeUndefined();
  });

  it('a copy queued while an import is committing belongs to the document being replaced and is not sent with the first save of the import', async () => {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await useDocumentStore.getState().initialize();
    const real = documentRepository.importDocx.bind(documentRepository);
    vi.spyOn(documentRepository, 'importDocx').mockImplementation(async (...a) => {
      useDocumentStore.getState().queueFragmentClone('f_old', 'f_stale'); // pasted into the old document, mid-commit
      return real(...a);
    });
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const save = vi.spyOn(documentRepository, 'save');
    useDocumentStore.getState().setTitle('edited');
    await useDocumentStore.getState().persist();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].fragmentClones).toBeUndefined();
  });

  it('every flow that replaces the document with something that is not the import detaches the package: New Manuscript, a workspace file, a template, a text import', async () => {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    const flows: Array<[string, () => void]> = [
      ['New Manuscript (resetDocument)', () => useDocumentStore.getState().resetDocument()],
      ['workspace file / template / text import (allowOverwrite after setting the content)', () => {
        useDocumentStore.getState().setDocJson(htmlToDoc('<p>the replacement</p>'));
        useDocumentStore.getState().allowOverwrite();
      }],
    ];
    for (const [name, replace] of flows) {
      await db.delete();
      await db.open();
      useDocumentStore.getState().resetDocument();
      useDocumentStore.setState({ loadStatus: 'loading' });
      await useDocumentStore.getState().initialize();
      await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
      const { importId } = (await db.documents.get('current'))!;
      expect(await db.docxPackages.get('current'), name).toBeDefined();
      replace();
      expect(useDocumentStore.getState().importId, name).toBeNull();
      useDocumentStore.setState({ docJson: htmlToDoc('<p>the replacement</p>') });
      expect(await useDocumentStore.getState().persist(), name).toBe(true);
      expect((await db.documents.get('current'))?.importId, name).toBeUndefined();
      expect(await db.docxPackages.get('current'), name).toBeUndefined();
      expect(await db.preservationStores.get('current'), name).toBeUndefined();
      const old = (await db.autosaveBackups.toArray()).find(b => b.row.importId === importId)!;
      expect((await db.importBackupParts.get(old.seq!))?.package?.fileName, name).toBe('body-basics.docx');
    }
  });

  it('restoring a Version History snapshot after an import (replaceWithHtml) detaches the package, and saves the snapshot\'s text, not the import\'s', async () => {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await useDocumentStore.getState().initialize();
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const { importId } = (await db.documents.get('current'))!;
    expect(await db.docxPackages.get('current')).toBeDefined();

    // what handleRestoreSnapshot does: the stored HTML of the pre-import document replaces the open one
    useDocumentStore.getState().replaceWithHtml('Before the import', '<h2>Aims</h2><p>the text from before the import</p>');
    const s = useDocumentStore.getState();
    expect(s.importId).toBeNull();
    expect(s.title).toBe('Before the import');
    expect(s.saveState).toBe('Draft');
    expect(s.docJson).toBeNull(); // the import's JSON must not be saved under the snapshot's text
    expect(await s.persist()).toBe(true);

    const row = (await db.documents.get('current'))!;
    expect(row.title).toBe('Before the import');
    expect(JSON.stringify(row.docJson)).toContain('the text from before the import');
    expect(JSON.stringify(row.docJson)).not.toContain('Aims Overview'); // the import's own text
    expect(row.importId).toBeUndefined();
    expect(await db.docxPackages.get('current')).toBeUndefined();
    expect(await db.preservationStores.get('current')).toBeUndefined();
    const old = (await db.autosaveBackups.toArray()).find(b => b.row.importId === importId)!;
    expect((await db.importBackupParts.get(old.seq!))?.package?.fileName).toBe('body-basics.docx');
  });

  it('replaceWithHtml also lifts the unreadable-document block, like any deliberate replacement', async () => {
    await unreadableRow();
    await useDocumentStore.getState().initialize();
    expect(useDocumentStore.getState().blockedByUnreadable).toBe(true);
    useDocumentStore.getState().replaceWithHtml('Snapshot', '<p>restored</p>');
    expect(useDocumentStore.getState().blockedByUnreadable).toBe(false);
    expect(await useDocumentStore.getState().persist()).toBe(true);
  });

  it('a document loaded from disk keeps its import: reload, edit, autosave', async () => {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await useDocumentStore.getState().initialize();
    await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    const { importId } = (await db.documents.get('current'))!;
    useDocumentStore.getState().resetDocument();
    useDocumentStore.setState({ loadStatus: 'loading' });
    await useDocumentStore.getState().initialize(); // "reload the page"
    expect(useDocumentStore.getState().importId).toBe(importId);
    useDocumentStore.getState().setTitle('edited after reload');
    await useDocumentStore.getState().persist();
    expect((await db.documents.get('current'))?.importId).toBe(importId);
    expect(await db.docxPackages.get('current')).toBeDefined();
  });

  describe('revertImport', () => {
    it('saves first, swaps the documents, updates every field, and a second call brings the import back', async () => {
      await useDocumentStore.getState().initialize();
      useDocumentStore.setState({ title: 'My work', docJson: htmlToDoc('<p>my own words</p>'), mode: 'grant', grantInstructions: 'g' });
      const r = await readDocx(loadDocx('images.docx'), undefined, 'images.docx');
      await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
      useDocumentStore.getState().setTitle('Imported, then edited'); // unsaved edit to the import
      useDocumentStore.getState().setMode('manuscript'); // the import's row now differs from the replaced one in how the author works...
      useDocumentStore.getState().setGrantInstructions('other');

      const doc = await useDocumentStore.getState().revertImport();
      let s = useDocumentStore.getState();
      expect(s.title).toBe('My work');
      expect(JSON.stringify(doc)).toContain('my own words');
      expect(s.docJson).toBe(doc);
      expect(s.importId).toBeNull();
      expect(s.loadStatus).toBe('ready');
      expect(s.mode).toBe('grant'); // ...and the restored document brings back its own
      expect(s.grantInstructions).toBe('g');
      expect(await db.docxPackages.get('current')).toBeUndefined();
      // the unsaved edit to the import was saved first and is what comes back with the second call
      await useDocumentStore.getState().revertImport();
      s = useDocumentStore.getState();
      expect(s.title).toBe('Imported, then edited');
      expect(s.importId).toBe((await db.docxPackages.get('current'))?.importId);
      expect(s.format).toEqual(r.format);
    });

    it('autosave is suspended while it runs, and with nothing to restore it rejects and changes nothing', async () => {
      await useDocumentStore.getState().initialize();
      await expect(useDocumentStore.getState().revertImport()).rejects.toThrow();
      expect(useDocumentStore.getState().loadStatus).toBe('ready');
      useDocumentStore.setState({ title: 'My work', docJson: htmlToDoc('<p>my own words</p>') });
      const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
      await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
      const pending = useDocumentStore.getState().revertImport();
      expect(await useDocumentStore.getState().persist()).toBe(false);
      await pending;
      expect((await db.documents.get('current'))?.title).toBe('My work');
    });

    it('if the restored document cannot be read back it says so and stops autosaving rather than guessing', async () => {
      await useDocumentStore.getState().initialize();
      useDocumentStore.setState({ title: 'My work', docJson: htmlToDoc('<p>my own words</p>') });
      const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
      await useDocumentStore.getState().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
      vi.spyOn(documentRepository, 'load').mockRejectedValueOnce(new Error('read failed'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(useDocumentStore.getState().revertImport()).rejects.toThrow(/could not be read back/);
      expect(useDocumentStore.getState().loadStatus).toBe('failed');
      expect(await useDocumentStore.getState().persist()).toBe(false); // the old import in memory is not written over the restored row
      expect((await db.documents.get('current'))?.title).toBe('My work');
    });
  });
});
