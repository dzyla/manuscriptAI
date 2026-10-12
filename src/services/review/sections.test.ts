import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { sectionMap, normalizeHeading, classifyHeading, slugify } from './sections';

const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: text ? [{ type: 'text', text }] : [] });
const p = (...parts: (string | JSONContent)[]): JSONContent => ({
  type: 'paragraph',
  content: parts.filter(x => x !== '').map(x => (typeof x === 'string' ? { type: 'text', text: x } : x)),
});
const cite = (...nums: number[]): JSONContent => ({ type: 'citation', attrs: { sourceIds: nums.map(n => `s${n}`), nums } });
const doc = (...content: JSONContent[]) => getSpecSchema().nodeFromJSON({ type: 'doc', content });

describe('normalizeHeading', () => {
  it('lowercases and strips outline numbering', () => {
    expect(normalizeHeading('C.2 Approach')).toBe('approach');
    expect(normalizeHeading('A. Significance')).toBe('significance');
    expect(normalizeHeading('1 Introduction')).toBe('introduction');
    expect(normalizeHeading('2.1. Materials and Methods')).toBe('materials and methods');
    expect(normalizeHeading('IV) Discussion')).toBe('discussion');
  });

  it('keeps the slash in "Project Summary / Abstract" and folds ampersands', () => {
    expect(normalizeHeading('Project Summary / Abstract')).toBe('project summary / abstract');
    expect(normalizeHeading('Background & Significance')).toBe('background and significance');
  });

  it('pads the slash so the unspaced NIH spelling normalizes the same way', () => {
    expect(normalizeHeading('Project Summary/Abstract')).toBe('project summary / abstract');
  });

  it('does not strip a word that merely starts the title', () => {
    expect(normalizeHeading('Aim 1: Define gating')).toBe('aim 1 define gating');
  });
});

describe('classifyHeading', () => {
  it('classifies grant headings', () => {
    expect(classifyHeading('Specific Aims', 'grant')).toBe('aims');
    expect(classifyHeading('Project Summary / Abstract', 'grant')).toBe('summary');
    expect(classifyHeading('Project Summary/Abstract', 'grant')).toBe('summary');
    expect(classifyHeading('Project Narrative', 'grant')).toBe('narrative');
    expect(classifyHeading('Research Strategy', 'grant')).toBe('strategy');
    expect(classifyHeading('Background and Significance', 'grant')).toBe('significance');
    expect(classifyHeading('C. Approach', 'grant')).toBe('approach');
    expect(classifyHeading('Preliminary Data', 'grant')).toBe('approach');
    expect(classifyHeading('References Cited', 'grant')).toBe('references');
    expect(classifyHeading('References and Notes', 'manuscript')).toBe('references');
    expect(classifyHeading('Reference', 'manuscript')).toBe('references');
    expect(classifyHeading('Aim 1', 'grant')).toBeNull();
  });

  it('classifies manuscript headings', () => {
    expect(classifyHeading('Abstract', 'manuscript')).toBe('abstract');
    expect(classifyHeading('Background', 'manuscript')).toBe('introduction');
    expect(classifyHeading('Materials and Methods', 'manuscript')).toBe('methods');
    expect(classifyHeading('Results and Discussion', 'manuscript')).toBe('results');
    expect(classifyHeading('Conclusions', 'manuscript')).toBe('discussion');
    expect(classifyHeading('Statistical analysis', 'manuscript')).toBeNull();
  });
});

describe('classifyHeading when the heading carries a title after the section name', () => {
  // A real grant writes "2. Specific Aims- <project title>", not "Specific Aims". Anchoring on $ silently withheld
  // every aims and innovation check from a real R01 (measured 2026-10-11).
  const cases: [string, string][] = [
    ['2. Specific Aims- "Thermostable glycoprotein as a new vaccine strategy"', 'aims'],
    ['B. INNOVATION. This proposal embodies three levels of innovation', 'innovation'],
    ['A. SIGNIFICANCE. Why this matters now', 'significance'],
    ['C. APPROACH. Engineering and testing', 'approach'],
    ['Preliminary data supporting the premise', 'approach'],
  ];
  it.each(cases)('%s -> %s', (title, kind) => {
    expect(classifyHeading(title, 'grant')).toBe(kind);
  });
});

