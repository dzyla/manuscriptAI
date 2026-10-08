// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildWorkspaceJson, HISTORY_IMAGES_OMITTED_NOTE } from './workspaceExport';
import type { HistoryItem } from '../types';

const item = (n: number): HistoryItem => ({
  id: `h${n}`, timestamp: n, originalText: 'a', suggestedText: 'b', suggestionId: `s${n}`, agent: 'editor',
  oldContent: `<p>${n}</p><img data-asset-id="a_x" src="blob:dead">`,
  newContent: `<p>${n}!</p><img data-asset-id="a_x" src="blob:dead">`,
});
const inline = async (html: string) => html.replace('src="blob:dead"', 'src="data:image/png;base64,AAAA"');

describe('buildWorkspaceJson', () => {
  it('inlines everything while under budget, compact JSON, no note', async () => {
    const json = await buildWorkspaceJson({ title: 'T', content: '<p>c</p>' }, [item(1), item(2)], inline);
    expect(json).not.toContain('\n');
    const w = JSON.parse(json);
    expect(w.historyNote).toBeUndefined();
    expect(w.history.map((h: HistoryItem) => h.id)).toEqual(['h1', 'h2']);
    expect(w.history[0].oldContent).toContain('data:image/png');
  });

  it('beyond the budget keeps the newest items inlined, strips image data from older ones and adds a note', async () => {
    const calls: string[] = [];
    const counting = async (html: string) => { calls.push(html); return inline(html); };
    // Budget fits the base plus roughly one inlined item.
    const json = await buildWorkspaceJson({ title: 'T', content: '<p>c</p>' }, [item(1), item(2), item(3)], counting, 150);
    const w = JSON.parse(json);
    expect(w.historyNote).toBe(HISTORY_IMAGES_OMITTED_NOTE);
    expect(w.history.map((h: HistoryItem) => h.id)).toEqual(['h1', 'h2', 'h3']); // order preserved
    expect(w.history[2].oldContent).toContain('data:image/png'); // newest inlined
    expect(w.history[0].oldContent).toContain('data-asset-id="a_x"');
    expect(w.history[0].oldContent).not.toContain('src=');
    expect(w.history[0].oldContent).toContain('<p>1</p>'); // text kept
    expect(calls.length).toBeLessThan(6); // not every item was inlined
  });

  it('inlines sequentially, never concurrently', async () => {
    let active = 0, max = 0;
    const slow = async (html: string) => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 1)); active--; return html; };
    await buildWorkspaceJson({ title: 'T' }, [item(1), item(2), item(3)], slow);
    expect(max).toBe(1);
  });
});
