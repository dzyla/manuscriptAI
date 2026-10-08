import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getSpecSchema, getSpecExtensions } from './schemaSpecs';
import { getDocSchema } from './schema';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('worker-safe schema specs', () => {
  it('declares the same nodes and marks as the editor schema', () => {
    const spec = getSpecSchema();
    const editor = getDocSchema();
    expect(Object.keys(spec.nodes).sort()).toEqual(Object.keys(editor.nodes).sort());
    expect(Object.keys(spec.marks).sort()).toEqual(Object.keys(editor.marks).sort());
  });

  it('declares the same attributes for every node', () => {
    const spec = getSpecSchema();
    const editor = getDocSchema();
    for (const name of Object.keys(editor.nodes)) {
      expect(Object.keys(spec.nodes[name].spec.attrs ?? {}).sort(), name)
        .toEqual(Object.keys(editor.nodes[name].spec.attrs ?? {}).sort());
    }
  });

  it('registers no node views', () => {
    for (const ext of getSpecExtensions()) {
      const config = ext as unknown as { config?: Record<string, unknown> };
      expect(config.config?.addNodeView, (ext as { name?: string }).name).toBeUndefined();
    }
  });

  it('pulls in no React and no DOM-only module', () => {
    const src = read('./schemaSpecs.ts');
    expect(src).not.toMatch(/@tiptap\/react|ReactNodeViewRenderer|from 'react'/);
    expect(src).not.toMatch(/\.tsx'/);
  });

  it('src/docx stays free of React and of the editor schema', () => {
    for (const f of ['../docx/preserve/refs.ts', '../docx/preserve/xml.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/@tiptap\/react|from 'react'/);
      expect(src, f).not.toMatch(/extensions\/schema'/);
    }
  });

  it('the repository no longer imports the XML module', () => {
    expect(read('../db/documentRepository.ts')).not.toMatch(/preserve\/xml/);
  });
});
