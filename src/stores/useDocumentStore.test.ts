// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useDocumentStore, documentRepository } from './useDocumentStore';
import { htmlToDoc } from '../extensions/schema';
import { readDocx } from '../docx/read';
import { loadDocx } from '../test/docxFixtures';

beforeEach(async () => {
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
