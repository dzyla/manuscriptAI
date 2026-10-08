import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

  it('keeps every spec and preserve module free of React, node views and .tsx imports', () => {
    const files = ['./specs/', './preserve/'].flatMap(dir =>
      readdirSync(new URL(dir, import.meta.url))
        .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
        .map(f => dir + f),
    );
    // guard against a vacuous scan: the directories really do hold the modules this protects
    expect(files).toEqual(expect.arrayContaining(['./specs/citation.ts', './specs/pageBreak.ts', './specs/runMarks.ts', './preserve/OpaqueNodes.ts']));
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/@tiptap\/react|ReactNodeViewRenderer|from 'react'|addNodeView/);
      expect(src, f).not.toMatch(/\.tsx'/);
    }
  });

  it('src/docx stays free of React, DOM globals and the editor schema (it must run in a worker)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${dir}${e.name}`] : [],
      );
    const files = walk('../docx/');
    expect(files).toEqual(expect.arrayContaining(['../docx/preserve/refs.ts', '../docx/preserve/xml.ts', '../docx/read/runs.ts', '../docx/read/paragraphs.ts']));
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/@tiptap\/react|from 'react'/);
      expect(src, f).not.toMatch(/extensions\/schema'/);
      expect(src, f).not.toMatch(/\bwindow\.|\bdocument\.(create|get|query)|new Blob\(|localStorage/);
    }
  });

  it('the repository no longer imports the XML module', () => {
    expect(read('../db/documentRepository.ts')).not.toMatch(/preserve\/xml/);
  });
});
