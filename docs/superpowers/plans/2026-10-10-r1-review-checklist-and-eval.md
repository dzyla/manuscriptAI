# R1: Review Checklist, Section Map and Review Eval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation of Review v2 without changing anything the user sees: the review checklist as data, a section map of the document, prompt rendering from the checklist, and an eval with a grant and a manuscript fixture that scores the *current* pipeline to give a baseline.

**Architecture:** New pure modules under `src/services/review/` (`types.ts`, `checklist.ts`, `sections.ts`, `prompt.ts`), each unit-tested in vitest with no network. A new eval under `scripts/eval/review/` (fixtures, a pure scorer, a baseline adapter that drives today's `analyzeText` crew + Judge + verifier + detectors + summary exactly as `useAnalysis.ts` does, and a CLI runner that counts LLM calls by wrapping `fetch`). The final task runs the baseline against real providers and records the numbers.

**Tech Stack:** TypeScript, ProseMirror (`@tiptap/pm/model`) via `getSpecSchema()` from `src/extensions/schemaSpecs.ts` (DOM-free), vitest (node environment), tsx for the eval runner.

**Spec:** `docs/superpowers/specs/2026-10-10-review-v2-design.md` (§1 checklist, §3.1 section map, §3.2 prompt rendering, §6 measuring quality, §8 R1 row).

## Global Constraints

- Gate for the whole plan, all three must exit 0: `npx tsc --noEmit`, `npx vitest run`, `npm run build`. After `npm run build` run `git checkout -- dist-electron` to revert churn.
- `vitest.config.ts` keeps `maxForks: 2`; never change or override it. Do not start the dev server or a browser.
- Use `npx tsc --noEmit` for type-checking (`npm run lint` is distorted by an rtk proxy here).
- No editor schema change in R1 (no node or mark attributes), so `src/docx/preserve/hash.test.ts` must stay green untouched.
- Nothing user-visible changes in R1: no edits to `src/components/`, `src/hooks/`, or `src/services/ai.ts`.
- NIH framework wording, verbatim in prompts: Factor 1 = "Importance of the Research", Factor 2 = "Rigor and Feasibility", Factor 3 = "Expertise and Resources" (rated sufficient or insufficient); applies to applications due on or after 25 January 2025.
- Role ids reuse `AgentType`: `manager`, `reviewer-2`, `statistician`, `researcher`, `consistency`.
- Eval runs call real providers and never run inside vitest. API keys come only from environment variables and are never printed or written to files.
- Commit after each task with a `feat(review):` / `test(review):` / `docs(review):` prefix and end the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Headings from imported Word grants** ("C.2 Approach", "A. Significance", "1 Introduction", "Project Summary / Abstract"): the section map must still classify them. Pinned in Task 2 (`normalizeHeading` and classification tests).
2. **Repeated subheadings** ("Rationale" under every aim): section keys must stay unique and stable. Pinned in Task 2 (duplicate-path test).
3. **Empty or whitespace-only headings and a title paragraph before the first heading**: no crash, no all-checks-apply explosion from a preamble. Pinned in Task 2 (empty heading, preamble tests) and Task 3 (`applicableChecks` ignores `any`/`references` when specific kinds exist).
4. **Citation atoms inside section text** must read as "[1-3]" so quotes the model copies can be found again. Pinned in Task 2 (citation test).
5. **Fixture drift**: someone edits a fixture paragraph and a `quoteHint` silently stops matching, so recall drops for no reason. Pinned in Task 4 (every hint appears verbatim exactly once).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/review/types.ts` | Shared types: roles, doc types, section kinds, factor groups, `ReviewCheck`, `Section` |
| `src/services/review/checklist.ts` | The checklist data (`CHECKS`), role display names, `checksFor`, `checkById`, `effectiveKinds` |
| `src/services/review/checklist.test.ts` | Invariants from spec §1.3 |
| `src/services/review/sections.ts` | `normalizeHeading`, `classifyHeading`, `slugify`, `sectionMap` |
| `src/services/review/sections.test.ts` | Section map tests |
| `src/services/review/prompt.ts` | `applicableChecks`, `renderRolePrompt`, `sectionMarker`, `renderSectionedText` |
| `src/services/review/prompt.test.ts` | Prompt rendering tests incl. "each check in exactly one prompt" |
| `src/services/grantTemplates.ts` | Add `projectYears` to templates and `normalizeTemplate` |
| `src/services/grantTemplates.test.ts` | New: `projectYears` tests |
| `scripts/eval/review/fixtures/types.ts` | `ReviewFixture`, `Expectation` types |
| `scripts/eval/review/fixtures/build.ts` | Fixture → PM doc JSON, PM node, HTML, plain text |
| `scripts/eval/review/fixtures/grant.ts` | Synthetic R01 with 15 planted weaknesses and 8 traps |
| `scripts/eval/review/fixtures/manuscript.ts` | IMRAD manuscript with 11 planted weaknesses and 5 traps |
| `scripts/eval/review/fixtures.test.ts` | Fixture integrity tests |
| `scripts/eval/review/score.ts` | Pure scorer: matching, recall, false alarms, prose mentions, legacy adapter |
| `scripts/eval/review/score.test.ts` | Scorer tests |
| `scripts/eval/review/baseline.ts` | Drives the current pipeline exactly as `useAnalysis.ts` does |
| `scripts/eval/review/run.ts` | CLI: args, settings from env, call counter, output, JSON results |
| `scripts/eval/review/run.test.ts` | Tests for the runner's pure parts |
| `package.json` | `eval:review` script |
| `.gitignore` | `scripts/eval/review/results/` |
| `docs/superpowers/plans/2026-07-04-eval-results.md` | Baseline numbers appended (Task 7) |
| `docs/superpowers/specs/2026-10-10-review-v2-design.md` | Three refinements recorded (Tasks 2, 3, 4) |

---

### Task 1: Review types and the checklist

**Files:**
- Create: `src/services/review/types.ts`
- Create: `src/services/review/checklist.ts`
- Test: `src/services/review/checklist.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ReviewerRole = 'manager' | 'reviewer-2' | 'statistician' | 'researcher' | 'consistency'`
  - `const REVIEWER_ROLES: readonly ReviewerRole[]`
  - `type DocType = 'grant' | 'manuscript'`
  - `type SectionKind` (grant kinds, manuscript kinds, `'references'`, `'any'`), `GRANT_KINDS`, `MANUSCRIPT_KINDS`
  - `type FactorGroup = 1 | 2 | 3 | 'presentation'`, `type Severity = 'critical' | 'major' | 'minor'`
  - `interface ReviewCheck { id; doc; factor?; owner; sections; scope; name; question; passes; severity }`
  - `interface Section { key; kind; title; level; from; to; headingFrom; headingTo; text }`
  - `const CHECKS: readonly ReviewCheck[]`
  - `const ROLE_NAMES: Record<DocType, Record<ReviewerRole, string>>`
  - `function checksFor(doc: DocType, role?: ReviewerRole): ReviewCheck[]`
  - `function checkById(id: string): ReviewCheck | undefined`
  - `function effectiveKinds(kinds: Iterable<SectionKind>): Set<SectionKind>` (`strategy` adds `significance`, `innovation`, `approach`)

- [ ] **Step 1: Write the types file**

`src/services/review/types.ts`:

```ts
/**
 * Review v2 shared types. The checklist (checklist.ts) is the single source of what the review asks; every prompt is
 * rendered from it (prompt.ts). Role ids reuse AgentType ids so saved settings, customPrompts and colours keep working.
 */

export type ReviewerRole = 'manager' | 'reviewer-2' | 'statistician' | 'researcher' | 'consistency';

export const REVIEWER_ROLES: readonly ReviewerRole[] = ['manager', 'reviewer-2', 'statistician', 'researcher', 'consistency'];

export type DocType = 'grant' | 'manuscript';

export const GRANT_KINDS = ['summary', 'narrative', 'aims', 'significance', 'innovation', 'approach', 'strategy'] as const;
export const MANUSCRIPT_KINDS = ['abstract', 'introduction', 'methods', 'results', 'discussion'] as const;

export type GrantSectionKind = (typeof GRANT_KINDS)[number];
export type ManuscriptSectionKind = (typeof MANUSCRIPT_KINDS)[number];

/**
 * `references` marks a bibliography: no check targets it and its text is never sent to a reviewer.
 * `any` marks content whose kind is unknown (no headings, or an unrecognised top-level heading).
 */
export type SectionKind = GrantSectionKind | ManuscriptSectionKind | 'references' | 'any';

/** NIH Simplified Peer Review Framework: 1 Importance of the Research, 2 Rigor and Feasibility, 3 Expertise and Resources. */
export type FactorGroup = 1 | 2 | 3 | 'presentation';

export type Severity = 'critical' | 'major' | 'minor';

export interface ReviewCheck {
  /** Stable kebab-case id: `g-` or `m-`, then a role prefix, then a name. */
  id: string;
  doc: DocType;
  /** Required for grant checks, absent for manuscript checks. */
  factor?: FactorGroup;
  /** Exactly one owner. */
  owner: ReviewerRole;
  /** Where the evidence should be; 'any' = the whole document. */
  sections: SectionKind[];
  /** 'cross' = needs facts from more than one section. */
  scope: 'section' | 'cross';
  /** Short label shown on a finding card. */
  name: string;
  /** What the reviewer asks. */
  question: string;
  /** What counts as adequate, so the model knows when NOT to flag. */
  passes: string;
  /** Default severity when the check fails. */
  severity: Severity;
}

/** One heading and the blocks up to the next heading of any level (or the document / preamble when there is none). */
export interface Section {
  /** Heading path of slugs joined by '/', plus '#n' for the n-th section with that path: `approach/aim-2#0`. */
  key: string;
  kind: SectionKind;
  /** The heading text as written ('' for the preamble and the headingless document). */
  title: string;
  /** Heading level, 0 for the preamble and the headingless document. */
  level: number;
  /** ProseMirror range of the whole section (heading included). */
  from: number;
  to: number;
  /** ProseMirror range of the heading node; equal to `from` when there is no heading. */
  headingFrom: number;
  headingTo: number;
  /** Body text (heading excluded), blocks joined by '\n\n', citation atoms rendered as their display "[1-3]". */
  text: string;
}
```

- [ ] **Step 2: Write the failing invariant tests**

`src/services/review/checklist.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/services/review/checklist.test.ts`
Expected: FAIL, "Failed to resolve import './checklist'".

- [ ] **Step 4: Write the checklist**

`src/services/review/checklist.ts`:

```ts
/**
 * The review checklist: every question the review crew asks, written once, owned by exactly one role. Prompts are
 * rendered from this data (prompt.ts); nothing else defines what a reviewer checks. Grant checks follow the NIH
 * Simplified Peer Review Framework (applications due on or after 25 January 2025).
 */
import type { DocType, ReviewCheck, ReviewerRole, SectionKind } from './types';

export const ROLE_NAMES: Record<DocType, Record<ReviewerRole, string>> = {
  grant: {
    manager: 'Aims & Logic',
    'reviewer-2': 'Importance',
    statistician: 'Rigor',
    researcher: 'Feasibility',
    consistency: 'Consistency',
  },
  manuscript: {
    manager: 'Structure & Logic',
    'reviewer-2': 'Importance & Claims',
    statistician: 'Statistics & Rigor',
    researcher: 'Methods & Reproducibility',
    consistency: 'Consistency',
  },
};

export const CHECKS: readonly ReviewCheck[] = [
  // ── Grant · Importance (Factor 1) ────────────────────────────────────────────
  { id: 'g-imp-gap', doc: 'grant', factor: 1, owner: 'reviewer-2', sections: ['aims', 'significance'], scope: 'section', severity: 'major',
    name: 'Knowledge gap stated',
    question: 'Does the application state, in one or two sentences, what is not known that this project will establish?',
    passes: 'Adequate when the Specific Aims page or Significance names a specific unknown (not a topic area) that the aims address.' },
  { id: 'g-imp-why', doc: 'grant', factor: 1, owner: 'reviewer-2', sections: ['aims', 'significance'], scope: 'section', severity: 'major',
    name: 'Why the gap matters',
    question: 'Does it explain what changes for the field, for patients or for public health if the gap is closed, rather than presenting the gap as worth filling for its own sake?',
    passes: 'Adequate when a concrete consequence of closing the gap is stated (a decision, a therapy, or a model that would change).' },
  { id: 'g-imp-premise', doc: 'grant', factor: 1, owner: 'reviewer-2', sections: ['significance'], scope: 'section', severity: 'major',
    name: 'Strength of the premise',
    question: 'Is the prior work the project rests on cited, and are its strengths and weaknesses (design, rigor, model limits) acknowledged?',
    passes: 'Adequate when the key prior findings are cited and at least their main limitation is discussed or the project is designed around it.' },
  { id: 'g-imp-innovation', doc: 'grant', factor: 1, owner: 'reviewer-2', sections: ['innovation'], scope: 'section', severity: 'major',
    name: 'Innovation is real',
    question: 'Are the claimed innovations new to the field (concepts, approaches, methods, interventions), rather than new to this laboratory or routine practice?',
    passes: 'Adequate when each innovation claim names what is new relative to current practice in the field; standard methods are not presented as innovative.' },
  { id: 'g-imp-payoff', doc: 'grant', factor: 1, owner: 'reviewer-2', sections: ['aims', 'significance'], scope: 'section', severity: 'minor',
    name: 'Expected impact stated',
    question: 'Does the application state the expected outcomes and how they would move the field forward?',
    passes: 'Adequate when the Aims page or Significance closes with concrete expected outcomes and their impact.' },

  // ── Grant · Aims & Logic ─────────────────────────────────────────────────────
  { id: 'g-log-objective', doc: 'grant', factor: 1, owner: 'manager', sections: ['aims'], scope: 'section', severity: 'minor',
    name: 'Goal and objective stated',
    question: 'Are the long-term goal and the specific objective of this application stated and distinct?',
    passes: 'Adequate when both are stated, or the objective of this application is clearly stated in one sentence.' },
  { id: 'g-log-hypothesis', doc: 'grant', factor: 2, owner: 'manager', sections: ['aims'], scope: 'section', severity: 'critical',
    name: 'Testable hypothesis',
    question: 'Is there a central hypothesis (or, for discovery work, a clearly framed question) that the aims can confirm or refute?',
    passes: 'Adequate when the hypothesis names a specific relationship or mechanism that a defined result would refute. "X plays a role in Y" is not testable.' },
  { id: 'g-log-independent', doc: 'grant', factor: 2, owner: 'manager', sections: ['aims', 'approach'], scope: 'cross', severity: 'critical',
    name: 'Aims stand on their own',
    question: 'Can each aim succeed, and yield a publishable result, if another aim fails or is delayed?',
    passes: 'Adequate when no aim requires the success or products of another aim, or the dependency is acknowledged and a fallback (alternative reagent, parallel start) is given.' },
  { id: 'g-log-aims-approach', doc: 'grant', factor: 2, owner: 'manager', sections: ['aims', 'approach'], scope: 'cross', severity: 'critical',
    name: 'Aims page matches the Approach',
    question: 'Does every aim and sub-aim on the Specific Aims page have a matching part in the Approach with the same scope, and does the Approach introduce no aims that the Aims page lacks?',
    passes: 'Adequate when the aims and sub-aims correspond one to one in name and scope.' },
  { id: 'g-log-measurable', doc: 'grant', factor: 2, owner: 'manager', sections: ['aims', 'approach'], scope: 'section', severity: 'major',
    name: 'Measurable endpoint per aim',
    question: 'Does each aim define what will be measured and what result completes the aim?',
    passes: 'Adequate when each aim names its primary readout or deliverable.' },
  { id: 'g-log-scope', doc: 'grant', factor: 2, owner: 'manager', sections: ['aims', 'approach'], scope: 'cross', severity: 'critical',
    name: 'Scope fits the project period',
    question: 'Is the amount of work plausible for the project period and the team, or is the application overambitious?',
    passes: 'Adequate when the number of aims, models and experiments is in line with the stated period; judge against the mechanism when no period is stated.' },

  // ── Grant · Rigor (Factor 2) ─────────────────────────────────────────────────
  { id: 'g-rig-design', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Experimental design per aim',
    question: 'For each aim, are the experimental groups, controls and comparisons described?',
    passes: 'Adequate when each experiment names its groups and controls.' },
  { id: 'g-rig-power', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'critical',
    name: 'Power for the proposed work',
    question: 'Are the sample sizes for the proposed experiments justified by a power calculation or by stated precedent?',
    passes: "Adequate when each experiment's n is justified (effect size, variance, alpha, power) somewhere in the application, including a separate rigor or statistics section." },
  { id: 'g-rig-stats', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Statistical analysis plan',
    question: "Does the plan name the statistical tests or models for each aim's primary outcome?",
    passes: 'Adequate when each aim\'s primary comparison has a named test or model. "Appropriate statistical methods" is not adequate.' },
  { id: 'g-rig-sabv', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Sex as a biological variable',
    question: 'For vertebrate animal and human studies, is sex as a biological variable addressed?',
    passes: 'Adequate when the text states that both sexes are studied and sex is considered in the analysis, or justifies a single sex, or the work uses no vertebrate animals or human subjects. Check each aim, including any separate rigor section.' },
  { id: 'g-rig-bias', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Randomization and blinding',
    question: 'Are randomization to groups and blinding of outcome assessment described where they apply?',
    passes: 'Adequate when each in vivo or clinical experiment states how subjects are allocated and who is blinded, or why blinding is not possible.' },
  { id: 'g-rig-replication', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'minor',
    name: 'Replication and validation',
    question: 'Are key results replicated independently or validated with a second method?',
    passes: 'Adequate when the plan states independent replicates or orthogonal validation for the main findings.' },
  { id: 'g-rig-resources', doc: 'grant', factor: 2, owner: 'statistician', sections: ['approach'], scope: 'section', severity: 'minor',
    name: 'Authentication of key resources',
    question: 'Are key biological and chemical resources (antibodies, cell lines, animals, compounds) authenticated, or is the authentication plan referenced?',
    passes: 'Adequate when authentication is described or the Authentication of Key Resources attachment is referenced.' },

  // ── Grant · Feasibility (Factor 2) ───────────────────────────────────────────
  { id: 'g-fea-prelim', doc: 'grant', factor: 2, owner: 'researcher', sections: ['approach', 'significance'], scope: 'section', severity: 'critical',
    name: 'Preliminary data support each aim',
    question: "Is each aim supported by preliminary data or by the team's published track record with the approach?",
    passes: "Adequate when each aim's central premise or key method is backed by shown data or cited prior work by the team." },
  { id: 'g-fea-pitfalls', doc: 'grant', factor: 2, owner: 'researcher', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Potential problems and alternatives',
    question: 'Does each aim discuss likely problems and give alternative strategies?',
    passes: 'Adequate when each aim names at least one realistic problem and what will be done instead.' },
  { id: 'g-fea-outcomes', doc: 'grant', factor: 2, owner: 'researcher', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Interpretable outcomes',
    question: 'Does each aim state what result would support or refute the hypothesis, and how each outcome would be interpreted?',
    passes: 'Adequate when expected outcomes are stated with their interpretation, including the negative case.' },
  { id: 'g-fea-timeline', doc: 'grant', factor: 2, owner: 'researcher', sections: ['approach'], scope: 'cross', severity: 'major',
    name: 'Timeline matches the aims',
    question: 'Is there a timeline or milestones, and do they fit within the project period and match the aims?',
    passes: 'Adequate when milestones fall within the period and every aim appears on the timeline.' },

  // ── Grant · Expertise and Resources (Factor 3) ───────────────────────────────
  { id: 'g-exp-expertise', doc: 'grant', factor: 3, owner: 'researcher', sections: ['approach'], scope: 'section', severity: 'major',
    name: 'Expertise for each key method',
    question: 'Does the text show that the team has, or has arranged access to, the expertise each key method requires?',
    passes: "Adequate when each specialised method is backed by the team's experience, a named collaborator or a core facility. Judge from the text only." },
  { id: 'g-exp-resources', doc: 'grant', factor: 3, owner: 'researcher', sections: ['approach'], scope: 'section', severity: 'minor',
    name: 'Resources available',
    question: 'Are the required equipment, cohorts, samples, animals or data access stated as available?',
    passes: 'Adequate when access to each critical resource is stated.' },

  // ── Grant · Consistency (presentation) ───────────────────────────────────────
  { id: 'g-con-numbers', doc: 'grant', factor: 'presentation', owner: 'consistency', sections: ['any'], scope: 'cross', severity: 'major',
    name: 'Numbers agree across sections',
    question: 'Do numbers that describe the same thing (cohort sizes, doses, durations, effect sizes) agree everywhere they appear?',
    passes: 'Adequate when every repeated number matches.' },
  { id: 'g-con-terms', doc: 'grant', factor: 'presentation', owner: 'consistency', sections: ['any'], scope: 'cross', severity: 'minor',
    name: 'Terms and abbreviations',
    question: 'Are entities named consistently, and is each abbreviation defined at its first use?',
    passes: 'Adequate when each abbreviation is defined at or before first use (a definition in the Project Summary or Specific Aims counts) and names do not drift.' },
  { id: 'g-con-summary', doc: 'grant', factor: 'presentation', owner: 'consistency', sections: ['summary', 'aims'], scope: 'cross', severity: 'major',
    name: 'Project Summary matches the aims',
    question: 'Does the Project Summary describe the same aims and scope as the Specific Aims page, without adding or omitting work?',
    passes: "Adequate when the summary's aims correspond to the Specific Aims page." },
  { id: 'g-con-uncited', doc: 'grant', factor: 'presentation', owner: 'consistency', sections: ['significance', 'innovation'], scope: 'section', severity: 'minor',
    name: 'Claims are cited',
    question: 'Do factual claims about the field (prevalence, mechanisms, prior findings) carry a citation?',
    passes: "Adequate when each such claim has a citation; the applicant's own preliminary data shown in the application need none." },

  // ── Manuscript · Importance & Claims ─────────────────────────────────────────
  { id: 'm-imp-question', doc: 'manuscript', owner: 'reviewer-2', sections: ['introduction'], scope: 'section', severity: 'major',
    name: 'Research question and gap',
    question: 'Does the introduction state the research question and the gap it addresses?',
    passes: 'Adequate when a specific question or hypothesis is stated by the end of the introduction.' },
  { id: 'm-imp-novelty', doc: 'manuscript', owner: 'reviewer-2', sections: ['introduction', 'discussion'], scope: 'section', severity: 'major',
    name: 'Advance over prior work',
    question: 'Is the advance over prior work stated, and is it accurate given the cited literature?',
    passes: 'Adequate when the paper says what is new relative to cited work.' },
  { id: 'm-imp-overclaim', doc: 'manuscript', owner: 'reviewer-2', sections: ['abstract', 'results', 'discussion'], scope: 'cross', severity: 'critical',
    name: 'Conclusions match the data',
    question: 'Are the conclusions supported by the data shown, without causal claims from correlational data, generalisation beyond the model, or words like "prove"?',
    passes: 'Adequate when each conclusion is proportionate to the evidence and its limits are stated.' },

  // ── Manuscript · Structure & Logic ───────────────────────────────────────────
  { id: 'm-log-structure', doc: 'manuscript', owner: 'manager', sections: ['any'], scope: 'section', severity: 'minor',
    name: 'Sections do their job',
    question: 'Does each section do its job: methods describe, results report without interpreting, discussion interprets?',
    passes: 'Adequate when results and interpretation are kept in their sections.' },
  { id: 'm-log-flow', doc: 'manuscript', owner: 'manager', sections: ['introduction', 'results'], scope: 'cross', severity: 'major',
    name: 'Results answer the question',
    question: 'Do the results answer the question posed in the introduction, in a logical order?',
    passes: 'Adequate when each result connects to the stated question.' },
  { id: 'm-log-abstract', doc: 'manuscript', owner: 'manager', sections: ['abstract', 'results'], scope: 'cross', severity: 'major',
    name: 'Abstract matches the results',
    question: 'Does the abstract report the same findings as the results?',
    passes: 'Adequate when every finding claimed in the abstract appears in the results.' },

  // ── Manuscript · Statistics & Rigor ──────────────────────────────────────────
  { id: 'm-rig-tests', doc: 'manuscript', owner: 'statistician', sections: ['methods', 'results'], scope: 'section', severity: 'critical',
    name: 'Statistical tests named',
    question: 'Are the statistical tests named for each comparison and appropriate for the data?',
    passes: 'Adequate when each reported p-value or "significant" claim has a named test.' },
  { id: 'm-rig-n', doc: 'manuscript', owner: 'statistician', sections: ['introduction', 'methods', 'results'], scope: 'section', severity: 'major',
    name: 'Sample size reported',
    question: 'Is n reported for each experiment, and is it clear what n counts (cells, animals, independent experiments)?',
    passes: 'Adequate when each result states n and its unit.' },
  { id: 'm-rig-variability', doc: 'manuscript', owner: 'statistician', sections: ['results'], scope: 'section', severity: 'major',
    name: 'Variability reported',
    question: 'Are measures of variability (SD, SEM, CI) reported and named?',
    passes: 'Adequate when each mean comes with a named measure of variability.' },
  { id: 'm-rig-effect', doc: 'manuscript', owner: 'statistician', sections: ['results'], scope: 'section', severity: 'minor',
    name: 'Effect sizes',
    question: 'Are effect sizes or magnitudes reported alongside p-values?',
    passes: 'Adequate when key comparisons report the size of the effect, not only significance.' },
  { id: 'm-rig-multiple', doc: 'manuscript', owner: 'statistician', sections: ['methods', 'results'], scope: 'section', severity: 'major',
    name: 'Multiple comparisons',
    question: 'Are multiple comparisons corrected or justified?',
    passes: 'Adequate when several tests on the same data state a correction, or only one test is run.' },
  { id: 'm-rig-controls', doc: 'manuscript', owner: 'statistician', sections: ['methods', 'results'], scope: 'section', severity: 'major',
    name: 'Appropriate controls',
    question: 'Does each experiment have appropriate controls?',
    passes: 'Adequate when each treatment is compared with a suitable control.' },

  // ── Manuscript · Methods & Reproducibility ───────────────────────────────────
  { id: 'm-met-reproducible', doc: 'manuscript', owner: 'researcher', sections: ['methods'], scope: 'section', severity: 'major',
    name: 'Methods can be repeated',
    question: 'Is there enough detail (assays, conditions, timings, instruments) for another lab to repeat the work?',
    passes: 'Adequate when each measurement names its assay and conditions.' },
  { id: 'm-met-materials', doc: 'manuscript', owner: 'researcher', sections: ['methods'], scope: 'section', severity: 'minor',
    name: 'Materials identified',
    question: 'Are reagents, organisms and software identified (source, catalogue number or RRID, version)?',
    passes: 'Adequate when key materials are identified.' },
  { id: 'm-met-limitations', doc: 'manuscript', owner: 'researcher', sections: ['discussion'], scope: 'section', severity: 'major',
    name: 'Limitations discussed',
    question: "Does the discussion state the study's main limitations?",
    passes: 'Adequate when at least the main limitation is discussed.' },
  { id: 'm-met-data', doc: 'manuscript', owner: 'researcher', sections: ['any'], scope: 'section', severity: 'minor',
    name: 'Data and code availability',
    question: 'Is data and code availability stated?',
    passes: 'Adequate when a data availability statement is present.' },

  // ── Manuscript · Consistency ─────────────────────────────────────────────────
  { id: 'm-con-numbers', doc: 'manuscript', owner: 'consistency', sections: ['any'], scope: 'cross', severity: 'major',
    name: 'Numbers agree across sections',
    question: 'Do numbers reported in more than one place (abstract, results, figure legends) agree?',
    passes: 'Adequate when every repeated number matches.' },
  { id: 'm-con-terms', doc: 'manuscript', owner: 'consistency', sections: ['any'], scope: 'cross', severity: 'minor',
    name: 'Terms and abbreviations',
    question: 'Are terms used consistently and abbreviations defined at first use?',
    passes: 'Adequate when each abbreviation is defined at or before first use.' },
  { id: 'm-con-figures', doc: 'manuscript', owner: 'consistency', sections: ['results'], scope: 'cross', severity: 'minor',
    name: 'Figures and tables referenced',
    question: 'Is every figure and table referenced in the text and described consistently?',
    passes: 'Adequate when each figure and table is cited in order and the text matches it.' },
  { id: 'm-con-uncited', doc: 'manuscript', owner: 'consistency', sections: ['introduction', 'results', 'discussion'], scope: 'section', severity: 'minor',
    name: 'Claims are cited',
    question: 'Do factual claims about prior work or the field carry a citation?',
    passes: "Adequate when each such claim is cited; the paper's own results need none." },
];

export function checksFor(doc: DocType, role?: ReviewerRole): ReviewCheck[] {
  return CHECKS.filter(c => c.doc === doc && (role === undefined || c.owner === role));
}

const BY_ID = new Map(CHECKS.map(c => [c.id, c]));

export function checkById(id: string): ReviewCheck | undefined {
  return BY_ID.get(id);
}

/** A single "Research Strategy" section with no subheadings stands in for all three of its parts. */
export function effectiveKinds(kinds: Iterable<SectionKind>): Set<SectionKind> {
  const out = new Set<SectionKind>(kinds);
  if (out.has('strategy')) {
    out.add('significance');
    out.add('innovation');
    out.add('approach');
  }
  return out;
}
```

Note: `m-rig-n` lists `introduction` and `m-imp-overclaim` lists `results`, and `m-con-uncited` lists `results`, beyond the spec §1.2 table, because the manuscript fixture's seeded problems sit there (an unsized "many samples" in the introduction, "The results prove" and "the gold standard" in the results). Task 4 records this in the spec.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/review/checklist.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add src/services/review/types.ts src/services/review/checklist.ts src/services/review/checklist.test.ts
git commit -m "feat(review): checklist data and invariants for review v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Section map

**Files:**
- Create: `src/services/review/sections.ts`
- Test: `src/services/review/sections.test.ts`
- Modify: `docs/superpowers/specs/2026-10-10-review-v2-design.md` (§1 `SectionKind` and §3.1: record the `references` kind)

**Interfaces:**
- Consumes: `Section`, `SectionKind`, `DocType` from `./types` (Task 1); `formatCitationGroup` from `src/utils/citationFormat.ts`.
- Produces:
  - `function normalizeHeading(title: string): string`
  - `function classifyHeading(title: string, doc: DocType): SectionKind | null` (null = unknown)
  - `function slugify(title: string): string`
  - `function sectionMap(doc: PMNode, docType: DocType): Section[]` where `PMNode` is `Node` from `@tiptap/pm/model`

- [ ] **Step 1: Write the failing tests**

`src/services/review/sections.test.ts`:

```ts
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

  it('does not strip a word that merely starts the title', () => {
    expect(normalizeHeading('Aim 1: Define gating')).toBe('aim 1 define gating');
  });
});

