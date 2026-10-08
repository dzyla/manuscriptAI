// @vitest-environment jsdom
/**
 * The real Editor, with an imported Word document in it, through the production prop sequence: the document is handed over, then the
 * suggestion list changes (every confirmed import does this: it clears the list with a NEW array). Nothing the list does may touch the
 * document: Word's own highlighting and every paragraph's provenance must survive.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JSONContent } from '@tiptap/core';
import Editor, { type EditorRef } from './Editor';
import type { Suggestion } from '../types';
import { readDocx, type ImportResult } from '../docx/read';
import { isBlockUntouched } from '../docx/preserve/hash';
import { loadDocx } from '../test/docxFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => { root?.unmount(); }); host?.remove(); root = null; host = null; });

const walk = (n: JSONContent, fn: (x: JSONContent) => void): void => { fn(n); (n.content ?? []).forEach(c => walk(c, fn)); };
const highlightMarks = (doc: JSONContent): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = [];
  walk(doc, n => { for (const m of n.marks ?? []) if (m.type === 'highlight') out.push(m.attrs ?? {}); });
  return out;
};
const allMarkTypes = (doc: JSONContent): string[] => {
  const out = new Set<string>();
  walk(doc, n => { for (const m of n.marks ?? []) out.add(m.type); });
  return [...out].sort();
};
const sugg = (id: string, originalText: string): Suggestion => ({ id, originalText, suggestedText: 'x', explanation: '', agent: 'editor', startIndex: 0, endIndex: 0 });

let imported: ImportResult;
beforeAll(async () => { imported = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx'); });

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const ref = createRef<EditorRef>();
  const duplicates: Array<[string, string]> = [];
  const render = (suggestions: Suggestion[], extra: { onDuplicateFragment?: (a: string, b: string) => void } = {}) => act(() => {
    root!.render(
      <Editor
        ref={ref}
        content="<p>x</p>"
        suggestions={suggestions}
        onSuggestionClick={() => {}}
        onChange={() => {}}
        onDocChange={() => {}}
        onDuplicateFragment={extra.onDuplicateFragment ?? ((a, b) => { duplicates.push([a, b]); })}
      />,
    );
  });
  const editor = () => (host!.querySelector('.ProseMirror') as unknown as { editor: import('@tiptap/core').Editor }).editor;
  return { ref, render, editor, duplicates };
}

describe('an imported document in the real Editor', () => {
  it('starts with Word\'s highlight mark and every block untouched (the premise of the next tests)', () => {
    const { ref, render, editor } = mount();
    render([]);
    act(() => { ref.current!.setDocument(imported.doc); });
    const json = editor().getJSON();
    expect(highlightMarks(json)).toEqual([{ color: '#ffff00' }]);
    const blocks = json.content ?? [];
    expect(blocks.length).toBeGreaterThan(5);
    for (const [i, b] of blocks.entries()) if (b.attrs?.ooxml) expect(isBlockUntouched(b), `block ${i} (${b.type}) before any suggestion change`).toBe(true);
  });

  it('a NEW suggestions array (what every confirmed import pushes) leaves Word\'s highlighting and every block\'s provenance alone', () => {
    const { ref, render, editor } = mount();
    render([sugg('s0', 'nothing matches this')]);
    act(() => { ref.current!.setDocument(imported.doc); });
    const before = JSON.stringify(editor().getJSON());
    render([]);
    render([]);
    const after = editor().getJSON();
    expect(JSON.stringify(after)).toBe(before);
    expect(highlightMarks(after)).toEqual([{ color: '#ffff00' }]);
    for (const b of after.content ?? []) if (b.attrs?.ooxml) expect(isBlockUntouched(b)).toBe(true);
  });

  it('suggestions are drawn without writing anything into the document: no mark, no changed block, none saved', () => {
    const { ref, render, editor } = mount();
    render([]);
    act(() => { ref.current!.setDocument(imported.doc); });
    const before = JSON.stringify(editor().getJSON());
    render([sugg('s1', 'Background Section'), sugg('s2', 'emphaticword')]);
    expect(host!.querySelectorAll('.ProseMirror mark').length).toBeGreaterThanOrEqual(2); // drawn (Word's own highlight is a mark too)
    expect(editor().getHTML()).not.toMatch(/background-color: #[0-9a-f]{8}/i); // the suggestion colours are not in the document
    expect(JSON.stringify(editor().getJSON())).toBe(before);
    expect(allMarkTypes(editor().getJSON())).not.toContain('suggestion');
    // and clearing them removes exactly the drawn ones
    const withAi = host!.querySelectorAll('.ProseMirror mark').length;
    render([]);
    expect(host!.querySelectorAll('.ProseMirror mark').length).toBe(withAi - 2);
    expect(JSON.stringify(editor().getJSON())).toBe(before);
  });

  it('a drawn suggestion follows an edit before it, and drawing it does not enter the undo history', () => {
    const { ref, render, editor } = mount();
    render([]);
    act(() => { ref.current!.setDocument(imported.doc); });
    render([sugg('s1', 'Background Section')]);
    const mark = () => Array.from(host!.querySelectorAll('.ProseMirror mark')).find(m => m.textContent === 'Background Section');
    expect(mark()).toBeTruthy();
    act(() => { editor().commands.insertContentAt(1, 'NEW '); });
    expect(mark()).toBeTruthy(); // mapped through the edit, still on the same words
    act(() => { editor().commands.undo(); });
    expect((editor().getJSON().content?.[0].content?.[0] as { text?: string }).text).toBe('Aims Overview');
  });
});

describe('copying a preserved piece (the Editor must tell its owner)', () => {
  const doc: JSONContent = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see ' }, { type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f_orig' } }, { type: 'text', text: ' here' }] }],
  };

  it('reports (original id, new id) when a paste duplicates an equation, and the pasted copy carries the new id', () => {
    const { ref, render, editor, duplicates } = mount();
    render([]);
    act(() => { ref.current!.setDocument(doc); });
    expect(duplicates).toEqual([]);
    act(() => { editor().commands.insertContentAt(2, { type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f_orig' } }); });
    expect(duplicates).toHaveLength(1);
    const [from, to] = duplicates[0];
    expect(from).toBe('f_orig');
    expect(to).toMatch(/^f_/);
    expect(to).not.toBe('f_orig');
    const ids: string[] = [];
    walk(editor().getJSON(), n => { if (n.type === 'opaqueInline') ids.push(String(n.attrs?.fragmentId)); });
    expect(ids.sort()).toEqual(['f_orig', to].sort());
  });

  it('also for a picture lifted from a Word paragraph, and uses the latest callback the owner passed', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { ref, render, editor } = mount();
    render([], { onDuplicateFragment: first });
    const pic: JSONContent = { type: 'resizableImage', attrs: { src: null, assetId: 'a_1', fragmentId: 'f_pic' } };
    act(() => { ref.current!.setDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, pic] }); });
    render([], { onDuplicateFragment: second });
    act(() => { editor().commands.insertContentAt(editor().state.doc.content.size, pic); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toBe('f_pic');
  });
});

// The author's own document (gitignored): Word's highlighting must come through the suggestion-list change that every import triggers.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
describe.skipIf(!existsSync(join(process.cwd(), 'fixtures/private/r01.docx')))('r01.docx (private) in the real Editor', () => {
  it('keeps all of its Word highlighting (34 marks in 22 paragraphs) and every untouched paragraph untouched when the suggestion list changes', { timeout: 120_000 }, async () => {
    const r01 = await readDocx(loadDocx('r01.docx', 'private'), undefined, 'r01.docx');
    const marksIn = (doc: JSONContent) => {
      let marks = 0;
      let paragraphs = 0;
      for (const b of doc.content ?? []) {
        let here = 0;
        walk(b, n => { for (const m of n.marks ?? []) if (m.type === 'highlight') here++; });
        marks += here;
        if (here) paragraphs++;
      }
      return { marks, paragraphs };
    };
    expect(marksIn(r01.doc)).toEqual({ marks: 34, paragraphs: 22 }); // what the reader produced
    const { ref, render, editor } = mount();
    render([]);
    act(() => { ref.current!.setDocument(r01.doc); });
    const untouched = (doc: JSONContent) => (doc.content ?? []).filter(b => b.attrs?.ooxml && isBlockUntouched(b)).length;
    const before = { marks: marksIn(editor().getJSON()), untouched: untouched(editor().getJSON()) };
    expect(before.marks).toEqual({ marks: 34, paragraphs: 22 });
    render([]); // the new array an import pushes
    render([sugg('s1', 'zzz not in the document')]);
    const after = editor().getJSON();
    expect(marksIn(after)).toEqual({ marks: 34, paragraphs: 22 });
    expect(untouched(after)).toBe(before.untouched);
    expect(untouched(after)).toBe((r01.doc.content ?? []).filter(b => b.attrs?.ooxml && isBlockUntouched(b)).length);
    console.log(`[a2 b1] r01 in the real Editor: ${marksIn(after).marks} highlight marks in ${marksIn(after).paragraphs} paragraphs, ${untouched(after)} untouched provenance blocks, before and after the suggestion change`);
  });
});