describe('classifyHeading on headings real grants use', () => {
  const cases: [string, string | null][] = [
    ['2.1 Current state of research in the field', 'significance'],
    ['2.2. Current state of your own research', 'approach'],
    ['2.3. Detailed research plan', 'approach'],
    ['2.4. Schedule and milestones', 'approach'],
    ['2.6. Relevance and impact', 'significance'],
    ['2.7. Relevance for personal career development', null],
    ['A5. Scientific Rigor and Consideration of Relevant Biological Variables', 'approach'],
    ['A3. Scientific premise: why this target', 'significance'],
    ['A4. Current gaps and medical need: unmet', 'significance'],
    ['C. APPROACH.', 'approach'],
    ['C1.1. Production and characterization of the antigen', 'approach'],
    ['C2.2b. Frequency of administration and stability testing', 'approach'],
    ['Project 1. Structure of the complex', 'approach'],
    ['Rationale', 'approach'],
    ['Strategy and plan', 'approach'],
    ['Anticipated results and potential pitfalls', 'approach'],
    ['Alternative strategies', 'approach'],
    ['Timelines and milestones', 'approach'],
    ['Immunogenicity in mice', 'approach'],
    ['Reason for the choice of research institution(s)', 'approach'],
    ['Relevance and impact', 'significance'],
    ['Literature Cited', 'references'],
    ['References', 'references'],
    ['References Cited', 'references'],
    ['Bibliography', 'references'],
    ['Reference', 'references'],
    ['References and Notes', 'references'],
    ['Acknowledgements', null],
    ['Career development plan', null],
  ];
  it.each(cases)('%s -> %s', (title, kind) => {
    expect(classifyHeading(title, 'grant')).toBe(kind);
  });
  it('keeps the unknown top-level heading as any inside sectionMap', () => {
    const s = sectionMap(doc(h(1, '2.7. Relevance for personal career development'), p('x')), 'grant');
    expect(s[0].kind).toBe('any');
  });
});

