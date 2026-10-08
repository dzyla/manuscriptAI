// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useDocumentStore } from './useDocumentStore';
import { htmlToDoc } from '../extensions/schema';

beforeEach(async () => {
  await db.delete();
  await db.open();
  useDocumentStore.getState().resetDocument();
});

describe('useDocumentStore (v3)', () => {
  it('fresh install loads NIH defaults without a recovery flag', async () => {
    await useDocumentStore.getState().initialize();
    const s = useDocumentStore.getState();
    expect(s.format.preset).toBe('nih');
    expect(s.lastLoad).toEqual({ migrated: false, recoveredFromBackup: false, unreadableRowPresent: false });
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
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>from editor</p>'));
    await useDocumentStore.getState().persist();
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(JSON.stringify(row?.docJson)).toContain('from editor');
  });

  it('persist falls back to converting content when the editor has not reported yet', async () => {
    useDocumentStore.setState({ docJson: null, content: '<p>only html</p>' });
    await useDocumentStore.getState().persist();
    expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('only html');
  });

  it('format changes persist', async () => {
    const { setFormat } = useDocumentStore.getState();
    const f = structuredClone(useDocumentStore.getState().format);
    f.page.marginsIn.left = 1;
    setFormat(f);
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>x</p>'));
    await useDocumentStore.getState().persist();
    expect((await db.documents.get('current'))?.format?.page.marginsIn.left).toBe(1);
  });
});
