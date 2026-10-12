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
  /** The procedure a weak model follows: 3-5 imperative steps, step 1 locating the evidence, the last stating the
   *  decision rule including when the check does not apply. Rendered into the prompt (§3.2). */
  steps: string[];
  /** One generic example either side of the boundary, on a neutral invented topic. */
  passExample: string;
  failExample: string;
  /** 'per-aim' checks are asked once per aim or sub-aim part (§3.4), not once per document. */
  granularity?: 'document' | 'per-aim';
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
