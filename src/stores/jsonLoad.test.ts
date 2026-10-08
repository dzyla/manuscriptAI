// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import { db } from '../db/manuscriptDb';
import { useDocumentStore } from './useDocumentStore';
import { getSchemaExtensions, normalizeDoc } from '../extensions/schema';

/** An attribute the HTML round trip cannot carry: no parseHTML/renderHTML. */
const docWithHiddenAttr = normalizeDoc({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { ooxml: { blockId: 'b1', sourceHash: 'deadbeef' } },
      content: [{ type: 'text', text: 'Imported paragraph.' }],
    },
  ],
});

beforeEach(async () => {
  await db.delete();
  await db.open();
  useDocumentStore.getState().resetDocument();
});

describe('loading the document as JSON', () => {
  it('keeps attributes the HTML round trip would drop', async () => {
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: docWithHiddenAttr, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    const loaded = useDocumentStore.getState().docJson;
    expect(loaded?.content?.[0].attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: 'deadbeef' });
  });

  it('an editor fed the stored JSON reports the same JSON back', () => {
    const editor = new Editor({ extensions: getSchemaExtensions(), content: docWithHiddenAttr });
    expect(editor.getJSON()).toEqual(docWithHiddenAttr);
    editor.destroy();
  });

  it('a save/load cycle after loading is a fixed point', async () => {
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: docWithHiddenAttr, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    await useDocumentStore.getState().persist();
    const row = await db.documents.get('current');
    expect(row?.docJson?.content?.[0].attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: 'deadbeef' });
  });

  it('hands the loaded JSON to the editor; an attribute with no HTML mapping only survives that path', async () => {
    // Stand-in for any attribute that has no HTML mapping (the real styleId and run marks now have one): HTML cannot carry it.
    const HiddenAttr = Extension.create({
      name: 'hiddenAttrForTest',
      addGlobalAttributes() {
        return [{ types: ['paragraph'], attributes: { hiddenForTest: { default: null, rendered: false } } }];
      },
    });
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { hiddenForTest: 'Heading1Like' }, content: [{ type: 'text', text: 'Imported paragraph.' }] }],
    };
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: doc, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    const { pendingDocument, content } = useDocumentStore.getState();
    expect(pendingDocument).toEqual(doc);

    // The pre-fix path: feeding the derived HTML drops the attribute.
    const viaHtml = new Editor({ extensions: [...getSchemaExtensions(), HiddenAttr], content });
    expect(viaHtml.getJSON().content?.[0].attrs?.hiddenForTest).toBeNull();
    viaHtml.destroy();
    // The fixed path: feeding the pending JSON keeps it.
    const viaJson = new Editor({ extensions: [...getSchemaExtensions(), HiddenAttr], content: pendingDocument! });
    expect(viaJson.getJSON().content?.[0].attrs?.hiddenForTest).toBe('Heading1Like');
    viaJson.destroy();

    useDocumentStore.getState().clearPendingDocument();
    expect(useDocumentStore.getState().pendingDocument).toBeNull();
  });

  it('adoptLoadedHtml updates the HTML without marking the document edited', async () => {
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: docWithHiddenAttr, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().adoptLoadedHtml('<p>x</p>');
    expect(useDocumentStore.getState().content).toBe('<p>x</p>');
    expect(useDocumentStore.getState().saveState).toBe('Saved');
  });

  it('a new manuscript clears any pending document', async () => {
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: docWithHiddenAttr, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().resetDocument();
    expect(useDocumentStore.getState().pendingDocument).toBeNull();
  });

  it('migrates legacy [N] citations inside initialize(), before the editor sees the document', async () => {
    await db.documents.put({
      id: 'current', title: 'Legacy', content: '<p>Prior work [1] showed this [2].</p>',
      saveState: 'Saved', citationRegistry: { 'src-a': 1, 'src-b': 2 }, citationCounter: 2, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    } as never);
    await useDocumentStore.getState().initialize();
    const { docJson, pendingDocument, content, saveState } = useDocumentStore.getState();
    const kinds = (n: any): string[] => [n.type, ...(n.content ?? []).flatMap(kinds)];
    expect(kinds(docJson)).toContain('citation');
    expect(pendingDocument).toEqual(docJson);
    expect(content).toContain('data-citation-node');
    // The repository migrated while converting the legacy row, so the stored row is already migrated: no Draft needed.
    expect(saveState).toBe('Saved');
    const stored = await db.documents.get('current');
    expect(JSON.stringify(stored?.docJson)).toContain('"type":"citation"');
  });

  it('a second initialize() (dev StrictMode) of a migrated legacy row yields the same migrated document', async () => {
    await db.documents.put({
      id: 'current', title: 'Legacy', content: '<p>Prior work [1] showed this [2].</p>',
      saveState: 'Saved', citationRegistry: { 'src-a': 1, 'src-b': 2 }, citationCounter: 2, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    } as never);
    await useDocumentStore.getState().initialize();
    const first = useDocumentStore.getState().pendingDocument;
    await useDocumentStore.getState().initialize();
    expect(useDocumentStore.getState().pendingDocument).toEqual(first);
  });

  it('a v3 row with [N] text, a non-empty registry and ooxml provenance is NOT migrated through HTML', async () => {
    const v3 = normalizeDoc({
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { ooxml: { blockId: 'b1', sourceHash: 'deadbeef' } },
        content: [{ type: 'text', text: 'All citation nodes were deleted but the text says [1] and [2].' }],
      }],
    });
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: v3, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: { 'src-a': 1, 'src-b': 2 }, citationCounter: 2, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    const { docJson, pendingDocument, saveState } = useDocumentStore.getState();
    expect(docJson).toEqual(v3);
    expect(pendingDocument).toEqual(v3);
    expect(docJson?.content?.[0].attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: 'deadbeef' });
    expect(JSON.stringify(docJson)).not.toContain('"type":"citation"');
    expect(saveState).toBe('Saved');
  });

  it('a document that already has citation nodes is not re-migrated and keeps its saved state', async () => {
    const withNode = normalizeDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'See ' },
        { type: 'citation', attrs: { sourceIds: ['src-a'], nums: [1] } },
      ] }],
    });
    await db.documents.put({
      id: 'current', title: 'Modern', docJson: withNode, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: { 'src-a': 1 }, citationCounter: 1, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    expect(useDocumentStore.getState().pendingDocument).toEqual(withNode);
    expect(useDocumentStore.getState().saveState).toBe('Saved');
  });
});
