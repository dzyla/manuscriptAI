/**
 * Calibration of the style audit against the author's own real documents. fixtures/private/ is gitignored and never
 * committed, so on a fresh checkout this suite is skipped (like src/docx/read/private-fixtures.test.ts). Assertions are on
 * counts and shapes only; no document text is ever printed or compared.
 *
 * It exists because two defects shipped without it: a bibliography headed "LITERATURE CITED:" / "3. Bibliography" was measured
 * as prose (the author's semicolon rate read 4x too high), and sections with no sentences were scored 0.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readDocx } from '../../docx/read';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { flattenDoc } from '../../utils/textMatch';
import { auditText, flaggedSentences, MAX_REWRITE_WORDS } from './metrics';
import { styleDistance } from './score';
import { GENERIC_HUMAN_SUMMARY } from './profile';
import { sectionRows, MIN_SECTION_SENTENCES } from '../../components/style/styleRows';

const dir = new URL('../../../fixtures/private/', import.meta.url);
const present = (f: string) => existsSync(new URL(f, dir));
const NAMES = ['r01.docx', 'snsf.docx'].filter(present);

async function textOf(name: string): Promise<string> {
  const b = readFileSync(new URL(name, dir));
  const r = await readDocx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, undefined, name);
  return flattenDoc(getSpecSchema().nodeFromJSON(r.doc)).text;
}

describe.skipIf(NAMES.length === 0)('style audit on the author\'s real documents', () => {
  it.each(NAMES)('%s: the bibliography is not measured as prose, and the numbers are sane', async name => {
    const m = auditText(await textOf(name));
    const s = m.summary;
    expect(s.sentences).toBeGreaterThan(100);
    // The author's own unassisted prose: semicolons are rare. Measured 3.0 per 100 on r01 once the bibliography is excluded
    // (13.0 when it was included). The machine reference is 21.
    expect(s.rates.semicolon).toBeLessThan(6);
    // A reference list is one huge "sentence"; nothing like it may survive.
    expect(Math.max(...m.sentences.map(x => x.words))).toBeLessThan(250);
    // The panel must not list, or offer to rewrite, anything over the cap as its top item.
    for (const f of flaggedSentences(m, 12)) expect(f.words).toBeGreaterThan(0);
    expect(m.sentences.filter(x => x.words > MAX_REWRITE_WORDS).length).toBeLessThan(0.03 * s.sentences);
  });

  it.each(NAMES)('%s: no section row reports a score without enough sentences', async name => {
    const m = auditText(await textOf(name));
    const rows = sectionRows(m.sections, GENERIC_HUMAN_SUMMARY);
    expect(rows.every(r => r.sentences > 0)).toBe(true);
    for (const r of rows) {
      if (r.sentences < MIN_SECTION_SENTENCES) expect(r.score).toBeNull();
      else expect(r.score).not.toBeNull();
    }
  });

  it.each(NAMES)('%s: the author\'s own prose does not score "far" against the typical-writing baseline', async name => {
    const m = auditText(await textOf(name));
    expect(styleDistance(m.summary, GENERIC_HUMAN_SUMMARY).band).not.toBe('far');
  });
});
