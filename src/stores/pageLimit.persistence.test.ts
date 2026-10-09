// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useDocumentStore } from './useDocumentStore';
import { readDocx } from '../docx/read';
import { loadDocx } from '../test/docxFixtures';
import { htmlToDoc } from '../extensions/schema';
import { withPageLimit } from '../services/pageLimit';
import { documentPageLimit } from '../components/shell/shellLogic';

vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:test/${Math.random().toString(36).slice(2)}`, revokeObjectURL: () => {} }));

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
  useDocumentStore.getState().resetDocument();
  useDocumentStore.setState({ loadStatus: 'loading', blockedByUnreadable: false });
});

const store = () => useDocumentStore.getState();
const reload = async () => { store().resetDocument(); useDocumentStore.setState({ loadStatus: 'loading' }); await store().initialize(); };

describe('the author\'s page limit, stored on the document\'s format', () => {
  it('is unset on a new document', async () => {
    await store().initialize();
    expect(documentPageLimit(store().format)).toBeNull();
  });

  it('survives a save and a reload, and a change to the limit alone is saved', async () => {
    await store().initialize();
    store().setFormat(withPageLimit(store().format, 13));
    expect(await store().persist()).toBe(true);
    expect((await db.documents.get('current'))!.format.pageLimitPages).toBe(13);
    await reload();
    expect(documentPageLimit(store().format)).toBe(13);
    store().setFormat(withPageLimit(store().format, 12));
    expect(await store().persist()).toBe(true);
    await reload();
    expect(documentPageLimit(store().format)).toBe(12);
    store().setFormat(withPageLimit(store().format, null));
    await store().persist();
    await reload();
    expect(documentPageLimit(store().format)).toBeNull();
  });

  it('is unset after a Word import: the file is a different document whose limit the app does not know', async () => {
    await store().initialize();
    store().setFormat(withPageLimit(store().format, 13));
    await store().persist();
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await store().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    expect(documentPageLimit(store().format)).toBeNull();
    expect((await db.documents.get('current'))!.format.pageLimitPages).toBeUndefined();
    await reload();
    expect(documentPageLimit(store().format)).toBeNull();
  });

  it('restoring the document an import replaced brings back that document\'s own limit', async () => {
    await store().initialize();
    store().setDocJson(htmlToDoc('<p>the draft that gets replaced</p>'));
    store().setFormat(withPageLimit(store().format, 6));
    await store().persist();
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await store().importDocx(r, { title: 'Imported', acceptedHeadings: [] });
    store().setFormat(withPageLimit(store().format, 9));
    await store().persist();
    await store().revertImport();
    expect(documentPageLimit(store().format)).toBe(6);
  });
});