describe('classifyHeading', () => {
  it('classifies grant headings', () => {
    expect(classifyHeading('Specific Aims', 'grant')).toBe('aims');
    expect(classifyHeading('Project Summary / Abstract', 'grant')).toBe('summary');
    expect(classifyHeading('Project Narrative', 'grant')).toBe('narrative');
    expect(classifyHeading('Research Strategy', 'grant')).toBe('strategy');
    expect(classifyHeading('Background and Significance', 'grant')).toBe('significance');
    expect(classifyHeading('C. Approach', 'grant')).toBe('approach');
    expect(classifyHeading('Preliminary Data', 'grant')).toBe('approach');
    expect(classifyHeading('References Cited', 'grant')).toBe('references');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/review/sections.test.ts`
Expected: FAIL, "Failed to resolve import './sections'".

- [ ] **Step 3: Write the section map**

`src/services/review/sections.ts`:

```ts
/**
 * Split a document into reviewable sections by its headings. Pure: takes a ProseMirror doc, returns ranges and text.
 * A section is a heading plus the blocks up to the next heading of ANY level, so sections never overlap; nesting is
 * carried by the key (the heading path) and by kind inheritance. Only top-level blocks are considered: a heading
 * inside a table cell is not a section boundary.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { formatCitationGroup } from '../../utils/citationFormat';
import type { DocType, Section, SectionKind } from './types';

const REFERENCES = /^(references|references cited|bibliography|literature cited|works cited)$/;

const GRANT_TABLE: [RegExp, SectionKind][] = [
  [/^(project )?summary( \/ abstract)?$|^(project )?abstract$/, 'summary'],
  [/^(project )?narrative$|^public health relevance( statement)?$/, 'narrative'],
  [/^(specific|research) aims?$/, 'aims'],
  [/^research (strategy|plan)$/, 'strategy'],
  [/^(background and )?significance( and background)?$|^background$/, 'significance'],
  [/^innovation$/, 'innovation'],
  [/^(research )?approach$|^preliminary (data|studies|results)$|^research design( and methods)?$/, 'approach'],
];

const MANUSCRIPT_TABLE: [RegExp, SectionKind][] = [
  [/^abstract$|^summary$/, 'abstract'],
  [/^introduction$|^background$/, 'introduction'],
  [/^(materials and |experimental )?methods?$|^methods and materials$|^experimental (procedures|section)$|^star methods$/, 'methods'],
  [/^results( and discussion)?$/, 'results'],
  [/^discussion$|^conclusions?$|^discussion and conclusions?$/, 'discussion'],
];

/** Lowercase, fold diacritics and '&', strip outline numbering ("C.2 ", "A. ", "1 ", "IV) "). */
export function normalizeHeading(title: string): string {
  return title
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:(?:[a-z]|[ivx]+|\d+)(?:\.\d+)+[.):]?\s+|(?:[a-z]|[ivx]+|\d+)[.):]\s+|\d+\s+)/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The kind a heading names on its own, or null when the heading is not a known section name. */
export function classifyHeading(title: string, doc: DocType): SectionKind | null {
  const t = normalizeHeading(title);
  if (REFERENCES.test(t)) return 'references';
  for (const [re, kind] of doc === 'grant' ? GRANT_TABLE : MANUSCRIPT_TABLE) if (re.test(t)) return kind;
  return null;
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'section';
}

/** A specific parent wins; under Research Strategy or unknown content the child's own keyword decides. */
function resolveKind(own: SectionKind | null, parent: SectionKind | undefined): SectionKind {
  if (own === 'references') return own;
  if (parent && parent !== 'any' && parent !== 'strategy') return parent;
  return own ?? parent ?? 'any';
}

function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n\n', leaf => {
    if (leaf.type.name === 'citation') return formatCitationGroup((leaf.attrs.nums as number[]) ?? []);
    if (leaf.type.name === 'hardBreak') return '\n';
    return '';
  });
}

