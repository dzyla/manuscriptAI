// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { getSchemaExtensions, getDocSchema, htmlToDoc, docToHtml, normalizeDoc } from '../schema';
import { stampProvenance } from '../../docx/preserve/hash';
import { OpaqueFragmentGuard, findDuplicateFragmentIds, findDuplicateBlockIds } from './OpaqueNodes';

const chip = (id: string) => ({ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: id } });

const stampedParagraph = (text: string, blockId: string): JSONContent => {
  const normalized = normalizeDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  return stampProvenance(normalized.content![0], blockId);
};

const blockIds = (editor: Editor): Array<string | null> => {
  const out: Array<string | null> = [];
  editor.state.doc.forEach(n => out.push(n.attrs.ooxml?.blockId ?? null));
  return out;
};

describe('opaque nodes', () => {
  it('round-trip through HTML with attributes intact', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a ' }, chip('f1')] }] };
    const back = htmlToDoc(docToHtml(doc));
    expect(JSON.stringify(back)).toContain('"fragmentId":"f1"');
    expect(JSON.stringify(back)).toContain('"kind":"equation"');
  });

  it('pasting a copy assigns a fresh fragment id and reports it', () => {
    const onDuplicateFragment = vi.fn();
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard.configure({ onDuplicateFragment })],
      content: { type: 'doc', content: [{ type: 'paragraph', content: [chip('f1')] }] },
    });
    // simulate paste of the same atom
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, chip('f1'));
    const ids: string[] = [];
    editor.state.doc.descendants(n => { if (n.type.name === 'opaqueInline') ids.push(n.attrs.fragmentId); });
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(onDuplicateFragment).toHaveBeenCalledWith('f1', ids.find(i => i !== 'f1'));
    expect(findDuplicateFragmentIds(editor.state.doc)).toEqual([]);
    editor.destroy();
  });
});

describe('block provenance uniqueness', () => {
  it('findDuplicateBlockIds returns positions of 2nd+ occurrences only', () => {
    const doc = getDocSchema().nodeFromJSON({
      type: 'doc',
      content: [stampedParagraph('one', 'b1'), stampedParagraph('two', 'b2'), stampedParagraph('three', 'b1'), stampedParagraph('four', 'b1')],
    });
    const positions: number[] = [];
    doc.forEach((n, offset) => { if (n.textContent === 'three' || n.textContent === 'four') positions.push(offset); });
    expect(findDuplicateBlockIds(doc)).toEqual(positions);
  });

  it('a pasted copy of a stamped block loses its provenance; the original keeps it', () => {
    const para = stampedParagraph('Hello world', 'b1');
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard],
      content: { type: 'doc', content: [para] },
    });
    editor.commands.insertContentAt(editor.state.doc.content.size, para);
    expect(editor.state.doc.childCount).toBe(2);
    expect(blockIds(editor)).toEqual(['b1', null]);
    expect(editor.state.doc.child(1).attrs.ooxml).toBeNull();
    editor.destroy();
  });

  it('splitting a stamped block leaves provenance on the first half only', () => {
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard],
      content: { type: 'doc', content: [stampedParagraph('Hello world', 'b1')] },
    });
    editor.commands.setTextSelection(6); // between "Hello" and " world"
    editor.commands.splitBlock();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe('Hello');
    expect(blockIds(editor)).toEqual(['b1', null]);
    editor.destroy();
  });
});

describe('provenance stays on the untouched copy', () => {
  it('splitting at the start of an imported paragraph keeps provenance on the text', () => {
    const para = stampProvenance(
      normalizeDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Untouched imported text.' }] }] }).content![0],
      'b1',
    );
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard],
      content: { type: 'doc', content: [para] },
    });
    editor.commands.setTextSelection(1); // start of the paragraph's text
    editor.commands.splitBlock();
    const paras: { text: string; blockId: string | null }[] = [];
    editor.state.doc.forEach(node => {
      paras.push({ text: node.textContent, blockId: (node.attrs.ooxml as { blockId?: string } | null)?.blockId ?? null });
    });
    const withText = paras.find(p => p.text.includes('Untouched imported text'));
    const empty = paras.find(p => p.text === '');
    expect(withText?.blockId).toBe('b1');
    expect(empty?.blockId).toBeNull();
    editor.destroy();
  });

  it('a copy pasted above the original does not steal its provenance', () => {
    const para = stampProvenance(
      normalizeDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original imported text.' }] }] }).content![0],
      'b2',
    );
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard],
      content: { type: 'doc', content: [para] },
    });
    editor.commands.insertContentAt(0, { ...para, content: [{ type: 'text', text: 'Original imported text EDITED.' }] });
    const kept: string[] = [];
    editor.state.doc.forEach(node => {
      if ((node.attrs.ooxml as { blockId?: string } | null)?.blockId === 'b2') kept.push(node.textContent);
    });
    expect(kept).toEqual(['Original imported text.']);
    editor.destroy();
  });

  it('survivor choice: first untouched wins; with none or several untouched the first in order wins', () => {
    const edited = (text: string, id: string): JSONContent => ({ ...stampedParagraph('orig', id), content: [{ type: 'text', text }] });
    const positions = (doc: ReturnType<ReturnType<typeof getDocSchema>['nodeFromJSON']>) => {
      const out: number[] = [];
      doc.forEach((_n, offset) => out.push(offset));
      return out;
    };
    const schema = getDocSchema();
    // edited, untouched, edited -> only the middle one survives
    const mid = schema.nodeFromJSON({ type: 'doc', content: [edited('x', 'b1'), stampedParagraph('orig', 'b1'), edited('y', 'b1')] });
    const [p0, p1, p2] = positions(mid);
    expect(findDuplicateBlockIds(mid)).toEqual([p0, p2]);
    expect(p1).toBeGreaterThan(p0);
    // none untouched -> first survives
    const none = schema.nodeFromJSON({ type: 'doc', content: [edited('x', 'b1'), edited('y', 'b1'), edited('z', 'b1')] });
    const [, n1, n2] = positions(none);
    expect(findDuplicateBlockIds(none)).toEqual([n1, n2]);
    // several untouched (identical text) -> first survives
    const many = schema.nodeFromJSON({ type: 'doc', content: [stampedParagraph('orig', 'b1'), stampedParagraph('orig', 'b1'), edited('y', 'b1')] });
    const [, m1, m2] = positions(many);
    expect(findDuplicateBlockIds(many)).toEqual([m1, m2]);
  });
});
