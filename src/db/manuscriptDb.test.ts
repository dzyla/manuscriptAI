import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';

describe('ManuscriptDb v3', () => {
  it('has the v3 tables', async () => {
    const db = new ManuscriptDb('t-v3-tables');
    await db.open();
    expect(db.verno).toBe(3);
    for (const t of ['documents', 'assets', 'docxPackages', 'autosaveBackups', 'versionSnapshots', 'grantTemplates'])
      expect(db.tables.map(x => x.name)).toContain(t);
    db.close();
    await Dexie.delete('t-v3-tables');
  });

  it('upgrades a v2 database without losing the document row', async () => {
    const name = 't-v2-upgrade';
    const v2 = new Dexie(name);
    v2.version(1).stores({ documents: 'id', sources: 'id, order', chatHistory: 'id, order', suggestions: 'id', historyItems: 'id, timestamp', versionSnapshots: 'id, timestamp' });
    v2.version(2).stores({ grantTemplates: 'id, updatedAt' });
    await v2.open();
    await v2.table('documents').put({ id: 'current', title: 'Legacy', content: '<p>old</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    v2.close();

    const db = new ManuscriptDb(name);
    const row = await db.documents.get('current');
    expect(row?.content).toBe('<p>old</p>');
    expect(row?.title).toBe('Legacy');
    db.close();
    await Dexie.delete(name);
  });

  it('autosaveBackups auto-increments seq', async () => {
    const db = new ManuscriptDb('t-backups');
    const a = await db.autosaveBackups.add({ documentId: 'current', savedAt: 1, row: { id: 'current', title: 'a', saveState: 'Draft', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 } });
    const b = await db.autosaveBackups.add({ documentId: 'current', savedAt: 2, row: { id: 'current', title: 'b', saveState: 'Draft', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 2 } });
    expect(Number(b)).toBeGreaterThan(Number(a));
    db.close();
    await Dexie.delete('t-backups');
  });
});