function blocksText(blocks: { node: PMNode }[]): string {
  return blocks.map(b => blockText(b.node)).filter(t => t.trim() !== '').join('\n\n');
}

export function sectionMap(doc: PMNode, docType: DocType): Section[] {
  const blocks: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, offset) => blocks.push({ node, pos: offset }));
  const end = doc.content.size;
  const headings = blocks.map((b, i) => (b.node.type.name === 'heading' ? i : -1)).filter(i => i >= 0);

  if (headings.length === 0) {
    return [{ key: 'document', kind: 'any', title: '', level: 0, from: 0, to: end, headingFrom: 0, headingTo: 0, text: blocksText(blocks) }];
  }

  const out: Section[] = [];
  const preText = blocksText(blocks.slice(0, headings[0]));
  if (preText.trim()) {
    out.push({ key: 'preamble', kind: 'any', title: '', level: 0, from: 0, to: blocks[headings[0]].pos, headingFrom: 0, headingTo: 0, text: preText });
  }

  const stack: { level: number; slug: string; kind: SectionKind }[] = [];
  const seen = new Map<string, number>();
  headings.forEach((hi, n) => {
    const heading = blocks[hi];
    const level = Number(heading.node.attrs.level) || 1;
    const title = heading.node.textContent.trim();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    const kind = resolveKind(classifyHeading(title, docType), parent?.kind);
    const slug = slugify(title);
    const path = [...stack.map(s => s.slug), slug].join('/');
    const count = seen.get(path) ?? 0;
    seen.set(path, count + 1);
    stack.push({ level, slug, kind });

    const nextIdx = n + 1 < headings.length ? headings[n + 1] : blocks.length;
    out.push({
      key: `${path}#${count}`,
      kind,
      title,
      level,
      from: heading.pos,
      to: nextIdx < blocks.length ? blocks[nextIdx].pos : end,
      headingFrom: heading.pos,
      headingTo: heading.pos + heading.node.nodeSize,
      text: blocksText(blocks.slice(hi + 1, nextIdx)),
    });
  });
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/review/sections.test.ts`
Expected: PASS, 16 tests. If `normalizeHeading('IV) Discussion')` fails, check the second alternative of the numbering regex covers `[ivx]+` followed by `)`.

- [ ] **Step 5: Record the references kind in the spec**

In `docs/superpowers/specs/2026-10-10-review-v2-design.md`, §1 `type SectionKind`, change the last line from `  | 'any';` to:

```ts
  | 'references'                                                                                  // bibliography: never reviewed
  | 'any';
```

and in §3.1, after the bullet that begins "A heading the table does not know inherits", add:

```markdown
- "References", "References Cited", "Bibliography", "Literature Cited" and "Works Cited" are `references`: no check
  targets them and their text is never sent to a reviewer.
- A specific parent kind always wins over a child's own keyword (a "Summary" subheading under Approach stays
  `approach`); under `strategy` or `any` the child's keyword decides.
- A preamble section (`key: 'preamble'`, kind `any`) is created only when there is text before the first heading.
```

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add src/services/review/sections.ts src/services/review/sections.test.ts docs/superpowers/specs/2026-10-10-review-v2-design.md
git commit -m "feat(review): section map from document headings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prompt rendering and project period

**Files:**
- Create: `src/services/review/prompt.ts`
- Test: `src/services/review/prompt.test.ts`
- Modify: `src/services/grantTemplates.ts` (interface `GrantTemplate` at line 16; R01/R21/R03 entries at lines 49, 63, 77; `normalizeTemplate` at line 175)
- Create: `src/services/grantTemplates.test.ts`
- Modify: `docs/superpowers/specs/2026-10-10-review-v2-design.md` (§3.2 wire format of `quote`)

**Interfaces:**
- Consumes: `CHECKS`, `checksFor`, `effectiveKinds`, `ROLE_NAMES` (Task 1); `Section`, `SectionKind`, `ReviewerRole`, `DocType`, `ReviewCheck` (Task 1).
- Produces:
  - `interface PromptContext { docType: DocType; sections: Pick<Section, 'key' | 'kind' | 'title'>[]; mechanism?: string; projectYears?: number; funderInstructions?: string; customPreamble?: string }`
  - `interface RolePrompt { role: ReviewerRole; system: string; checkIds: string[]; sectionKeys: string[]; schema: Record<string, unknown> }`
  - `function applicableChecks(docType: DocType, role: ReviewerRole, sections: Pick<Section, 'kind'>[]): ReviewCheck[]`
  - `function renderRolePrompt(role: ReviewerRole, ctx: PromptContext): RolePrompt | null` (null when no check applies)
  - `function sectionMarker(s: Pick<Section, 'key' | 'kind' | 'title'>): string`
  - `function renderSectionedText(sections: Pick<Section, 'key' | 'kind' | 'title' | 'text'>[]): string`
  - `const FUNDER_INSTRUCTIONS_CAP = 4000`
  - `GrantTemplate.projectYears?: number`

- [ ] **Step 1: Write the failing prompt tests**

`src/services/review/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applicableChecks, renderRolePrompt, sectionMarker, renderSectionedText, FUNDER_INSTRUCTIONS_CAP } from './prompt';
import { checksFor } from './checklist';
import { REVIEWER_ROLES, GRANT_KINDS, MANUSCRIPT_KINDS, type DocType, type SectionKind } from './types';

const sec = (key: string, kind: SectionKind, title = key) => ({ key, kind, title });
const allKinds = (doc: DocType) => (doc === 'grant' ? GRANT_KINDS : MANUSCRIPT_KINDS).map(k => sec(`${k}#0`, k));

describe('applicableChecks', () => {
  it('runs every check when no section has a specific kind', () => {
    const only = [sec('document', 'any')];
    expect(applicableChecks('grant', 'statistician', only)).toEqual(checksFor('grant', 'statistician'));
  });

  it('ignores a preamble or references section once specific kinds exist', () => {
    const s = [sec('preamble', 'any'), sec('innovation#0', 'innovation'), sec('references#0', 'references')];
    const ids = applicableChecks('grant', 'reviewer-2', s).map(c => c.id);
    expect(ids).toEqual(['g-imp-innovation']);
  });

  it('expands a lone Research Strategy section into its three parts', () => {
    const ids = applicableChecks('grant', 'statistician', [sec('research-strategy#0', 'strategy')]).map(c => c.id);
    expect(ids).toContain('g-rig-power');
  });

  it('always includes checks scoped to any', () => {
    const ids = applicableChecks('grant', 'consistency', [sec('approach#0', 'approach')]).map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining(['g-con-numbers', 'g-con-terms']));
    expect(ids).not.toContain('g-con-summary');
  });
});

describe('renderRolePrompt', () => {
  for (const doc of ['grant', 'manuscript'] as DocType[]) {
    it(`puts each ${doc} check in exactly one role prompt`, () => {
      const seen = new Map<string, string[]>();
      for (const role of REVIEWER_ROLES) {
        const rp = renderRolePrompt(role, { docType: doc, sections: allKinds(doc) });
        for (const id of rp?.checkIds ?? []) seen.set(id, [...(seen.get(id) ?? []), role]);
      }
      for (const c of checksFor(doc)) expect(seen.get(c.id), c.id).toEqual([c.owner]);
    });
  }

  it('lists each check with its question and pass criterion, and nothing from other roles', () => {
    const rp = renderRolePrompt('statistician', { docType: 'grant', sections: allKinds('grant') })!;
    expect(rp.system).toContain('[g-rig-sabv] Sex as a biological variable');
    expect(rp.system).toContain('Adequate when: the text states that both sexes are studied');
    expect(rp.system).toContain('Factor 2; default severity: major');
    expect(rp.system).not.toContain('g-imp-');
  });

  it('states the 2025 framework, mechanism and period for grants only', () => {
    const g = renderRolePrompt('manager', { docType: 'grant', sections: allKinds('grant'), mechanism: 'R01', projectYears: 5 })!;
    expect(g.system).toContain('Factor 1, Importance of the Research');
    expect(g.system).toContain('Factor 3, Expertise and Resources, is rated sufficient or insufficient');
    expect(g.system).toContain('Mechanism: R01.');
    expect(g.system).toContain('Project period: 5 years.');
    const unknown = renderRolePrompt('manager', { docType: 'grant', sections: allKinds('grant') })!;
    expect(unknown.system).toContain('Project period: not stated');
    const m = renderRolePrompt('manager', { docType: 'manuscript', sections: allKinds('manuscript') })!;
    expect(m.system).not.toContain('Factor 1');
    expect(m.system).not.toContain('Project period');
  });

  it('replaces only the preamble with a custom one', () => {
    const rp = renderRolePrompt('reviewer-2', { docType: 'grant', sections: allKinds('grant'), customPreamble: 'You are Dawid.' })!;
    expect(rp.system.startsWith('You are Dawid.')).toBe(true);
    expect(rp.system).toContain('[g-imp-gap]');
    const blank = renderRolePrompt('reviewer-2', { docType: 'grant', sections: allKinds('grant'), customPreamble: '   ' })!;
    expect(blank.system.startsWith('You are an NIH study section reviewer')).toBe(true);
  });

  it('caps funder instructions', () => {
    const long = 'x'.repeat(FUNDER_INSTRUCTIONS_CAP + 500);
    const rp = renderRolePrompt('manager', { docType: 'grant', sections: allKinds('grant'), funderInstructions: long })!;
    expect(rp.system).toContain('x'.repeat(FUNDER_INSTRUCTIONS_CAP));
    expect(rp.system).not.toContain('x'.repeat(FUNDER_INSTRUCTIONS_CAP + 1));
  });

  it('constrains checkId and sectionKey to the ids and keys in play, excluding references', () => {
    const sections = [sec('aims#0', 'aims'), sec('approach#0', 'approach'), sec('references#0', 'references')];
    const rp = renderRolePrompt('manager', { docType: 'grant', sections })!;
    const item = (rp.schema as any).properties.findings.items;
    expect(item.properties.checkId.enum).toEqual(rp.checkIds);
    expect(item.properties.sectionKey.enum).toEqual(['aims#0', 'approach#0']);
    expect(item.properties.severity.enum).toEqual(['critical', 'major', 'minor']);
    expect(item.required).toEqual(['checkId', 'sectionKey', 'quote', 'issue', 'recommendation', 'severity']);
  });

  it('returns null when no check applies to the role', () => {
    expect(renderRolePrompt('statistician', { docType: 'manuscript', sections: [sec('discussion#0', 'discussion')] })).toBeNull();
  });

  it('contains no quotas', () => {
    for (const role of REVIEWER_ROLES) {
      const rp = renderRolePrompt(role, { docType: 'grant', sections: allKinds('grant') })!;
      expect(rp.system).not.toMatch(/\b\d+\s*(-|to)\s*\d+\s+(suggestions|findings|issues)\b/i);
    }
  });
});

