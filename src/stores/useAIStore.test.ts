// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useAIStore } from './useAIStore';
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
});
