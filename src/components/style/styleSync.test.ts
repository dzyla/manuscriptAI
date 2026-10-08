// @vitest-environment jsdom
import { describe, it, expect, afterAll } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from '../../extensions/schema';
import { auditText } from '../../services/proseAudit/metrics';
import { flattenDoc } from '../../utils/textMatch';
import { sentencesToDraw, auditMatchesDoc, flatRangeToPm, type StyleAuditSnapshot } from './styleSync';

const TEXT = 'The problem matters rather than the cost, which is clear; it matters a great deal to patients, clinicians, and funders. We purified the complex by gel filtration in three runs.';
const snapshot = (text: string): StyleAuditSnapshot => ({ metrics: auditText(text), text });

describe('staleness guard (sentencesToDraw)', () => {
  it('passes sentences through when the editor text still matches the audited text', () => {
    const a = snapshot(TEXT);
    const out = sentencesToDraw(a, TEXT, true);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].end).toBeLessThanOrEqual(TEXT.length);
  });

  it('withholds sentences when the editor text has changed since the audit', () => {
    const a = snapshot(TEXT);
    expect(sentencesToDraw(a, 'Inserted words. ' + TEXT, true)).toEqual([]);
    expect(auditMatchesDoc(a, 'Inserted words. ' + TEXT)).toBe(false);
  });

  it('withholds sentences with no audit, no editor text, or drawing off', () => {
    const a = snapshot(TEXT);
    expect(sentencesToDraw(null, TEXT, true)).toEqual([]);
    expect(sentencesToDraw(a, undefined, true)).toEqual([]);
    expect(sentencesToDraw(a, TEXT, false)).toEqual([]);
  });
});

describe('flatRangeToPm (behind EditorRef.selectFlatRange)', () => {
  const editor = new Editor({ extensions: getSchemaExtensions(), content: htmlToDoc('<p>First sentence here. Second sentence follows.</p>') });
  const flat = flattenDoc(editor.state.doc).text;
  afterAll(() => editor.destroy());

  it('maps a valid span to the document positions of the same text', () => {
    const start = flat.indexOf('Second');
    const end = start + 'Second sentence follows.'.length;
    const span = flatRangeToPm(editor.state.doc, start, end)!;
    expect(span).not.toBeNull();
    expect(editor.state.doc.textBetween(span.from, span.to)).toBe('Second sentence follows.');
  });

  it('returns null for out-of-range or empty spans', () => {
    expect(flatRangeToPm(editor.state.doc, 0, flat.length + 5)).toBeNull();
    expect(flatRangeToPm(editor.state.doc, -1, 4)).toBeNull();
    expect(flatRangeToPm(editor.state.doc, 6, 6)).toBeNull();
    expect(flatRangeToPm(editor.state.doc, 9, 3)).toBeNull();
  });
});