describe('sectioned text', () => {
  it('marks each section and skips references', () => {
    const text = renderSectionedText([
      { key: 'aims#0', kind: 'aims', title: 'Specific Aims', text: 'A.' },
      { key: 'references#0', kind: 'references', title: 'References', text: 'R.' },
      { key: 'document', kind: 'any', title: '', text: 'D.' },
    ]);
    expect(text).toBe('=== [aims] aims#0 — Specific Aims ===\nA.\n\n=== [any] document — (untitled) ===\nD.');
    expect(sectionMarker({ key: 'k', kind: 'approach', title: 'Aim 1' })).toBe('=== [approach] k — Aim 1 ===');
  });
});
```

- [ ] **Step 2: Write the failing template tests**

`src/services/grantTemplates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getGrantTemplate, normalizeTemplate } from './grantTemplates';

describe('grant template project period', () => {
  it('sets projectYears for R01, R21 and R03 only', () => {
    expect(getGrantTemplate('nih-r01')?.projectYears).toBe(5);
    expect(getGrantTemplate('nih-r21')?.projectYears).toBe(2);
    expect(getGrantTemplate('nih-r03')?.projectYears).toBe(2);
    expect(getGrantTemplate('nih-f31')?.projectYears).toBeUndefined();
    expect(getGrantTemplate('custom-grant')?.projectYears).toBeUndefined();
  });

  it('keeps a sane projectYears from a custom template and drops anything else', () => {
    const base = { name: 'T', sections: [{ title: 'Aims' }] };
    expect(normalizeTemplate({ ...base, projectYears: 3 })?.projectYears).toBe(3);
    expect(normalizeTemplate({ ...base, projectYears: '4' })?.projectYears).toBe(4);
    expect(normalizeTemplate({ ...base, projectYears: 0 })?.projectYears).toBeUndefined();
    expect(normalizeTemplate({ ...base, projectYears: 2.5 })?.projectYears).toBeUndefined();
    expect(normalizeTemplate({ ...base, projectYears: 99 })?.projectYears).toBeUndefined();
    expect(normalizeTemplate(base)?.projectYears).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npx vitest run src/services/review/prompt.test.ts src/services/grantTemplates.test.ts`
Expected: FAIL, prompt.test.ts cannot resolve `./prompt`; grantTemplates.test.ts fails on `projectYears` being undefined for R01.

- [ ] **Step 4: Add `projectYears` to grant templates**

In `src/services/grantTemplates.ts`, add to `interface GrantTemplate` after `mechanism: string;`:

```ts
  /** Project period in years, used by the scope and timeline checks. Unset when it varies (fellowships, custom). */
  projectYears?: number;
```

Add `projectYears: 5,` after `mechanism: 'R01',`, `projectYears: 2,` after `mechanism: 'R21',` and `projectYears: 2,` after `mechanism: 'R03',`.

In `normalizeTemplate`, before `return {`, add:

```ts
  const years = Number(raw.projectYears);
```

and add to the returned object after `mechanism: …,`:

```ts
    projectYears: Number.isInteger(years) && years > 0 && years <= 10 ? years : undefined,
```

- [ ] **Step 5: Write the prompt module**

`src/services/review/prompt.ts`:

```ts
/**
 * Render a reviewer role's system prompt and output schema from the checklist. Each check appears in exactly one
 * role's prompt (its owner's); the schema constrains checkId and sectionKey to the ids and keys actually in play.
 * On the wire `quote` is a string and "" means "missing content"; the R2 mapper turns "" into null.
 */
import { checksFor, effectiveKinds } from './checklist';
import type { DocType, ReviewCheck, ReviewerRole, Section } from './types';

export const FUNDER_INSTRUCTIONS_CAP = 4000;

export interface PromptContext {
  docType: DocType;
  sections: Pick<Section, 'key' | 'kind' | 'title'>[];
  /** Activity code from the grant template, e.g. 'R01'. */
  mechanism?: string;
  projectYears?: number;
  /** The author's pasted funder instructions (AISettings grantInstructions). */
  funderInstructions?: string;
  /** customPrompts[role]: replaces the preamble only. */
  customPreamble?: string;
}

export interface RolePrompt {
  role: ReviewerRole;
  system: string;
  checkIds: string[];
  sectionKeys: string[];
  schema: Record<string, unknown>;
}

const PREAMBLES: Record<DocType, Record<ReviewerRole, string>> = {
  grant: {
    manager: 'You are an NIH study section reviewer focused on the logic of the aims: whether the hypothesis can be tested, whether each aim stands on its own, whether the scope fits the project period, and whether the Approach delivers what the Specific Aims page promises.',
    'reviewer-2': 'You are an NIH study section reviewer focused on the importance of the research: the knowledge gap, why closing it matters, the strength of the premise, and whether the claimed innovation is real.',
    statistician: 'You are an NIH study section reviewer focused on rigor: experimental design, sample size and power, the statistical plan, sex as a biological variable, randomization and blinding, replication, and authentication of key resources.',
    researcher: 'You are an NIH study section reviewer focused on feasibility and the team: preliminary data, potential problems and alternatives, interpretable outcomes, the timeline, and whether the text shows the expertise and resources the work needs.',
    consistency: 'You are an NIH study section reviewer checking that the application agrees with itself: numbers, names and abbreviations, citations for factual claims, and the Project Summary against the Specific Aims.',
  },
  manuscript: {
    manager: 'You are a journal peer reviewer focused on structure and logic: whether each section does its job, whether the results answer the question the introduction poses, and whether the abstract matches the results.',
    'reviewer-2': 'You are a journal peer reviewer focused on importance and claims: the research question, the advance over prior work, and whether the conclusions are supported by the data.',
    statistician: 'You are a journal peer reviewer focused on statistics and rigor: named tests, sample sizes, variability, effect sizes, multiple comparisons, and controls.',
    researcher: 'You are a journal peer reviewer focused on methods and reproducibility: enough detail to repeat the work, identified materials, stated limitations, and data availability.',
    consistency: 'You are a journal peer reviewer checking that the paper agrees with itself: numbers, terms and abbreviations, figure and table references, and citations for factual claims.',
  },
};

const FRAMEWORK =
  'NIH reviews research applications under the Simplified Peer Review Framework (applications due on or after 25 January 2025). ' +
  'Factor 1, Importance of the Research, covers significance and innovation and is scored 1-9. ' +
  'Factor 2, Rigor and Feasibility, covers the approach and is scored 1-9. ' +
  'Factor 3, Expertise and Resources, is rated sufficient or insufficient. Each check below says which factor it informs.';

const RULES = [
  'Report a finding only for a check that FAILS. Report nothing for a check that passes, and do not mention passing checks.',
  'Report at most one finding per check per section, unless the problems are clearly distinct.',
  '"quote" must be copied exactly from the text, a phrase or a sentence long. When the problem is that something is missing, set "quote" to "" and use the sectionKey of the section where the missing material belongs.',
  '"sectionKey" must be one of the keys shown in the === section markers.',
  'Never write replacement text. Never invent data, numbers, citations or results. Say what the author must add or change.',
  '"issue" states what a reviewer would criticise, in one or two sentences. "recommendation" states what to add or change, in one sentence.',
  'Severity: "critical" would sink the document on its own; "major" would cost points with reviewers; "minor" is worth fixing. Use the default severity unless the text gives a reason to differ.',
  'Return JSON only, matching the schema.',
];

export function applicableChecks(docType: DocType, role: ReviewerRole, sections: Pick<Section, 'kind'>[]): ReviewCheck[] {
  const own = checksFor(docType, role);
  const specific = sections.map(s => s.kind).filter(k => k !== 'any' && k !== 'references');
  if (specific.length === 0) return own;
  const kinds = effectiveKinds(specific);
  return own.filter(c => c.sections.includes('any') || c.sections.some(k => kinds.has(k)));
}

function factorLabel(c: ReviewCheck): string {
  if (c.factor === undefined) return `default severity: ${c.severity}`;
  const f = c.factor === 'presentation' ? 'presentation' : `Factor ${c.factor}`;
  return `${f}; default severity: ${c.severity}`;
}

export function renderRolePrompt(role: ReviewerRole, ctx: PromptContext): RolePrompt | null {
  const checks = applicableChecks(ctx.docType, role, ctx.sections);
  if (checks.length === 0) return null;
  const sectionKeys = ctx.sections.filter(s => s.kind !== 'references').map(s => s.key);

  const parts: string[] = [ctx.customPreamble?.trim() || PREAMBLES[ctx.docType][role]];
  if (ctx.docType === 'grant') {
    const context = [FRAMEWORK];
    if (ctx.mechanism?.trim()) context.push(`Mechanism: ${ctx.mechanism.trim()}.`);
    context.push(ctx.projectYears ? `Project period: ${ctx.projectYears} years.` : 'Project period: not stated; judge scope against the mechanism.');
    parts.push(context.join('\n'));
  }
  const funder = ctx.funderInstructions?.trim();
  if (funder) parts.push(`Funder instructions from the author:\n"""\n${funder.slice(0, FUNDER_INSTRUCTIONS_CAP)}\n"""`);
  parts.push(
    'Checks you own. Report a finding only when a check fails:\n' +
      checks.map((c, i) => `${i + 1}. [${c.id}] ${c.name} (${factorLabel(c)}). ${c.question} Adequate when: ${c.passes.replace(/^Adequate when /, '')}`).join('\n'),
  );
  parts.push('Rules:\n' + RULES.map(r => `- ${r}`).join('\n'));

  const checkIds = checks.map(c => c.id);
  return {
    role,
    system: parts.join('\n\n'),
    checkIds,
    sectionKeys,
    schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              checkId: { type: 'string', enum: checkIds },
              sectionKey: { type: 'string', enum: sectionKeys },
              quote: { type: 'string' },
              issue: { type: 'string' },
              recommendation: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
            },
            required: ['checkId', 'sectionKey', 'quote', 'issue', 'recommendation', 'severity'],
          },
        },
      },
      required: ['findings'],
    },
  };
}

export function sectionMarker(s: Pick<Section, 'key' | 'kind' | 'title'>): string {
  return `=== [${s.kind}] ${s.key} — ${s.title || '(untitled)'} ===`;
}

export function renderSectionedText(sections: Pick<Section, 'key' | 'kind' | 'title' | 'text'>[]): string {
  return sections
    .filter(s => s.kind !== 'references')
    .map(s => `${sectionMarker(s)}\n${s.text}`)
    .join('\n\n');
}
```

Every `passes` string begins with "Adequate when", so the renderer strips that prefix to avoid "Adequate when: Adequate when"; the rendered line reads `Adequate when: the text states that both sexes are studied`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/services/review/prompt.test.ts src/services/grantTemplates.test.ts`
Expected: PASS, 16 tests (14 + 2).

- [ ] **Step 7: Record the wire format in the spec**

In `docs/superpowers/specs/2026-10-10-review-v2-design.md` §3.2, replace the JSON example line

```json
{ "findings": [ { "checkId": "...", "sectionKey": "...", "quote": "... or null", "issue": "...", "recommendation": "...", "severity": "critical|major|minor" } ] }
```

with

```json
{ "findings": [ { "checkId": "...", "sectionKey": "...", "quote": "... or \"\" when missing", "issue": "...", "recommendation": "...", "severity": "critical|major|minor" } ] }
```

and add after it: `On the wire "quote" is always a string, because not every provider's constrained decoding accepts a nullable type; "" means a missing-content finding and the mapper turns it into quote: null.`

- [ ] **Step 8: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add src/services/review/prompt.ts src/services/review/prompt.test.ts src/services/grantTemplates.ts src/services/grantTemplates.test.ts docs/superpowers/specs/2026-10-10-review-v2-design.md
git commit -m "feat(review): render role prompts and schemas from the checklist; template project period

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Eval fixtures

**Files:**
- Create: `scripts/eval/review/fixtures/types.ts`
- Create: `scripts/eval/review/fixtures/build.ts`
- Create: `scripts/eval/review/fixtures/grant.ts`
- Create: `scripts/eval/review/fixtures/manuscript.ts`
- Test: `scripts/eval/review/fixtures.test.ts`
- Modify: `docs/superpowers/specs/2026-10-10-review-v2-design.md` (§6 fixture size and §1.2 sections)

**Interfaces:**
- Consumes: `checkById` (Task 1); `sectionMap` (Task 2); `getSpecSchema` from `src/extensions/schemaSpecs.ts`; `flattenDoc` from `src/utils/textMatch.ts`.
- Produces:
  - `interface FixtureSection { level: 1 | 2 | 3; title: string; paragraphs: string[] }`
  - `interface Expectation { id: string; checkId: string; sectionTitles: string[]; quoteHints?: string[]; keywords: RegExp; alsoIn?: { sectionTitle: string; mention: RegExp }[]; note: string }`
  - `interface ReviewFixture { id: string; docType: DocType; mechanism?: string; projectYears?: number; sections: FixtureSection[]; planted: Expectation[]; traps: Expectation[] }`
  - `function fixtureDocJson(fx: ReviewFixture): JSONContent`
  - `function fixtureDoc(fx: ReviewFixture): PMNode`
  - `function fixtureHtml(fx: ReviewFixture): string`
  - `function fixturePlainText(fx: ReviewFixture): string` (equals what `editorRef.getPlainText()` returns: `flattenDoc(doc).text`)
  - `const GRANT_FIXTURE: ReviewFixture`, `const MANUSCRIPT_FIXTURE: ReviewFixture`

- [ ] **Step 1: Write the fixture types and builders**

`scripts/eval/review/fixtures/types.ts`:

