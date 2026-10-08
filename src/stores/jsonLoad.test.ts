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
    // Stand-in for the style ids / run properties later A2a tasks add: no parseHTML/renderHTML.
    const HiddenAttr = Extension.create({
      name: 'hiddenAttrForTest',
      addGlobalAttributes() {
        return [{ types: ['paragraph'], attributes: { styleId: { default: null } } }];
      },
    });
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { styleId: 'Heading1Like' }, content: [{ type: 'text', text: 'Imported paragraph.' }] }],
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
    expect(viaHtml.getJSON().content?.[0].attrs?.styleId).toBeNull();
    viaHtml.destroy();
    // The fixed path: feeding the pending JSON keeps it.
    const viaJson = new Editor({ extensions: [...getSchemaExtensions(), HiddenAttr], content: pendingDocument! });
    expect(viaJson.getJSON().content?.[0].attrs?.styleId).toBe('Heading1Like');
    viaJson.destroy();

    useDocumentStore.getState().clearPendingDocument();
    expect(useDocumentStore.getState().pendingDocument).toBeNull();
  });

  it('syncDerivedContent updates the HTML without marking the document edited', async () => {
    await db.documents.put({
      id: 'current', title: 'Imported', docJson: docWithHiddenAttr, schemaVersion: 3,
      saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
    });
    await useDocumentStore.getState().initialize();
    useDocumentStore.getState().syncDerivedContent('<p>x</p>');
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
});
