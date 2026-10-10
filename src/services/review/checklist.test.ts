import { describe, it, expect } from 'vitest';
import { CHECKS, ROLE_NAMES, checksFor, checkById, effectiveKinds } from './checklist';
import { REVIEWER_ROLES, GRANT_KINDS, MANUSCRIPT_KINDS, type DocType, type ReviewerRole } from './types';

const ROLE_PREFIXES: Record<DocType, Record<ReviewerRole, string[]>> = {
  grant: { 'reviewer-2': ['imp'], manager: ['log'], statistician: ['rig'], researcher: ['fea', 'exp'], consistency: ['con'] },
  manuscript: { 'reviewer-2': ['imp'], manager: ['log'], statistician: ['rig'], researcher: ['met'], consistency: ['con'] },
};

describe('checklist invariants', () => {
  it('has unique ids', () => {
    const ids = CHECKS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prefixes each id with its doc type and owner', () => {
    for (const c of CHECKS) {
      const [docPrefix, rolePrefix] = c.id.split('-');
      expect(docPrefix, c.id).toBe(c.doc === 'grant' ? 'g' : 'm');
      expect(ROLE_PREFIXES[c.doc][c.owner], c.id).toContain(rolePrefix);
    }
  });

  it('gives every role at least one check per doc type', () => {
    for (const doc of ['grant', 'manuscript'] as DocType[]) {
      for (const role of REVIEWER_ROLES) expect(checksFor(doc, role).length, `${doc}/${role}`).toBeGreaterThan(0);
    }
  });

  it('gives every grant check a factor and no manuscript check one', () => {
    for (const c of CHECKS) {
      if (c.doc === 'grant') expect([1, 2, 3, 'presentation'], c.id).toContain(c.factor);
      else expect(c.factor, c.id).toBeUndefined();
    }
  });

  it('uses only section kinds of its own doc type, or any', () => {
    const allowed: Record<DocType, string[]> = { grant: [...GRANT_KINDS, 'any'], manuscript: [...MANUSCRIPT_KINDS, 'any'] };
    for (const c of CHECKS) {
      expect(c.sections.length, c.id).toBeGreaterThan(0);
      for (const k of c.sections) expect(allowed[c.doc], `${c.id}: ${k}`).toContain(k);
    }
  });

  it('fills name, question and passes for every check', () => {
    for (const c of CHECKS) {
      expect(c.name.trim(), c.id).not.toBe('');
      expect(c.question.trim(), c.id).not.toBe('');
      expect(c.passes.trim(), c.id).not.toBe('');
    }
  });

  it('covers every Factor 1, 2 and 3 for grants', () => {
    const factors = new Set(checksFor('grant').map(c => c.factor));
    expect([...factors].sort()).toEqual([1, 2, 3, 'presentation'].sort());
  });

  it('names every role for both doc types', () => {
    for (const doc of ['grant', 'manuscript'] as DocType[]) {
      for (const role of REVIEWER_ROLES) expect(ROLE_NAMES[doc][role].trim()).not.toBe('');
    }
  });
});

describe('checklist helpers', () => {
  it('checksFor filters by doc and role', () => {
    expect(checksFor('grant', 'statistician').every(c => c.doc === 'grant' && c.owner === 'statistician')).toBe(true);
    expect(checksFor('manuscript').every(c => c.doc === 'manuscript')).toBe(true);
  });

  it('checkById finds a check and returns undefined for an unknown id', () => {
    expect(checkById('g-rig-sabv')?.owner).toBe('statistician');
    expect(checkById('nope')).toBeUndefined();
  });

  it('effectiveKinds expands strategy into its three parts', () => {
    expect([...effectiveKinds(['strategy'])].sort()).toEqual(['approach', 'innovation', 'significance', 'strategy']);
    expect([...effectiveKinds(['aims'])]).toEqual(['aims']);
  });
});