```ts
import type { DocType } from '../../../../src/services/review/types';

export interface FixtureSection {
  level: 1 | 2 | 3;
  title: string;
  paragraphs: string[];
}

/**
 * A planted weakness (the review should report it) or a trap (a passage that satisfies a check; a finding here is a
 * false alarm). A finding matches when it is on topic (same checkId, or its text matches `keywords`) AND located:
 * its quote overlaps a `quoteHints` entry; or it has no quote and sits in one of `sectionTitles`; or it carries no
 * quoteHints at all and sits in one of `sectionTitles`; or it sits in an `alsoIn` section and mentions `mention`.
 */
export interface Expectation {
  id: string;
  checkId: string;
  sectionTitles: string[];
  quoteHints?: string[];
  /** Case-insensitive, no `g` flag (RegExp.test must stay stateless). */
  keywords: RegExp;
  alsoIn?: { sectionTitle: string; mention: RegExp }[];
  note: string;
}

export interface ReviewFixture {
  id: string;
  docType: DocType;
  mechanism?: string;
  projectYears?: number;
  sections: FixtureSection[];
  planted: Expectation[];
  traps: Expectation[];
}
```

`scripts/eval/review/fixtures/build.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { getSpecSchema } from '../../../../src/extensions/schemaSpecs';
import { flattenDoc } from '../../../../src/utils/textMatch';
import type { ReviewFixture } from './types';

const text = (t: string): JSONContent[] => (t ? [{ type: 'text', text: t }] : []);

export function fixtureDocJson(fx: ReviewFixture): JSONContent {
  const content: JSONContent[] = [];
  for (const s of fx.sections) {
    content.push({ type: 'heading', attrs: { level: s.level }, content: text(s.title) });
    for (const para of s.paragraphs) content.push({ type: 'paragraph', content: text(para) });
  }
  return { type: 'doc', content };
}

export function fixtureDoc(fx: ReviewFixture): PMNode {
  return getSpecSchema().nodeFromJSON(fixtureDocJson(fx));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fixtureHtml(fx: ReviewFixture): string {
  return fx.sections
    .map(s => `<h${s.level}>${esc(s.title)}</h${s.level}>` + s.paragraphs.map(p => `<p>${esc(p)}</p>`).join(''))
    .join('');
}

/** The same plain text the app sends to the current pipeline (`editorRef.getPlainText()` = flattenDoc). */
export function fixturePlainText(fx: ReviewFixture): string {
  return flattenDoc(fixtureDoc(fx)).text;
}
```

- [ ] **Step 2: Write the grant fixture**

`scripts/eval/review/fixtures/grant.ts`:

```ts
/**
 * Synthetic R01 for the review eval (about 1,500 words). The topic is invented and unrelated to the author's own
 * grants. 15 planted weaknesses, 8 traps. Every quoteHint must appear verbatim exactly once (fixtures.test.ts).
 */
import type { ReviewFixture } from './types';

export const SUMMARY = 'Project Summary';
export const AIMS = 'Specific Aims';
export const STRATEGY = 'Research Strategy';
export const SIG = 'Significance';
export const INNOV = 'Innovation';
export const APPROACH = 'Approach';
export const PRELIM = 'Preliminary Data';
export const AIM1 = 'Aim 1: Define how S124 phosphorylation changes MICU1 gating';
export const AIM2 = 'Aim 2: Determine whether blocking MICU1 phosphorylation protects the heart under pressure overload';
export const AIM3 = 'Aim 3: Test whether inhibiting the S124 kinase reverses established hypertrophy';
export const RIGOR = 'Rigor and Reproducibility';
export const TIMELINE = 'Timeline';

export const GRANT_FIXTURE: ReviewFixture = {
  id: 'grant-r01-micu1',
  docType: 'grant',
  mechanism: 'R01',
  projectYears: 5,
  sections: [
    { level: 1, title: SUMMARY, paragraphs: [
      'Heart failure affects more than six million adults in the United States, and half of patients die within five years of diagnosis [1]. Mitochondrial calcium overload is a shared step in cardiomyocyte death across many forms of heart disease. The mitochondrial calcium uniporter (MCU) carries calcium into the mitochondrial matrix, and its gatekeeper subunit MICU1 sets the threshold at which the channel opens. We found that MICU1 is phosphorylated at serine 124 in failing human hearts and that this modification lowers the opening threshold. This application will define how MICU1 phosphorylation controls calcium uptake, test whether blocking it protects the heart under pressure overload, and develop an AAV gene therapy vector that delivers a phosphorylation-resistant MICU1 to failing hearts. The work will identify a regulatory switch that could be targeted to slow the progression of heart failure.',
    ] },
    { level: 1, title: AIMS, paragraphs: [
      'Calcium overload of mitochondria is a final common pathway of cardiomyocyte death in heart failure. The MCU channel admits calcium into mitochondria, and its activity is gated by MICU1, which keeps the channel closed at resting cytosolic calcium. How this gate is regulated in the diseased heart is unknown.',
      'Our preliminary data show that MICU1 is phosphorylated at serine 124 (S124) in left ventricular tissue from patients with heart failure and in mice after transverse aortic constriction (TAC). A phosphomimetic MICU1 lowered the calcium threshold for MCU opening in isolated cardiomyocytes. We hypothesize that MCU plays an important role in cardiac disease. The objective of this application is to determine how S124 phosphorylation regulates MICU1 and whether preventing it protects the pressure-overloaded heart.',
      'Aim 1. Define how S124 phosphorylation changes MICU1 gating. We will measure mitochondrial calcium uptake in cardiomyocytes expressing wild-type, phosphomimetic (S124D) and phosphorylation-resistant (S124A) MICU1, identify the kinase responsible, and generate S124A and S124D knock-in mouse lines.',
      'Aim 2. Determine whether blocking MICU1 phosphorylation protects the heart under pressure overload. Aim 2 will use the MICU1 knock-in lines generated and validated in Aim 1, and will subject S124A knock-in mice to TAC. Aim 2b will test the same mechanism in human iPSC-derived cardiomyocytes from patients with dilated cardiomyopathy.',
      'Aim 3. Test whether inhibiting the S124 kinase reverses established hypertrophy. We will treat mice with the kinase inhibitor after hypertrophy has developed and follow cardiac function by echocardiography.',
      'Completion of these aims will establish MICU1 phosphorylation as a regulated gate of mitochondrial calcium entry in the failing heart and will test a druggable route to protect it.',
    ] },
    { level: 1, title: STRATEGY, paragraphs: [] },
    { level: 2, title: SIG, paragraphs: [
      'Heart failure remains a leading cause of death, and current therapies slow but do not stop its progression [1,2]. Mitochondrial calcium overload opens the permeability transition pore and triggers cardiomyocyte necrosis, a process documented in pressure overload, ischemia and chemotherapy-induced cardiomyopathy [5].',
      'Prior work [3,4] established that deleting MCU protects the heart from acute ischemic injury, although those studies used global knockouts and could not separate cardiac from systemic effects. Our cardiomyocyte-specific approach addresses this limitation.',
      'No study has yet examined MICU1 phosphorylation in cardiomyocytes; this gap must be filled.',
      'In our preliminary cohort of 40 patients with end-stage heart failure, MICU1 S124 phosphorylation was elevated in every sample compared with non-failing donor hearts.',
      "If phosphorylation of MICU1 lowers the gate in disease, preventing it would limit calcium overload while preserving the physiological calcium signals that match energy supply to demand. This would be a more selective strategy than blocking MCU itself, which impairs the heart's response to adrenergic stress [6].",
    ] },
    { level: 2, title: INNOV, paragraphs: [
      'This proposal is the first to identify a post-translational switch on MICU1 in the heart. We will combine knock-in mouse models with patient-derived cardiomyocytes to test the switch in both species.',
      'The use of echocardiography to measure cardiac function in mice is a highly innovative aspect of this proposal.',
      'Aim 2 also introduces serial block-face scanning electron microscopy (SBF-SEM) to reconstruct mitochondrial networks across entire cardiomyocytes after pressure overload.',
    ] },
    { level: 2, title: APPROACH, paragraphs: [] },
    { level: 3, title: PRELIM, paragraphs: [
      'MICU1 S124 phosphorylation was detected with a phospho-specific antibody that we validated in MICU1 knockout cardiomyocytes. In isolated adult cardiomyocytes, expression of MICU1 S124D increased mitochondrial calcium uptake by 2.1-fold relative to wild-type MICU1 (n = 6 independent preparations, Fig. 1).',
      'Phosphorylation was elevated in left ventricular samples from the 60-patient cohort described in Significance, and it rose within one week of TAC in mice (Fig. 2).',
      'In HEK293 cells, a kinase screen identified CaMKII and PKD1 as candidate S124 kinases; both phosphorylated recombinant MICU1 in vitro (Fig. 3).',
    ] },
    { level: 3, title: AIM1, paragraphs: [
      'Rationale. Our preliminary data show that S124D lowers the calcium threshold for MCU opening, but the structural basis and the responsible kinase are unknown.',
      'Experimental design. Adult cardiomyocytes from male and female mice will be transduced with adenovirus expressing wild-type, S124D or S124A MICU1 on a MICU1-knockout background. Mitochondrial calcium uptake will be measured with the matrix-targeted indicator mtGCaMP6f at clamped cytosolic calcium concentrations from 100 nM to 10 µM. In parallel, we will generate S124A and S124D knock-in mouse lines by CRISPR editing and confirm the edit by sequencing and phospho-specific immunoblotting. To identify the kinase, we will test CaMKII and PKD1 with selective inhibitors and with cardiomyocyte-specific knockout mice.',
      "Statistical analysis. Comparisons between genotypes will use two-way ANOVA (genotype × sex) with Tukey's post hoc test; the calcium threshold will be fitted with a Hill equation and compared by extra-sum-of-squares F test.",
      'Expected outcomes. We expect S124D to shift the threshold to lower calcium and S124A to resist the shift, which would support the hypothesis; no shift with S124D would argue that phosphorylation acts through a different subunit.',
      'Potential problems and alternative strategies. If adenoviral expression alters MICU1 stoichiometry, we will use the knock-in lines instead. If neither CaMKII nor PKD1 is responsible, we will perform an unbiased kinase screen with phosphoproteomics of TAC hearts.',
    ] },
    { level: 3, title: AIM2, paragraphs: [
      'Rationale. If S124 phosphorylation drives calcium overload, mice that cannot phosphorylate MICU1 should be protected from TAC-induced heart failure.',
      'Experimental design. This aim can only begin once the S124A knock-in line from Aim 1 is validated. Male C57BL/6J mice aged 10-12 weeks, wild-type or S124A knock-in, will undergo TAC or sham surgery. Cardiac function will be followed by echocardiography for eight weeks, after which hearts will be collected for histology, mitochondrial calcium retention capacity and SBF-SEM.',
      'Although our laboratory has not previously performed SBF-SEM, we expect to learn it quickly.',
      'Data will be analyzed using appropriate statistical methods.',
      'Expected outcomes. S124A mice should preserve ejection fraction and show less fibrosis and mitochondrial swelling after TAC than wild-type mice.',
    ] },
    { level: 3, title: AIM3, paragraphs: [
      'Rationale. A therapy for heart failure must work after disease is established. We will test whether inhibiting the S124 kinase after hypertrophy develops restores function.',
      'Experimental design. Mice will undergo TAC and, four weeks later, receive the kinase inhibitor or vehicle for four weeks, using eight mice per group. Mice will be assigned to treatment groups and echocardiography will be performed by the PI.',
      'Expected outcomes. We expect kinase inhibition to lower MICU1 phosphorylation and to improve ejection fraction relative to vehicle.',
      'Potential problems and alternative strategies. If the inhibitor has off-target effects on cardiac contractility, we will use an inducible cardiomyocyte-specific knockout of the kinase.',
    ] },
    { level: 3, title: RIGOR, paragraphs: [
      'Power analysis. For Aims 1 and 2, n = 12 mice per group gives 80% power (alpha = 0.05, two-sided) to detect a 25% difference in ejection fraction, based on the variance in our TAC studies (SD 15%).',
      'Male and female mice will be studied in equal numbers in Aim 1, and sex will be included as a biological variable in all Aim 1 analyses.',
      'All antibodies are validated in knockout tissue, and cell lines are authenticated by STR profiling, as described in the Authentication of Key Resources attachment.',
      'Investigators performing histology and image analysis in Aims 1 and 2 will be blinded to genotype, and animals will be randomized to surgery by a random number table.',
    ] },
    { level: 3, title: TIMELINE, paragraphs: [
      'Aim 1 studies will run from Year 1 through Year 3. Aim 2 will start in Year 2, once the knock-in lines are validated, and finish in Year 4. Aim 3 studies will run from Year 4 through Year 6.',
    ] },
  ],
  planted: [
    { id: 'P1-dependent-aims', checkId: 'g-log-independent', sectionTitles: [AIMS, AIM2, TIMELINE],
      quoteHints: ['Aim 2 will use the MICU1 knock-in lines generated and validated in Aim 1', 'This aim can only begin once the S124A knock-in line from Aim 1 is validated'],
      keywords: /depend|interdepend|contingent|sequential|relies on aim 1|requires aim 1|cannot (begin|start|proceed)/i,
      note: 'Aim 2 needs the knock-in lines from Aim 1' },
    { id: 'P2-no-power-aim3', checkId: 'g-rig-power', sectionTitles: [AIM3], quoteHints: ['using eight mice per group'],
      keywords: /power|sample size/i, alsoIn: [{ sectionTitle: RIGOR, mention: /aim 3/i }],
      note: 'Aim 3 n = 8 is not justified; the power analysis covers Aims 1 and 2 only' },
    { id: 'P3-sabv-aim2', checkId: 'g-rig-sabv', sectionTitles: [AIM2], quoteHints: ['Male C57BL/6J mice aged 10-12 weeks'],
      keywords: /\bsex\b|female|biological variable|sabv/i, alsoIn: [{ sectionTitle: RIGOR, mention: /aim 2/i }],
      note: 'Aim 2 uses male mice only, without justification' },
    { id: 'P4-aim2b-missing', checkId: 'g-log-aims-approach', sectionTitles: [AIMS, AIM2],
      quoteHints: ['Aim 2b will test the same mechanism in human iPSC-derived cardiomyocytes'],
      keywords: /ipsc|aim 2b|not (described|addressed|covered)|absent from|missing from/i,
      note: 'Aim 2b on the Aims page never appears in the Approach' },
    { id: 'P5-cohort-size', checkId: 'g-con-numbers', sectionTitles: [SIG, PRELIM],
      quoteHints: ['our preliminary cohort of 40 patients', 'the 60-patient cohort described in Significance'],
      keywords: /\b40\b|\b60\b|inconsisten|mismatch|discrepan/i,
      note: 'Cohort is 40 in Significance and 60 in Preliminary Data' },
    { id: 'P6-innovation-echo', checkId: 'g-imp-innovation', sectionTitles: [INNOV],
      quoteHints: ['The use of echocardiography to measure cardiac function in mice is a highly innovative aspect of this proposal.'],
      keywords: /innovat|standard|routine|incremental|not novel|conventional/i,
      note: 'Echocardiography is routine, not innovative' },
    { id: 'P7-no-alternatives-aim2', checkId: 'g-fea-pitfalls', sectionTitles: [AIM2],
      keywords: /alternative|pitfall|potential problem|contingency|fallback/i,
      note: 'Aim 2 has no potential problems or alternatives' },
    { id: 'P8-timeline-overrun', checkId: 'g-fea-timeline', sectionTitles: [TIMELINE],
      quoteHints: ['Aim 3 studies will run from Year 4 through Year 6'],
      keywords: /year 6|six years|beyond|exceed|project period|five-year|5-year/i,
      note: 'Timeline runs past the five-year period' },
    { id: 'P9-summary-extra-aim', checkId: 'g-con-summary', sectionTitles: [SUMMARY],
      quoteHints: ['develop an AAV gene therapy vector that delivers a phosphorylation-resistant MICU1'],
      keywords: /gene therapy|\baav\b|vector|not (in|among|part of) the (specific )?aims/i,
      note: 'Summary promises a gene therapy vector that no aim delivers' },
    { id: 'P10-vague-hypothesis', checkId: 'g-log-hypothesis', sectionTitles: [AIMS],
      quoteHints: ['We hypothesize that MCU plays an important role in cardiac disease.'],
      keywords: /hypothes|testable|falsifiable|vague|important role/i,
      note: 'Hypothesis is not testable' },
    { id: 'P11-gap-filling', checkId: 'g-imp-why', sectionTitles: [SIG],
      quoteHints: ['No study has yet examined MICU1 phosphorylation in cardiomyocytes; this gap must be filled.'],
      keywords: /why|matter|consequence|gap.filling|for its own sake/i,
      note: 'Gap stated without why it matters' },
    { id: 'P12-stats-aim2', checkId: 'g-rig-stats', sectionTitles: [AIM2],
      quoteHints: ['Data will be analyzed using appropriate statistical methods.'],
      keywords: /statistic|named test|analysis plan|appropriate/i,
      note: 'Aim 2 names no statistical test' },
    { id: 'P13-blinding-aim3', checkId: 'g-rig-bias', sectionTitles: [AIM3],
      quoteHints: ['echocardiography will be performed by the PI'],
      keywords: /blind|random/i, alsoIn: [{ sectionTitle: RIGOR, mention: /aim 3/i }],
      note: 'Aim 3 has no randomization or blinding; the PI scores outcomes' },
    { id: 'P14-no-prelim-aim3', checkId: 'g-fea-prelim', sectionTitles: [AIM3],
      quoteHints: ['receive the kinase inhibitor or vehicle for four weeks'],
      keywords: /preliminary|pilot|in vivo (data|evidence)|dose|feasibility data/i,
      note: 'No in vivo data that the inhibitor reaches the heart or lowers phosphorylation' },
    { id: 'P15-sbfsem-expertise', checkId: 'g-exp-expertise', sectionTitles: [AIM2],
      quoteHints: ['Although our laboratory has not previously performed SBF-SEM, we expect to learn it quickly.'],
      keywords: /expertise|collaborat|experience|consultant|core facility|train/i,
      note: 'No SBF-SEM expertise and no collaborator' },
  ],
  traps: [
    { id: 'T1-power-present', checkId: 'g-rig-power', sectionTitles: [RIGOR], quoteHints: ['n = 12 mice per group gives 80% power'],
      keywords: /power|sample size/i, note: 'Power analysis for Aims 1 and 2 is present' },
    { id: 'T2-sabv-aim1', checkId: 'g-rig-sabv', sectionTitles: [RIGOR], quoteHints: ['sex will be included as a biological variable in all Aim 1 analyses'],
      keywords: /\bsex\b|female|biological variable|sabv/i, note: 'SABV handled for Aim 1' },
    { id: 'T3-alternatives-aim1', checkId: 'g-fea-pitfalls', sectionTitles: [AIM1],
      quoteHints: ['If neither CaMKII nor PKD1 is responsible, we will perform an unbiased kinase screen'],
      keywords: /alternative|pitfall|potential problem|contingency|fallback/i, note: 'Aim 1 has alternatives' },
    { id: 'T4-mcu-defined', checkId: 'g-con-terms', sectionTitles: [SUMMARY], quoteHints: ['The mitochondrial calcium uniporter (MCU)'],
      keywords: /abbreviat|defin|\bmcu\b/i, note: 'MCU is defined at first use' },
    { id: 'T5-stats-aim1', checkId: 'g-rig-stats', sectionTitles: [AIM1], quoteHints: ["two-way ANOVA (genotype × sex) with Tukey's post hoc test"],
      keywords: /statistic|anova|post hoc|multiple comparison/i, note: 'Aim 1 statistics are named' },
    { id: 'T6-prelim-aim1', checkId: 'g-fea-prelim', sectionTitles: [PRELIM],
      quoteHints: ['increased mitochondrial calcium uptake by 2.1-fold relative to wild-type MICU1'],
      keywords: /preliminary|pilot|feasib/i, note: 'Aim 1 is backed by preliminary data' },
    { id: 'T7-authentication', checkId: 'g-rig-resources', sectionTitles: [RIGOR],
      quoteHints: ['cell lines are authenticated by STR profiling'],
      keywords: /authenticat|validat|antibod|str profil/i, note: 'Key resources are authenticated' },
    { id: 'T8-premise-limits', checkId: 'g-imp-premise', sectionTitles: [SIG],
      quoteHints: ['although those studies used global knockouts and could not separate cardiac from systemic effects'],
      keywords: /premise|prior (work|studies)|rigor of|global knockout/i, note: 'Premise cites prior work and its limits' },
  ],
};
```

