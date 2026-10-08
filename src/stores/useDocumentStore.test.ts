// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useDocumentStore, documentRepository } from './useDocumentStore';
import { htmlToDoc } from '../extensions/schema';

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
