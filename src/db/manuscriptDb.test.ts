import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';

describe('ManuscriptDb v6', () => {
  it('has the v6 tables', async () => {
    const db = new ManuscriptDb('t-v4-tables');
    await db.open();
    expect(db.verno).toBe(6);
    for (const t of ['documents', 'assets', 'docxPackages', 'autosaveBackups', 'preservationStores', 'versionSnapshots', 'grantTemplates', 'importBackupParts', 'importReports'])
      expect(db.tables.map(x => x.name)).toContain(t);
    db.close();
    await Dexie.delete('t-v4-tables');
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

  it('upgrades a v4 database without losing a row, a backup or a package', async () => {
    const name = 't-v4-upgrade';
    const v4 = new Dexie(name);
    v4.version(3).stores({
      documents: 'id', sources: 'id, order', chatHistory: 'id, order', suggestions: 'id', historyItems: 'id, timestamp', versionSnapshots: 'id, timestamp',
      grantTemplates: 'id, updatedAt', assets: 'id, sha256', docxPackages: 'documentId', autosaveBackups: '++seq, documentId, savedAt',
    });
    v4.version(4).stores({ preservationStores: 'documentId' });
    await v4.open();
    await v4.table('documents').put({ id: 'current', title: 'kept', saveState: 'Saved', updatedAt: 1 });
    await v4.table('docxPackages').put({ documentId: 'current', original: new ArrayBuffer(3), fileName: 'a.docx', importedAt: 1 });
    await v4.table('autosaveBackups').add({ documentId: 'current', savedAt: 1, row: { id: 'current', title: 'old' } });
    v4.close();
    const db = new ManuscriptDb(name);
    expect((await db.documents.get('current'))?.title).toBe('kept');
    expect((await db.docxPackages.get('current'))?.fileName).toBe('a.docx');
    expect(await db.autosaveBackups.count()).toBe(1);
    expect(await db.importBackupParts.count()).toBe(0);
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