- [ ] **Step 3: Write the manuscript fixture**

`scripts/eval/review/fixtures/manuscript.ts`:

```ts
/**
 * IMRAD manuscript for the review eval: the July 2026 fixture (scripts/eval/fixture.ts) re-tagged with check ids,
 * given an Abstract and headings, plus traps. Editing seeds (passive voice, filler) stay in the old harness for R4.
 */
import type { ReviewFixture } from './types';

export const ABSTRACT = 'Abstract';
export const INTRO = 'Introduction';
export const METHODS = 'Methods';
export const RESULTS = 'Results';
export const DISCUSSION = 'Discussion';

export const MANUSCRIPT_FIXTURE: ReviewFixture = {
  id: 'manuscript-compound-x',
  docType: 'manuscript',
  sections: [
    { level: 1, title: ABSTRACT, paragraphs: [
      'Compound X killed tumor cells in culture. In a survival model, survival increased by 30% with treatment. These results suggest compound X as a candidate anticancer agent.',
    ] },
    { level: 1, title: INTRO, paragraphs: [
      'It was observed by us that tumor cells died rapidly following exposure to compound X. This is well established in the literature. Cancer is a disease that affects 10 million people. Compound X inhibits the proteasome [3]. In order to characterize this effect, we performed an analysis of cell viability across many samples.',
    ] },
    { level: 1, title: METHODS, paragraphs: [
      'Cells were treated with compound X. Viability was measured. We used a t-test. The experiment was performed and the data were collected by the team over a period of time. RNA was extracted using standard methods, and qPCR was carried out on all samples.',
    ] },
    { level: 1, title: RESULTS, paragraphs: [
      'Treatment significantly improved survival. The results prove that compound X is the gold standard for cancer therapy. Viability increased by a lot (p < 0.05). Of note, the treated group showed a mean of 42 while, importantly, the control group was much lower. In the abstract we reported that survival increased by 30%, but here the increase was 50%.',
      "Apoptosis rose from 8% to 31% (mean ± SD, n = 6 per group; Welch's t-test, p = 0.002).",
    ] },
    { level: 1, title: DISCUSSION, paragraphs: [
      'Our findings are very important and could potentially possibly suggest a new avenue. This proves that compound X will cure cancer in humans. The mechanism, which is complex, remains to be determined — but the implications are clear.',
      'A limitation of this study is that all experiments used a single cell line, so the effect may not generalize.',
    ] },
  ],
  planted: [
    { id: 'M1-results-prove', checkId: 'm-imp-overclaim', sectionTitles: [RESULTS], quoteHints: ['The results prove that compound X'],
      keywords: /prove|overclaim|overstat|unsupported|causal|exceed/i, note: '"prove" exceeds the data' },
    { id: 'M2-cure-cancer', checkId: 'm-imp-overclaim', sectionTitles: [DISCUSSION], quoteHints: ['This proves that compound X will cure cancer in humans.'],
      keywords: /prove|overclaim|overstat|generali|humans|cure/i, note: 'generalises from cells to curing humans' },
    { id: 'M3-well-established', checkId: 'm-con-uncited', sectionTitles: [INTRO], quoteHints: ['This is well established in the literature.'],
      keywords: /citation|cite|reference|source/i, note: 'claim with no citation' },
    { id: 'M4-prevalence', checkId: 'm-con-uncited', sectionTitles: [INTRO], quoteHints: ['Cancer is a disease that affects 10 million people.'],
      keywords: /citation|cite|reference|source/i, note: 'prevalence with no citation' },
    { id: 'M5-gold-standard', checkId: 'm-con-uncited', sectionTitles: [RESULTS], quoteHints: ['the gold standard for cancer therapy'],
      keywords: /citation|cite|reference|evidence for/i, note: 'definitive claim with no citation' },
    { id: 'M6-significant-no-test', checkId: 'm-rig-tests', sectionTitles: [RESULTS], quoteHints: ['Treatment significantly improved survival.'],
      keywords: /test|statistic|significan|effect size|p.value/i, note: '"significantly" with no test' },
    { id: 'M7-p-no-test', checkId: 'm-rig-tests', sectionTitles: [RESULTS], quoteHints: ['Viability increased by a lot (p < 0.05).'],
      keywords: /test|statistic|effect size|p.value/i, note: 'p-value with no named test or effect size' },
    { id: 'M8-mean-no-variability', checkId: 'm-rig-variability', sectionTitles: [RESULTS], quoteHints: ['the treated group showed a mean of 42'],
      keywords: /\bsd\b|sem|standard (deviation|error)|variab|confidence interval|\bci\b/i, note: 'mean with no variability' },
    { id: 'M9-abstract-mismatch', checkId: 'm-con-numbers', sectionTitles: [ABSTRACT, RESULTS],
      quoteHints: ['survival increased by 30% with treatment', 'but here the increase was 50%'],
      keywords: /30|50|inconsisten|mismatch|discrepan|contradict/i, note: 'abstract 30% vs results 50%' },
    { id: 'M10-viability-method', checkId: 'm-met-reproducible', sectionTitles: [METHODS], quoteHints: ['Viability was measured.'],
      keywords: /detail|assay|how|reproduc|replicat|specif/i, note: 'no assay named' },
    { id: 'M11-qpcr-undefined', checkId: 'm-con-terms', sectionTitles: [METHODS], quoteHints: ['qPCR was carried out on all samples'],
      keywords: /abbreviat|defin|qpcr/i, note: 'qPCR not defined' },
  ],
  traps: [
    { id: 'MT1-welch-test', checkId: 'm-rig-tests', sectionTitles: [RESULTS], quoteHints: ["Welch's t-test, p = 0.002"],
      keywords: /test|statistic/i, note: 'test is named' },
    { id: 'MT2-sd', checkId: 'm-rig-variability', sectionTitles: [RESULTS], quoteHints: ['Apoptosis rose from 8% to 31% (mean ± SD'],
      keywords: /\bsd\b|sem|standard (deviation|error)|variab/i, note: 'variability is named' },
    { id: 'MT3-n-reported', checkId: 'm-rig-n', sectionTitles: [RESULTS], quoteHints: ['n = 6 per group'],
      keywords: /\bn\b|sample size|number of/i, note: 'n is reported' },
    { id: 'MT4-limitation', checkId: 'm-met-limitations', sectionTitles: [DISCUSSION],
      quoteHints: ['A limitation of this study is that all experiments used a single cell line'],
      keywords: /limitation/i, note: 'limitation is stated' },
    { id: 'MT5-proteasome-cited', checkId: 'm-con-uncited', sectionTitles: [INTRO], quoteHints: ['Compound X inhibits the proteasome'],
      keywords: /citation|cite|reference|source/i, note: 'claim is cited' },
  ],
};
```

- [ ] **Step 4: Write the failing integrity tests**

`scripts/eval/review/fixtures.test.ts`:

```ts
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
  it('maps to IMRAD kinds', () => {
    const s = sectionMap(fixtureDoc(MANUSCRIPT_FIXTURE), 'manuscript');
    expect(s.map(x => x.kind)).toEqual(['abstract', 'introduction', 'methods', 'results', 'discussion']);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run scripts/eval/review/fixtures.test.ts`
Expected: PASS (the fixtures were written in Steps 2-3). If "every quote hint verbatim, exactly once" fails, fix the fixture text or the hint so they match exactly; do not loosen the test. If the word count is outside 1,200-2,200, report the actual count instead of changing the bounds.

- [ ] **Step 6: Record the fixture size and widened manuscript sections in the spec**

In `docs/superpowers/specs/2026-10-10-review-v2-design.md` §6, change "a synthetic R01, about 2,500 words" to "a synthetic R01, about 1,500 words", and "About 8 **traps**" stays. Under the §1.2 table add:

```markdown
Three manuscript checks look in one more section than the table above first listed, so that problems where
authors actually put them are in scope: `m-imp-overclaim` also reads `results`, `m-rig-n` also reads
`introduction`, and `m-con-uncited` also reads `results`.
```

and update those three rows' `sections` cells to `abstract, results, discussion`, `introduction, methods, results` and `introduction, results, discussion`.

- [ ] **Step 7: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add scripts/eval/review/fixtures scripts/eval/review/fixtures.test.ts docs/superpowers/specs/2026-10-10-review-v2-design.md
git commit -m "test(review): grant and manuscript eval fixtures with planted weaknesses and traps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The scorer

**Files:**
- Create: `scripts/eval/review/score.ts`
- Test: `scripts/eval/review/score.test.ts`

**Interfaces:**
- Consumes: `ReviewFixture`, `Expectation` (Task 4); `Section` (Task 1); `normalizeForMatch`, `findTextSpan` from `src/utils/textMatch.ts`; `Suggestion` from `src/types.ts`.
- Produces:
  - `interface NormalizedFinding { checkId?: string; sectionTitle?: string; quote?: string; text: string; source: string }`
  - `interface ScoreResult { planted: number; hit: string[]; missed: string[]; falseAlarms: { trapId: string; finding: NormalizedFinding }[]; total: number; unmatched: number }`
  - `function quotesOverlap(a: string, b: string): boolean`
  - `function matches(e: Expectation, f: NormalizedFinding): boolean`
  - `function scoreFindings(fx: ReviewFixture, findings: NormalizedFinding[]): ScoreResult`
  - `function scoreProse(fx: ReviewFixture, prose: string): { mentioned: string[]; missed: string[] }`
  - `function sectionTitleForQuote(sections: Pick<Section, 'title' | 'text'>[], quote: string): string | undefined`
  - `function fromSuggestions(suggestions: Suggestion[], sections: Pick<Section, 'title' | 'text'>[]): NormalizedFinding[]`

- [ ] **Step 1: Write the failing tests**

