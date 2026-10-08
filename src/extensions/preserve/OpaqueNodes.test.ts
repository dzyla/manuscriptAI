// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { getSchemaExtensions, getDocSchema, htmlToDoc, docToHtml, normalizeDoc } from '../schema';
import { stampProvenance, isBlockUntouched } from '../../docx/preserve/hash';
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

describe('an imported picture keeps its preserved run unique when it is copied', () => {
  it('a pasted copy of an image gets a fresh fragment id, an image the author inserted (no fragment) is ignored, and a figure paragraph\'s provenance is cleared on the copy', () => {
    const onDuplicateFragment = vi.fn();
    const image: JSONContent = { type: 'resizableImage', attrs: { assetId: 'a_1', fragmentId: 'f9', wrap: 'inline' } };
    const stamped = stampProvenance(normalizeDoc({ type: 'doc', content: [image] }).content![0], 'b5');
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard.configure({ onDuplicateFragment })],
      content: { type: 'doc', content: [stamped, { type: 'resizableImage', attrs: { assetId: 'a_2' } }] },
    });
    editor.commands.insertContentAt(editor.state.doc.content.size, stamped);
    const images: Array<{ fragmentId: string; blockId: string | null }> = [];
    editor.state.doc.forEach(n => n.type.name === 'resizableImage' && images.push({ fragmentId: n.attrs.fragmentId, blockId: n.attrs.ooxml?.blockId ?? null }));
    expect(images).toHaveLength(3);
    expect(new Set(images.map(i => i.fragmentId).filter(Boolean)).size).toBe(2); // f9 and the copy's new id; '' for the inserted one
    expect(onDuplicateFragment).toHaveBeenCalledWith('f9', images[2].fragmentId);
    expect(images.map(i => i.blockId)).toEqual(['b5', null, null]); // the copy cannot claim the paragraph's original XML a second time
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

    // Undoing the split joins the halves back together: the restored paragraph must still be the original.
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    const restored = editor.state.doc.child(0);
    expect(restored.textContent).toBe('Untouched imported text.');
    expect((restored.attrs.ooxml as { blockId?: string } | null)?.blockId).toBe('b1');
    expect(isBlockUntouched(restored.toJSON())).toBe(true);
    editor.destroy();
  });

  it('undo/redo of a split and of a paste keep blockIds unique and the original untouched', () => {
    const para = stampedParagraph('Round trip text.', 'b3');
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard],
      content: { type: 'doc', content: [para] },
    });
    editor.commands.setTextSelection(1);
    editor.commands.splitBlock();
    editor.commands.undo();
    editor.commands.redo();
    expect(editor.state.doc.childCount).toBe(2);
    expect(blockIds(editor)).toEqual([null, 'b3']);
    editor.commands.undo();
    expect(blockIds(editor)).toEqual(['b3']);
    editor.commands.insertContentAt(editor.state.doc.content.size, para);
    expect(blockIds(editor)).toEqual(['b3', null]);
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(1);
    expect(blockIds(editor)).toEqual(['b3']);
    expect(isBlockUntouched(editor.state.doc.child(0).toJSON())).toBe(true);
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
