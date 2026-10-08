// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import type { JSONContent } from '@tiptap/core';
import { ManuscriptDb } from './manuscriptDb';
import { createDexieRepository } from './documentRepository';
import { htmlToDoc, docToHtml, isValidDoc } from '../extensions/schema';
import { IMAGE_NODE, dataUrlToBytes } from './assetStore';
import { LEGACY_V2_ROW, LEGACY_V2_HTML, PNG_1PX } from '../test/fixtures/legacyV2';

/** Replace hydrated image URLs with a placeholder so trees can be compared. */
function withoutImageSrc(doc: JSONContent): JSONContent {
  const walk = (n: JSONContent): JSONContent => {
    const m = n.type === IMAGE_NODE ? { ...n, attrs: { ...n.attrs, src: '<img>', assetId: null } } : n;
    return m.content ? { ...m, content: m.content.map(walk) } : m;
  };
  return walk(doc);
}

function collectImages(doc: JSONContent): JSONContent[] {
  const out: JSONContent[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === IMAGE_NODE) out.push(n);
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

describe('A1 gate: legacy v2 document migrates losslessly', () => {
  it('migrated document equals a direct parse of the legacy HTML, and image bytes survive', async () => {
    const name = 'gate-' + Math.random().toString(36).slice(2);
    const db = new ManuscriptDb(name);
    try {
      await db.documents.put(LEGACY_V2_ROW);
      const repo = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver: { urlFor: r => `url:${r.id}` } });

      const first = await repo.load();
      expect(first.migrated).toBe(true);
      const expected = withoutImageSrc(htmlToDoc(LEGACY_V2_HTML));
      expect(withoutImageSrc(first.doc!.docJson)).toEqual(expected);

      // guard against a vacuous comparison: exact node/mark type names and key attrs must be present
      const nodes: JSONContent[] = [];
      const nodeTypes = new Set<string>();
      const markTypes = new Set<string>();
      const walkAll = (n: JSONContent) => {
        nodes.push(n);
        if (n.type) nodeTypes.add(n.type);
        n.marks?.forEach(m => markTypes.add(m.type));
        n.content?.forEach(walkAll);
      };
      walkAll(first.doc!.docJson);
      for (const t of ['heading', 'paragraph', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock',
        'horizontalRule', 'table', 'tableRow', 'tableHeader', 'tableCell', 'citation', 'figureLabel', IMAGE_NODE]) {
        expect(nodeTypes.has(t), `node ${t}`).toBe(true);
      }
      for (const t of ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link']) {
        expect(markTypes.has(t), `mark ${t}`).toBe(true);
      }
      expect(nodes.find(n => n.type === 'tableHeader')?.attrs?.colspan).toBe(2);
      expect(nodes.find(n => n.type === 'paragraph' && n.attrs?.textAlign === 'justify')).toBeDefined();
      expect(nodes.some(n => n.type === 'listItem' && n.content?.some(c => c.type === 'bulletList'))).toBe(true);

      // image attributes from the v2 renderHTML (style width + data-align) survive
      const images = collectImages(first.doc!.docJson);
      expect(images).toHaveLength(2);
      expect(images[0].attrs?.width).toBe('50%');
      expect(images[0].attrs?.align).toBe('left');
      expect(images[1].attrs?.width).toBe('100%');
      expect(images[1].attrs?.align).toBe('center');

      // metadata carried over
      expect(first.doc).toMatchObject({
        title: LEGACY_V2_ROW.title,
        citationRegistry: LEGACY_V2_ROW.citationRegistry,
        figureRegistry: LEGACY_V2_ROW.figureRegistry,
        mode: 'grant',
        grantInstructions: 'PAR-25-123 notes',
        grantTemplateId: 'nih-r01',
      });

      // both images share one asset with the original bytes
      const assets = await db.assets.toArray();
      expect(assets).toHaveLength(1);
      expect(new Uint8Array(assets[0].data)).toEqual(new Uint8Array(dataUrlToBytes(PNG_1PX).data));

      // second load (no migration) is identical; a save/load cycle is a fixed point
      const second = await repo.load();
      expect(second.migrated).toBe(false);
      expect(second.doc!.docJson).toEqual(first.doc!.docJson);
      await repo.save(second.doc!);
      expect((await repo.load()).doc!.docJson).toEqual(first.doc!.docJson);

      // original HTML retained in the backup ring for recovery
      const backups = await repo.listBackups();
      expect(backups.some(b => b.row.content === LEGACY_V2_HTML)).toBe(true);

      // rendered HTML still carries citations and figure labels for existing App code
      const html = docToHtml(first.doc!.docJson);
      expect(html).toContain('data-citation-node');
      expect(html).toContain('data-source-ids="src-a,src-b"');
      expect(html).toContain('data-figure-label');
      expect(html).toContain('data-figure-id="fig-1"');
    } finally {
      db.close();
      await Dexie.delete(name);
    }
  });

  it('ten save/load cycles cause no drift', async () => {
    const name = 'gate-drift-' + Math.random().toString(36).slice(2);
    const db = new ManuscriptDb(name);
    try {
      await db.documents.put(LEGACY_V2_ROW);
      const repo = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver: { urlFor: r => `url:${r.id}` } });
      const base = (await repo.load()).doc!;
      let cur = base;
      for (let i = 0; i < 10; i++) {
        await repo.save(cur);
        cur = (await repo.load()).doc!;
      }
      expect(cur.docJson).toEqual(base.docJson);
    } finally {
      db.close();
      await Dexie.delete(name);
    }
  });
});