`scripts/eval/review/score.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quotesOverlap, matches, scoreFindings, scoreProse, sectionTitleForQuote, fromSuggestions, type NormalizedFinding } from './score';
import type { Expectation, ReviewFixture } from './fixtures/types';
import type { Suggestion } from '../../../src/types';

const planted: Expectation = {
  id: 'P', checkId: 'g-rig-power', sectionTitles: ['Aim 3'], quoteHints: ['using eight mice per group'],
  keywords: /power|sample size/i, alsoIn: [{ sectionTitle: 'Rigor', mention: /aim 3/i }], note: '',
};
const trap: Expectation = {
  id: 'T', checkId: 'g-rig-power', sectionTitles: ['Rigor'], quoteHints: ['n = 12 mice per group gives 80% power'],
  keywords: /power|sample size/i, note: '',
};
const noHint: Expectation = { id: 'N', checkId: 'g-fea-pitfalls', sectionTitles: ['Aim 2'], keywords: /alternative/i, note: '' };
const fx: ReviewFixture = { id: 'f', docType: 'grant', sections: [], planted: [planted, noHint], traps: [trap] };
const f = (x: Partial<NormalizedFinding>): NormalizedFinding => ({ text: '', source: 'test', ...x });

describe('quotesOverlap', () => {
  it('accepts containment either way, ignoring case and spacing', () => {
    expect(quotesOverlap('Using  EIGHT mice per group', 'using eight mice per group')).toBe(true);
    expect(quotesOverlap('eight mice', 'using eight mice per group')).toBe(true);
  });

  it('accepts a shared run of five words and rejects shorter ones', () => {
    expect(quotesOverlap('they will be using eight mice per group here', 'we plan using eight mice per group daily')).toBe(true);
    expect(quotesOverlap('using eight mice today', 'using eight rats today')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(quotesOverlap('', 'x')).toBe(false);
  });
});

describe('matches', () => {
  it('needs the topic: checkId or keywords', () => {
    expect(matches(planted, f({ checkId: 'g-rig-power', quote: 'using eight mice per group' }))).toBe(true);
    expect(matches(planted, f({ text: 'No power analysis.', quote: 'using eight mice per group' }))).toBe(true);
    expect(matches(planted, f({ checkId: 'g-rig-bias', text: 'Blinding missing.', quote: 'using eight mice per group' }))).toBe(false);
  });

  it('with a quote, needs the quote to overlap a hint, not just the right section', () => {
    expect(matches(planted, f({ checkId: 'g-rig-power', sectionTitle: 'Aim 3', quote: 'Mice will undergo TAC' }))).toBe(false);
  });

  it('without a quote, accepts the right section', () => {
    expect(matches(planted, f({ checkId: 'g-rig-power', sectionTitle: 'Aim 3' }))).toBe(true);
    expect(matches(planted, f({ checkId: 'g-rig-power', sectionTitle: 'Aim 2' }))).toBe(false);
  });

  it('accepts any quote in the section when the expectation has no hints', () => {
    expect(matches(noHint, f({ text: 'no alternative strategies', sectionTitle: 'Aim 2', quote: 'anything here' }))).toBe(true);
  });

  it('accepts an alsoIn section only when the finding mentions the cue', () => {
    expect(matches(planted, f({ text: 'Power analysis omits Aim 3.', sectionTitle: 'Rigor' }))).toBe(true);
    expect(matches(planted, f({ text: 'Power analysis is weak.', sectionTitle: 'Rigor' }))).toBe(false);
  });
});

describe('scoreFindings', () => {
  it('counts hits, misses, false alarms and unmatched findings', () => {
    const r = scoreFindings(fx, [
      f({ checkId: 'g-rig-power', quote: 'using eight mice per group' }),
      f({ checkId: 'g-rig-power', quote: 'n = 12 mice per group gives 80% power' }),
      f({ checkId: 'g-rig-power', sectionTitle: 'Rigor', text: 'Power analysis is weak.' }),
      f({ checkId: 'g-con-terms', text: 'Abbreviation undefined.', quote: 'MCU' }),
    ]);
    expect(r).toMatchObject({ planted: 2, hit: ['P'], missed: ['N'], total: 4, unmatched: 1 });
    expect(r.falseAlarms.map(x => x.trapId)).toEqual(['T', 'T']);
  });

  it('does not count a planted hit as a false alarm even if it also touches a trap', () => {
    const r = scoreFindings(fx, [f({ text: 'Power analysis omits Aim 3.', sectionTitle: 'Rigor' })]);
    expect(r.hit).toEqual(['P']);
    expect(r.falseAlarms).toEqual([]);
  });
});

describe('scoreProse', () => {
  it('counts a planted weakness mentioned with its section label or quote', () => {
    const r = scoreProse(fx, 'Aim 3 lacks a power calculation.\nThe approach is otherwise sound.');
    expect(r.mentioned).toEqual(['P']);
    expect(r.missed).toEqual(['N']);
  });
});

describe('legacy adapter', () => {
  const sections = [{ title: 'Aim 2', text: 'Mice will undergo TAC.' }, { title: 'Aim 3', text: 'We are using eight mice per group.' }];

  it('finds the section that contains a quote', () => {
    expect(sectionTitleForQuote(sections, 'using eight mice per group')).toBe('Aim 3');
    expect(sectionTitleForQuote(sections, 'not anywhere')).toBeUndefined();
  });

  it('turns suggestions into normalized findings', () => {
    const s = { id: '1', agent: 'statistician', originalText: 'using eight mice per group', suggestedText: '', explanation: 'No power analysis.', recommendation: 'Add one.', startIndex: 0, endIndex: 0, kind: 'advisory' } as Suggestion;
    expect(fromSuggestions([s], sections)).toEqual([
      { quote: 'using eight mice per group', sectionTitle: 'Aim 3', text: 'No power analysis. Add one.', source: 'statistician' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/eval/review/score.test.ts`
Expected: FAIL, "Failed to resolve import './score'".

- [ ] **Step 3: Write the scorer**

`scripts/eval/review/score.ts`:

```ts
/**
 * Pure scoring for the review eval. Findings from any system (the current pipeline or Review v2) are first turned
 * into NormalizedFinding; matching rules are documented on Expectation (fixtures/types.ts).
 */
import { findTextSpan, normalizeForMatch } from '../../../src/utils/textMatch';
import type { Section } from '../../../src/services/review/types';
import type { Suggestion } from '../../../src/types';
import type { Expectation, ReviewFixture } from './fixtures/types';

export interface NormalizedFinding {
  checkId?: string;
  sectionTitle?: string;
  quote?: string;
  /** Everything the finding says: issue, explanation, recommendation. */
  text: string;
  /** Which agent or system produced it, for the report. */
  source: string;
}

export interface ScoreResult {
  planted: number;
  hit: string[];
  missed: string[];
  falseAlarms: { trapId: string; finding: NormalizedFinding }[];
  total: number;
  /** Findings that hit no planted weakness and no trap: neither confirmed nor refuted. */
  unmatched: number;
}

const MIN_WORD_RUN = 5;

function norm(s: string): string {
  return normalizeForMatch(s).text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function longestWordRun(a: string[], b: string[]): number {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

export function quotesOverlap(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  return longestWordRun(na.split(' '), nb.split(' ')) >= MIN_WORD_RUN;
}

export function matches(e: Expectation, f: NormalizedFinding): boolean {
  const onTopic = (f.checkId !== undefined && f.checkId === e.checkId) || e.keywords.test(f.text);
  if (!onTopic) return false;
  const hints = e.quoteHints ?? [];
  if (f.quote && hints.some(h => quotesOverlap(f.quote!, h))) return true;
  const inPrimary = f.sectionTitle !== undefined && e.sectionTitles.includes(f.sectionTitle);
  if (inPrimary && (!f.quote || hints.length === 0)) return true;
  const also = e.alsoIn?.find(a => a.sectionTitle === f.sectionTitle);
  return !!also && also.mention.test(`${f.text} ${f.quote ?? ''}`);
}

export function scoreFindings(fx: ReviewFixture, findings: NormalizedFinding[]): ScoreResult {
  const hit = new Set<string>();
  const falseAlarms: ScoreResult['falseAlarms'] = [];
  let unmatched = 0;
  for (const f of findings) {
    const hits = fx.planted.filter(e => matches(e, f));
    hits.forEach(e => hit.add(e.id));
    if (hits.length) continue;
    const trap = fx.traps.find(t => matches(t, f));
    if (trap) falseAlarms.push({ trapId: trap.id, finding: f });
    else unmatched++;
  }
  const ids = fx.planted.map(e => e.id);
  return {
    planted: ids.length,
    hit: ids.filter(id => hit.has(id)),
    missed: ids.filter(id => !hit.has(id)),
    falseAlarms,
    total: findings.length,
    unmatched,
  };
}

const label = (title: string) => title.split(':')[0].trim().toLowerCase();

/** Lenient: a planted weakness counts as mentioned when one line or sentence is on topic and names its section or quote. */
export function scoreProse(fx: ReviewFixture, prose: string): { mentioned: string[]; missed: string[] } {
  const lines = prose.split(/\n+|(?<=[.!?])\s+/).map(l => l.trim()).filter(Boolean);
  const mentioned = fx.planted
    .filter(e => lines.some(line =>
      e.keywords.test(line) &&
      ((e.quoteHints ?? []).some(h => quotesOverlap(line, h)) || e.sectionTitles.some(t => line.toLowerCase().includes(label(t)))),
    ))
    .map(e => e.id);
  return { mentioned, missed: fx.planted.map(e => e.id).filter(id => !mentioned.includes(id)) };
}

export function sectionTitleForQuote(sections: Pick<Section, 'title' | 'text'>[], quote: string): string | undefined {
  for (const s of sections) {
    if (s.title && s.text && findTextSpan(s.text, quote)) return s.title;
  }
  return undefined;
}

export function fromSuggestions(suggestions: Suggestion[], sections: Pick<Section, 'title' | 'text'>[]): NormalizedFinding[] {
  return suggestions.map(s => ({
    quote: s.originalText,
    sectionTitle: sectionTitleForQuote(sections, s.originalText),
    text: [s.explanation, s.recommendation].filter(Boolean).join(' '),
    source: s.agent,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/eval/review/score.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add scripts/eval/review/score.ts scripts/eval/review/score.test.ts
git commit -m "test(review): eval scorer with recall, trap false alarms and prose mentions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Baseline adapter and eval runner

**Files:**
- Create: `scripts/eval/review/baseline.ts`
- Create: `scripts/eval/review/run.ts`
- Test: `scripts/eval/review/run.test.ts`
- Modify: `package.json` (scripts block, after `"eval:local"`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: fixtures and builders (Task 4); `scoreFindings`, `scoreProse`, `fromSuggestions`, `NormalizedFinding` (Task 5); `sectionMap` (Task 2); from `src/services/ai.ts`: `setDocumentContext`, `analyzeText`, `dedupeAdvisories`, `resolveConflicts`, `runJudgeAgent`, `verifySuggestions`, `manuscriptSummary`; from `src/services/detectors.ts`: `freshDetectorSuggestions`.
- Produces:
  - `interface SystemOutput { findings: NormalizedFinding[]; prose: string; errors: string[] }`
  - `function baselineCrew(docType: DocType): AgentType[]`
  - `async function runBaseline(fx: ReviewFixture, settings: AISettings): Promise<SystemOutput>`
  - `interface EvalArgs { tier: 'cloud' | 'local'; docs: ('grant' | 'manuscript')[] }`
  - `function parseArgs(argv: string[]): EvalArgs`
  - `function buildSettings(tier: 'cloud' | 'local', env: Record<string, string | undefined>): AISettings`
  - `function modelLabel(settings: AISettings): string`
  - `function installCallCounter(target?: { fetch: typeof fetch }): { count(): number; reset(): void; restore(): void }`

- [ ] **Step 1: Write the failing runner tests**

`scripts/eval/review/run.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseArgs, buildSettings, modelLabel, installCallCounter } from './run';
import { baselineCrew } from './baseline';

describe('parseArgs', () => {
  it('defaults to the local tier and both documents', () => {
    expect(parseArgs([])).toEqual({ tier: 'local', docs: ['grant', 'manuscript'] });
  });

  it('reads --tier and --doc', () => {
    expect(parseArgs(['--tier', 'cloud', '--doc', 'grant'])).toEqual({ tier: 'cloud', docs: ['grant'] });
    expect(parseArgs(['--doc=manuscript', '--tier=local'])).toEqual({ tier: 'local', docs: ['manuscript'] });
  });

  it('rejects unknown values', () => {
    expect(() => parseArgs(['--tier', 'gpu'])).toThrow(/--tier/);
    expect(() => parseArgs(['--doc', 'poem'])).toThrow(/--doc/);
  });
});

describe('buildSettings', () => {
  it('local tier: llama.cpp defaults and 2000-char chunks', () => {
    const s = buildSettings('local', {});
    expect(s).toMatchObject({ provider: 'local', localBaseUrl: 'http://localhost:8080/v1/chat/completions', localModel: 'ornith', localChunkSize: 2000 });
  });

  it('cloud tier: provider from env, whole-document calls', () => {
    const s = buildSettings('cloud', { EVAL_PROVIDER: 'openai', OPENAI_API_KEY: 'k' });
    expect(s).toMatchObject({ provider: 'openai', openaiApiKey: 'k', localChunkSize: 0 });
    expect(buildSettings('cloud', {}).provider).toBe('anthropic');
  });

  it('refuses a local provider on the cloud tier', () => {
    expect(() => buildSettings('cloud', { EVAL_PROVIDER: 'local' })).toThrow(/cloud/);
  });

  it('labels the model without exposing keys', () => {
    const s = buildSettings('cloud', { EVAL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'secret', EVAL_ANTHROPIC_MODEL: 'claude-x' });
    expect(modelLabel(s)).toBe('anthropic/claude-x');
    expect(modelLabel(s)).not.toContain('secret');
  });
});

describe('installCallCounter', () => {
  it('counts POST requests and restores fetch', async () => {
    const calls: string[] = [];
    const target = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(init?.method)); return new Response('{}'); }) as typeof fetch };
    const original = target.fetch;
    const counter = installCallCounter(target);
    await target.fetch('http://x', { method: 'POST' });
    await target.fetch('http://x', { method: 'GET' });
    await target.fetch(new Request('http://x', { method: 'POST' }));
    expect(counter.count()).toBe(2);
    counter.reset();
    expect(counter.count()).toBe(0);
    counter.restore();
    expect(target.fetch).toBe(original);
    expect(calls).toHaveLength(3);
  });
});

