// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/manuscriptDb';
import { snapshotBeforeImport, isBlankHtml } from './importSafety';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('isBlankHtml', () => {
  it('is true for nothing and for the untouched placeholder, false for any content or an image', () => {
    expect(isBlankHtml('')).toBe(true);
    expect(isBlankHtml('<p></p><p> </p>')).toBe(true);
    expect(isBlankHtml('<p>Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.</p>')).toBe(true);
    expect(isBlankHtml('<p>Start writing your manuscript here and then a great deal of real text follows it: '.padEnd(400, 'x') + '</p>')).toBe(false);
    expect(isBlankHtml('<p>Aims</p>')).toBe(false);
    expect(isBlankHtml('<p></p><img src="data:image/png;base64,AAAA">')).toBe(false);
  });
});

describe('snapshotBeforeImport', () => {
  it('writes a Version History snapshot of the open document that the existing popup lists (name, title, timestamp, html, words)', async () => {
    const snap = await snapshotBeforeImport(db, { title: 'My grant', content: '<h1>Aims</h1><p>three little words</p>', importing: 'plan.docx' });
    expect(snap).not.toBeNull();
    const stored = (await db.versionSnapshots.orderBy('timestamp').reverse().toArray())[0];
    expect(stored).toMatchObject({ name: 'Before importing plan.docx', title: 'My grant' });
    expect(stored.content).toContain('three little words');
    expect(stored.wordCount).toBe(4);
  });

  it('keeps an image\'s bytes in the snapshot (a session blob: URL would be dead after a reload)', async () => {
    await db.assets.put({ id: 'a_1', sha256: 'x', mime: 'image/png', size: 3, data: new Uint8Array([1, 2, 3]).buffer, createdAt: 1 });
    const snap = await snapshotBeforeImport(db, { title: 't', content: '<p>text</p><img data-asset-id="a_1" src="blob:http://x/1">', importing: 'a.docx' });
    expect(snap?.content).toContain('data:image/png;base64,');
    expect(snap?.content).not.toContain('blob:http');
  });

  it('writes nothing for a blank document, and never throws when it cannot write', async () => {
    expect(await snapshotBeforeImport(db, { title: 't', content: '<p></p>', importing: 'a.docx' })).toBeNull();
    expect(await db.versionSnapshots.count()).toBe(0);
    const broken = { versionSnapshots: { put: async () => { throw new Error('quota'); } }, assets: db.assets } as never;
    expect(await snapshotBeforeImport(broken, { title: 't', content: '<p>real</p>', importing: 'a.docx' })).toBeNull();
  });
});