describe('slugify', () => {
  it('makes a short kebab slug and never returns empty', () => {
    expect(slugify('Aim 2: Rationale & Design')).toBe('aim-2-rationale-design');
    expect(slugify('   ')).toBe('section');
    expect(slugify('Ünïcödé Héading')).toBe('unicode-heading');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe('sectionMap', () => {
  it('returns one any-section for a document with no headings', () => {
    const s = sectionMap(doc(p('One.'), p('Two.')), 'grant');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ key: 'document', kind: 'any', title: '', level: 0, text: 'One.\n\nTwo.' });
  });

  it('maps a template-imprinted grant (H2 sections)', () => {
    const s = sectionMap(doc(h(2, 'Specific Aims'), p('Aims text.'), h(2, 'Significance'), p('Sig.'), h(2, 'Approach'), p('App.')), 'grant');
    expect(s.map(x => [x.key, x.kind])).toEqual([
      ['specific-aims#0', 'aims'],
      ['significance#0', 'significance'],
      ['approach#0', 'approach'],
    ]);
    expect(s[0].text).toBe('Aims text.');
  });

  it('inherits the parent kind for unknown subheadings and builds path keys', () => {
    const s = sectionMap(
      doc(h(1, 'Research Strategy'), h(2, 'Approach'), p('Intro.'), h(3, 'Aim 1: Gating'), p('A1.'), h(3, 'Rigor'), p('R.')),
      'grant',
    );
    expect(s.map(x => [x.key, x.kind])).toEqual([
      ['research-strategy#0', 'strategy'],
      ['research-strategy/approach#0', 'approach'],
      ['research-strategy/approach/aim-1-gating#0', 'approach'],
      ['research-strategy/approach/rigor#0', 'approach'],
    ]);
  });

  it('keeps an unknown child of Research Strategy as strategy, and an unknown top-level heading as any', () => {
    const s = sectionMap(doc(h(1, 'Research Strategy'), h(2, 'Overview'), p('x'), h(1, 'Vertebrate Animals'), p('y')), 'grant');
    expect(s.map(x => x.kind)).toEqual(['strategy', 'strategy', 'any']);
  });

  it('lets a specific parent win over a child keyword', () => {
    const s = sectionMap(doc(h(1, 'Approach'), h(2, 'Summary'), p('x')), 'grant');
    expect(s[1].kind).toBe('approach');
  });

  it('gives repeated subheadings unique keys', () => {
    const s = sectionMap(
      doc(h(2, 'Aim 1'), h(3, 'Rationale'), p('a'), h(2, 'Aim 2'), h(3, 'Rationale'), p('b'), h(3, 'Rationale'), p('c')),
      'grant',
    );
    const keys = s.map(x => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('aim-1/rationale#0');
    expect(keys).toContain('aim-2/rationale#0');
    expect(keys).toContain('aim-2/rationale#1');
  });

  it('handles skipped heading levels', () => {
    const s = sectionMap(doc(h(1, 'Approach'), h(3, 'Aim 1'), p('x')), 'grant');
    expect(s[1]).toMatchObject({ key: 'approach/aim-1#0', kind: 'approach', level: 3 });
  });

  it('adds a preamble only when there is text before the first heading', () => {
    const withTitle = sectionMap(doc(p('My Grant Title'), h(1, 'Specific Aims'), p('x')), 'grant');
    expect(withTitle[0]).toMatchObject({ key: 'preamble', kind: 'any', text: 'My Grant Title' });
    const bare = sectionMap(doc(p(''), h(1, 'Specific Aims'), p('x')), 'grant');
    expect(bare[0].key).toBe('specific-aims#0');
  });

  it('keeps a section with an empty heading and an empty body', () => {
    const s = sectionMap(doc(h(1, 'Specific Aims'), h(2, ''), h(1, 'Approach')), 'grant');
    expect(s.map(x => [x.key, x.kind, x.text])).toEqual([
      ['specific-aims#0', 'aims', ''],
      ['specific-aims/section#0', 'aims', ''],
      ['approach#0', 'approach', ''],
    ]);
  });

  it('renders citation atoms as their display text', () => {
    const s = sectionMap(doc(h(1, 'Significance'), p('Shown before ', cite(3, 1, 2), ' and ', cite(5), '.')), 'grant');
    expect(s[0].text).toBe('Shown before [1-3] and [5].');
  });

  it('records ProseMirror ranges for the section and its heading', () => {
    const d = doc(h(1, 'Specific Aims'), p('Aims.'), h(1, 'Approach'), p('App.'));
    const [aims, approach] = sectionMap(d, 'grant');
    expect(aims.from).toBe(0);
    expect(aims.headingFrom).toBe(0);
    expect(d.textBetween(aims.headingFrom, aims.headingTo)).toBe('Specific Aims');
    expect(aims.to).toBe(approach.from);
    expect(approach.to).toBe(d.content.size);
    expect(d.textBetween(approach.headingTo, approach.to)).toBe('App.');
  });

  it('classifies an IMRAD manuscript and a references section', () => {
    const s = sectionMap(
      doc(h(1, 'Abstract'), p('a'), h(1, '1 Introduction'), p('b'), h(1, '2 Methods'), h(2, 'Statistical analysis'), p('c'), h(1, 'References'), p('d')),
      'manuscript',
    );
    expect(s.map(x => x.kind)).toEqual(['abstract', 'introduction', 'methods', 'methods', 'references']);
  });
});