describe('baselineCrew', () => {
  it('matches useAnalysis.ts: no consistency agent for grants', () => {
    expect(baselineCrew('grant')).toEqual(['editor', 'reviewer-2', 'researcher', 'statistician']);
    expect(baselineCrew('manuscript')).toEqual(['editor', 'reviewer-2', 'researcher', 'statistician', 'consistency']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/eval/review/run.test.ts`
Expected: FAIL, cannot resolve `./run` and `./baseline`.

- [ ] **Step 3: Write the baseline adapter**

`scripts/eval/review/baseline.ts`:

```ts
/**
 * The CURRENT review pipeline, driven exactly as src/hooks/useAnalysis.ts handleAnalyze() runs it (agents in
 * parallel, detectors, advisory dedupe, resolveConflicts → Judge → verifier for edits), plus the summary button
 * (manuscriptSummary, which is the three-persona study section in grant mode). This is the R1 baseline; R4 deletes
 * the code it calls. ai.ts is imported lazily so run.ts can wrap fetch before any SDK captures it.
 */
import type { AISettings, AgentType, Suggestion } from '../../../src/types';
import type { DocType } from '../../../src/services/review/types';
import { sectionMap } from '../../../src/services/review/sections';
import { fixtureDoc, fixtureHtml, fixturePlainText } from './fixtures/build';
import type { ReviewFixture } from './fixtures/types';
import { fromSuggestions, type NormalizedFinding } from './score';

export interface SystemOutput {
  findings: NormalizedFinding[];
  prose: string;
  errors: string[];
}

export function baselineCrew(docType: DocType): AgentType[] {
  return docType === 'grant'
    ? ['editor', 'reviewer-2', 'researcher', 'statistician']
    : ['editor', 'reviewer-2', 'researcher', 'statistician', 'consistency'];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runBaseline(fx: ReviewFixture, settings: AISettings): Promise<SystemOutput> {
  const ai = await import('../../../src/services/ai');
  const { freshDetectorSuggestions } = await import('../../../src/services/detectors');
  const errors: string[] = [];

  ai.setDocumentContext({ mode: fx.docType, grantInstructions: '' });
  const plain = fixturePlainText(fx);
  const html = fixtureHtml(fx);
  const crew = baselineCrew(fx.docType);

  const results = await Promise.all(crew.map(agent => ai.analyzeText(plain, agent, settings, [], undefined, html)));
  results.forEach((r, i) => {
    if (r.status === 'server_error' || r.status === 'parsing_failed') errors.push(`${crew[i]}: ${r.status}${r.errorMessage ? ` (${r.errorMessage})` : ''}`);
  });
  const combined: Suggestion[] = results.flatMap(r => r.suggestions);

  const advisories = ai.dedupeAdvisories([...freshDetectorSuggestions(plain), ...combined.filter(s => s.kind === 'advisory')]);
  let edits = combined.filter(s => s.kind !== 'advisory');
  if (edits.length > 0) {
    edits = await ai.resolveConflicts(edits, settings);
    try { edits = await ai.runJudgeAgent(edits, settings); } catch (e) { errors.push(`judge: ${msg(e)}`); }
    try { edits = (await ai.verifySuggestions(edits, settings)).kept; } catch (e) { errors.push(`verifier: ${msg(e)}`); }
  }

  let prose = '';
  try { prose = await ai.manuscriptSummary(plain, settings); } catch (e) { errors.push(`summary: ${msg(e)}`); }

  const sections = sectionMap(fixtureDoc(fx), fx.docType);
  return { findings: fromSuggestions([...edits, ...advisories], sections), prose, errors };
}
```

- [ ] **Step 4: Write the runner**

`scripts/eval/review/run.ts`:

```ts
/**
 * Review eval runner. Calls real providers; never run from vitest.
 *
 *   npm run eval:review -- --tier local                 # llama.cpp at :8080, model "ornith", both fixtures
 *   npm run eval:review -- --tier cloud --doc grant     # EVAL_PROVIDER=anthropic|openai|gemini (default anthropic)
 *
 * Env: EVAL_PROVIDER, ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, EVAL_ANTHROPIC_MODEL / EVAL_OPENAI_MODEL /
 * EVAL_GEMINI_MODEL, EVAL_LOCAL_URL, EVAL_LOCAL_MODEL, EVAL_LOCAL_KEY, EVAL_CHUNK (local chunk size, default 2000).
 * Keys are read from the environment only and are never printed or written.
 *
 * Prints a per-fixture report and one markdown table row per fixture for
 * docs/superpowers/plans/2026-07-04-eval-results.md, and writes the full result to
 * scripts/eval/review/results/<timestamp>-<system>-<tier>-<doc>.json (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AISettings } from '../../../src/types';
import { GRANT_FIXTURE } from './fixtures/grant';
import { MANUSCRIPT_FIXTURE } from './fixtures/manuscript';
import type { ReviewFixture } from './fixtures/types';
import { scoreFindings, scoreProse } from './score';

export interface EvalArgs {
  tier: 'cloud' | 'local';
  docs: ('grant' | 'manuscript')[];
}

export function parseArgs(argv: string[]): EvalArgs {
  const get = (name: string): string | undefined => {
    const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  };
  const tier = get('tier') ?? 'local';
  if (tier !== 'cloud' && tier !== 'local') throw new Error(`--tier must be cloud or local, got "${tier}"`);
  const doc = get('doc');
  if (doc !== undefined && doc !== 'grant' && doc !== 'manuscript') throw new Error(`--doc must be grant or manuscript, got "${doc}"`);
  return { tier, docs: doc ? [doc] : ['grant', 'manuscript'] };
}

export function buildSettings(tier: 'cloud' | 'local', env: Record<string, string | undefined>): AISettings {
  if (tier === 'local') {
    return {
      provider: 'local',
      localBaseUrl: env.EVAL_LOCAL_URL || 'http://localhost:8080/v1/chat/completions',
      localApiKey: env.EVAL_LOCAL_KEY || '',
      localModel: env.EVAL_LOCAL_MODEL || 'ornith',
      localChunkSize: env.EVAL_CHUNK ? Number(env.EVAL_CHUNK) : 2000,
    };
  }
  const provider = (env.EVAL_PROVIDER || 'anthropic') as AISettings['provider'];
  if (provider === 'local') throw new Error('The cloud tier needs EVAL_PROVIDER=anthropic, openai or gemini.');
  return {
    provider,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    openaiApiKey: env.OPENAI_API_KEY || '',
    geminiApiKey: env.GEMINI_API_KEY || '',
    anthropicModel: env.EVAL_ANTHROPIC_MODEL,
    openaiModel: env.EVAL_OPENAI_MODEL,
    geminiModel: env.EVAL_GEMINI_MODEL,
    localBaseUrl: '',
    localApiKey: '',
    localModel: '',
    localChunkSize: 0,
  };
}

export function modelLabel(s: AISettings): string {
  if (s.provider === 'local') return `local/${s.localModel}`;
  const model = s.provider === 'anthropic' ? s.anthropicModel : s.provider === 'openai' ? s.openaiModel : s.geminiModel;
  return `${s.provider}/${model ?? '(default)'}`;
}

/** Count POST requests (one per LLM call on every provider path) by wrapping `target.fetch`. */
export function installCallCounter(target: { fetch: typeof fetch } = globalThis): { count(): number; reset(): void; restore(): void } {
  const original = target.fetch;
  let n = 0;
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST') n++;
    return original(input, init);
  }) as typeof fetch;
  return { count: () => n, reset: () => { n = 0; }, restore: () => { target.fetch = original; } };
}

const FIXTURES: Record<'grant' | 'manuscript', ReviewFixture> = { grant: GRANT_FIXTURE, manuscript: MANUSCRIPT_FIXTURE };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = buildSettings(args.tier, process.env);
  const counter = installCallCounter();
  const { runBaseline } = await import('./baseline');
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(outDir, { recursive: true });
  const rows: string[] = [];

  console.log(`\nReview eval — system=baseline tier=${args.tier} model=${modelLabel(settings)}${args.tier === 'local' ? ` chunk=${settings.localChunkSize}` : ''}\n`);
  for (const doc of args.docs) {
    const fx = FIXTURES[doc];
    counter.reset();
    const t0 = Date.now();
    const out = await runBaseline(fx, settings);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const calls = counter.count();
    const score = scoreFindings(fx, out.findings);
    const prose = scoreProse(fx, out.prose);

    console.log(`── ${fx.id}`);
    console.log(`recall           ${score.hit.length}/${score.planted} (${pct(score.hit.length, score.planted)})`);
    console.log(`false alarms     ${score.falseAlarms.length} on ${fx.traps.length} traps${score.falseAlarms.length ? `  [${score.falseAlarms.map(x => x.trapId).join(', ')}]` : ''}`);
    console.log(`findings         ${score.total} total, ${score.unmatched} unmatched`);
    console.log(`summary mentions ${prose.mentioned.length}/${score.planted} (lenient)`);
    console.log(`LLM calls        ${calls}, ${seconds}s`);
    if (score.missed.length) console.log(`missed           ${score.missed.join(', ')}`);
    if (out.errors.length) console.log(`errors           ${out.errors.join('; ')}`);
    console.log('');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(outDir, `${stamp}-baseline-${args.tier}-${doc}.json`), JSON.stringify({ fixture: fx.id, tier: args.tier, model: modelLabel(settings), calls, seconds, score, prose, errors: out.errors, findings: out.findings, summary: out.prose }, null, 2));
    rows.push(`| ${new Date().toISOString().slice(0, 10)} | baseline | ${args.tier} | ${modelLabel(settings)} | ${doc} | ${score.hit.length}/${score.planted} (${pct(score.hit.length, score.planted)}) | ${score.falseAlarms.length}/${fx.traps.length} | ${score.total} (${score.unmatched} unmatched) | ${prose.mentioned.length}/${score.planted} | ${calls} | ${seconds}s |`);
  }
  counter.restore();
  console.log('Rows for docs/superpowers/plans/2026-07-04-eval-results.md:\n');
  console.log(rows.join('\n'));
}

// vitest imports this file for its pure helpers; only a real CLI run starts the eval.
if (!process.env.VITEST) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/eval/review/run.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Add the npm script and ignore results**

In `package.json`, after the `"eval:local": …` line add:

```json
    "eval:review": "npx tsx scripts/eval/review/run.ts",
```

Append to `.gitignore`:

```
# review eval outputs (full findings per run; numbers are recorded in docs/superpowers/plans/2026-07-04-eval-results.md)
scripts/eval/review/results/
```

- [ ] **Step 7: Smoke-test the CLI wiring without a model**

Run: `npm run eval:review -- --tier gpu`
Expected: exits 1 and prints `--tier must be cloud or local, got "gpu"`.

- [ ] **Step 8: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add scripts/eval/review/baseline.ts scripts/eval/review/run.ts scripts/eval/review/run.test.ts package.json .gitignore
git commit -m "test(review): eval runner and baseline adapter for the current pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Run the baseline and record it; full gate

**Files:**
- Modify: `docs/superpowers/plans/2026-07-04-eval-results.md` (append a section)

**Interfaces:**
- Consumes: `npm run eval:review` (Task 6).
- Produces: recorded baseline numbers that R2's gates compare against.

- [ ] **Step 1: Run the full gate**

Run each and confirm exit code 0:

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx vitest run; echo "vitest exit $?"
npm run build; echo "build exit $?"
git checkout -- dist-electron
```

Expected: three `exit 0` lines. A vitest run that prints "passed" but exits non-zero is a failure; find the unhandled error before going on.

- [ ] **Step 2: Check which providers are available (without printing keys)**

```bash
curl -s -m 5 http://localhost:8080/v1/models >/dev/null && echo "local: up" || echo "local: down"
for k in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do [ -n "${!k}" ] && echo "$k: set" || echo "$k: unset"; done
```

If the local server is down, ask the user to start it (they use `ai-backend llama`); do not start it yourself, because it competes for RAM. If no cloud key is set, ask the user which provider and key to use, and have them export it themselves (e.g. `! export ANTHROPIC_API_KEY=...` in their prompt). Run only the tiers that are available and say which were skipped.

- [ ] **Step 3: Run the baseline**

```bash
npm run eval:review -- --tier local
npm run eval:review -- --tier cloud
```

Expected: a report per fixture and the markdown rows at the end. Local runs can take many minutes (the current pipeline makes tens to hundreds of calls); run them in the background and wait for completion rather than polling.

- [ ] **Step 4: Record the numbers**

Append to `docs/superpowers/plans/2026-07-04-eval-results.md`:

```markdown
## Review v2 baseline (R1, current pipeline)

Fixtures: `scripts/eval/review/fixtures/` (grant: synthetic R01, 15 planted weaknesses, 8 traps; manuscript: 11 planted,
5 traps). Scorer: `scripts/eval/review/score.ts`. "Summary mentions" is a lenient keyword match on the study section /
journal summary text. Gates for R2/R4 (spec §6): cloud recall >= 80% with <= 1 trap false alarm; local recall >= 60%
with <= 2; both must beat these rows.

| Date | System | Tier | Model | Fixture | Recall | False alarms | Findings | Summary mentions | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|---|
<paste the rows printed by the runner here>

Notes: <which tiers were skipped and why; any errors the runner printed>
```

Replace the two `<…>` lines with the printed rows and the actual notes before committing; a placeholder left in this file is a failed step.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-04-eval-results.md
git commit -m "docs(review): baseline review eval numbers for the current pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Amendments during execution (2026-10-10)

The plan above is what was approved; these changes were made while executing it, each after a task or final review.

- **Section map**: "Project Summary/Abstract" with an unspaced slash (the NIH spelling) normalises like the spaced form;
  "Reference" and "References and Notes" are `references`.
- **Fixtures** (Task 4 review: several passages would have punished correct answers): plant P11 (`g-imp-why`, the
  text arguably states a consequence) replaced by `P11-stats-aim3`; P1/P3 also cover Aim 3, P14 gains an `alsoIn` for
  Preliminary Data; trap MT3 made adequate ("n = 6 independent cultures per group") and plant `M12-n-missing` added;
  the qPCR plant replaced by an undefined "TCD"; trap and plant keywords narrowed (T4, T6, T7, MT1, MT2, MT4, M8, M9,
  M10, P12). The manuscript fixture has 12 planted weaknesses.
- **Scorer**: each finding is assigned to at most one expectation, in tiers — checkId before keyword-only, planted
  before traps, quote overlap before location, then fixture order. Containment counts only when the shorter quote has
  at least 3 words; section attribution for legacy findings prefers exact/normalized matches over fuzzy ones.
- **Prompt schema**: `additionalProperties: false` on both objects; `renderRolePrompt` returns null when no section
  can be offered; sections whose provided `text` is empty are not offered as `sectionKey`s; pasted `"""` in funder
  instructions is reduced; the framework sentence names 'presentation'.
- **Runner**: per-document failure isolation, API-key redaction in every printed or written error, fail-fast on a
  missing cloud key, a numeric check on `EVAL_CHUNK`, and every report split into all agents vs excluding the
  `editor` agent (the R2/R4 gates use the latter).
- **Task 7** was run by the controller. No cloud API key was available, so the cloud tier was measured twice: the
  cloud code path against local Qwen, and the cloud code path against a Claude stand-in through an OpenAI-compatible
  relay. See `docs/superpowers/plans/2026-07-04-eval-results.md`.
- Commit trailers name the model that wrote each commit.
