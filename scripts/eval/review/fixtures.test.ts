import { describe, it, expect } from 'vitest';
import { GRANT_FIXTURE } from './fixtures/grant';
import { MANUSCRIPT_FIXTURE } from './fixtures/manuscript';
import { fixtureDoc, fixtureHtml, fixturePlainText } from './fixtures/build';
import { checkById } from '../../../src/services/review/checklist';
import { sectionMap } from '../../../src/services/review/sections';
import type { ReviewFixture } from './fixtures/types';

const FIXTURES: ReviewFixture[] = [GRANT_FIXTURE, MANUSCRIPT_FIXTURE];
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

describe.each(FIXTURES.map(f => [f.id, f] as const))('fixture %s', (_id, fx) => {
  const plain = fixturePlainText(fx);
  const titles = new Set(fx.sections.map(s => s.title));
  const all = [...fx.planted, ...fx.traps];

  it('has unique expectation ids', () => {
    expect(new Set(all.map(e => e.id)).size).toBe(all.length);
  });

  it('uses checks of its own doc type', () => {
    for (const e of all) expect(checkById(e.checkId)?.doc, e.id).toBe(fx.docType);
  });

  it('names only section titles that exist', () => {
    for (const e of all) {
      for (const t of e.sectionTitles) expect(titles.has(t), `${e.id}: ${t}`).toBe(true);
      for (const a of e.alsoIn ?? []) expect(titles.has(a.sectionTitle), `${e.id}: ${a.sectionTitle}`).toBe(true);
    }
  });

  it('has every quote hint verbatim, exactly once', () => {
    for (const e of all) for (const q of e.quoteHints ?? []) expect(countOf(plain, q), `${e.id}: ${q}`).toBe(1);
  });

  it('uses stateless keyword regexes', () => {
    for (const e of all) expect(e.keywords.global || e.keywords.sticky, e.id).toBe(false);
  });

  it('builds a valid document and HTML', () => {
    expect(() => fixtureDoc(fx).check()).not.toThrow();
    expect(fixtureHtml(fx)).toContain(`<h1>${fx.sections[0].title}</h1>`);
  });
});

describe('grant fixture', () => {
  it('has 15 planted weaknesses and 8 traps', () => {
    expect(GRANT_FIXTURE.planted).toHaveLength(15);
    expect(GRANT_FIXTURE.traps).toHaveLength(8);
  });

  it('is roughly 1,500 words', () => {
    const words = fixturePlainText(GRANT_FIXTURE).split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThan(1200);
    expect(words).toBeLessThan(2200);
  });

  it('maps to the expected section kinds', () => {
    const s = sectionMap(fixtureDoc(GRANT_FIXTURE), 'grant');
    expect(s.map(x => x.kind)).toEqual([
      'summary', 'aims', 'strategy', 'significance', 'innovation', 'approach',
      'approach', 'approach', 'approach', 'approach', 'approach', 'approach',
    ]);
  });
});

describe('manuscript fixture', () => {
  it('has 12 planted weaknesses and 5 traps', () => {
    expect(MANUSCRIPT_FIXTURE.planted).toHaveLength(12);
    expect(MANUSCRIPT_FIXTURE.traps).toHaveLength(5);
  });

  it('maps to IMRAD kinds', () => {
    const s = sectionMap(fixtureDoc(MANUSCRIPT_FIXTURE), 'manuscript');
    expect(s.map(x => x.kind)).toEqual(['abstract', 'introduction', 'methods', 'results', 'discussion']);
  });
});

describe('manuscript keyword boundaries', () => {
  const kw = (id: string) => [...MANUSCRIPT_FIXTURE.planted, ...MANUSCRIPT_FIXTURE.traps].find(e => e.id === id)!.keywords;

  it('M9 matches the numbers as whole numbers only', () => {
    expect(kw('M9-abstract-mismatch').test('It rose 50% against 30%.')).toBe(true);
    expect(kw('M9-abstract-mismatch').test('Funding for 2030 and 15000 cells.')).toBe(false);
  });

  it('M8 matches "sem" as a word only (not inside semantic)', () => {
    expect(kw('M8-mean-no-variability').test('The semantic score is fine.')).toBe(false);
    expect(kw('M8-mean-no-variability').test('Report the SEM.')).toBe(true);
  });
});
