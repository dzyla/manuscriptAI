// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useAIStore, HISTORY_INLINE_LIMIT } from './useAIStore';
import { dataUrlToBytes, sha256Hex, assetIdFor } from '../db/assetStore';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeEach(async () => {
  await db.delete();
  await db.open();
  useAIStore.setState({ history: [] });
});

describe('useAIStore history persistence (C1)', () => {
  it('persists suggestion history with self-contained images, not session blob: URLs', async () => {
    const { mime, data } = dataUrlToBytes(PNG);
    const sha = await sha256Hex(data);
    const id = assetIdFor(sha);
    await db.assets.put({ id, sha256: sha, mime, size: data.byteLength, data, createdAt: 1 });
    const html = `<p>before</p><img src="blob:http://localhost/dead-after-reload" data-asset-id="${id}">`;
    useAIStore.setState({
      history: [{ id: 'h1', timestamp: 1, oldContent: html, newContent: html.replace('before', 'after'), originalText: 'before', suggestedText: 'after', suggestionId: 's1', agent: 'editor' }],
    });
    await useAIStore.getState().persistHistory();
    const [row] = await db.historyItems.toArray();
    for (const content of [row.oldContent, row.newContent]) {
      expect(content).toContain('src="data:image/png;base64,');
      expect(content).not.toContain('blob:');
    }
    expect(useAIStore.getState().history[0].oldContent).toBe(row.oldContent);
  });

  async function seedAsset() {
    const { mime, data } = dataUrlToBytes(PNG);
    const sha = await sha256Hex(data);
    const id = assetIdFor(sha);
    await db.assets.put({ id, sha256: sha, mime, size: data.byteLength, data, createdAt: 1 });
    return id;
  }
  const item = (n: number, html: string) => ({ id: `h${n}`, timestamp: n, oldContent: html, newContent: html, originalText: 'a', suggestedText: 'b', suggestionId: `s${n}`, agent: 'editor' as const });

  it('inlines image bytes only for the most recent items; older ones keep just the asset id', async () => {
    const id = await seedAsset();
    const html = `<p>x</p><img src="blob:http://localhost/dead" data-asset-id="${id}">`;
    const total = HISTORY_INLINE_LIMIT + 3;
    useAIStore.setState({ history: Array.from({ length: total }, (_, i) => item(i, html)) });
    await useAIStore.getState().persistHistory();
    const rows = await db.historyItems.orderBy('timestamp').toArray();
    expect(rows).toHaveLength(total);
    rows.forEach((r, i) => {
      if (i < 3) {
        expect(r.oldContent).toContain(`data-asset-id="${id}"`);
        expect(r.oldContent).not.toContain('src=');
      } else {
        expect(r.oldContent).toContain('src="data:image/png;base64,');
      }
    });
  });

  it('a failed write keeps the previously stored history instead of emptying the table', async () => {
    useAIStore.setState({ history: [item(1, '<p>one</p>'), item(2, '<p>two</p>')] });
    await useAIStore.getState().persistHistory();
    expect(await db.historyItems.count()).toBe(2);
    const spy = vi.spyOn(db.historyItems, 'bulkPut').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAIStore.setState({ history: [item(1, '<p>one</p>'), item(2, '<p>two</p>'), item(3, '<p>three</p>')] });
    await expect(useAIStore.getState().persistHistory()).resolves.toBeUndefined();
    spy.mockRestore();
    err.mockRestore();
    expect((await db.historyItems.toArray()).map(r => r.id).sort()).toEqual(['h1', 'h2']);
  });
});
