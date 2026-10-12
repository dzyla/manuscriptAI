/**
 * The review checklist: every question the review crew asks, written once, owned by exactly one role. Prompts are
 * rendered from this data (prompt.ts); nothing else defines what a reviewer checks. Grant checks follow the NIH
 * Simplified Peer Review Framework (applications due on or after 25 January 2025).
 */
import type { DocType, ReviewCheck, ReviewerRole, SectionKind } from './types';
import { PROCEDURES } from './checklistProcedures';

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

type CheckBase = Omit<ReviewCheck, 'steps' | 'passExample' | 'failExample' | 'granularity'>;

/** Checks asked once per aim or sub-aim part rather than once per document (spec §3.4). */
export const PER_AIM_IDS: ReadonlySet<string> = new Set([
  'g-rig-design', 'g-rig-power', 'g-rig-stats', 'g-rig-sabv', 'g-rig-bias', 'g-rig-replication',
  'g-fea-pitfalls', 'g-fea-outcomes', 'g-fea-prelim', 'g-log-measurable', 'g-exp-expertise',
  'm-rig-tests', 'm-rig-n', 'm-rig-variability', 'm-rig-effect', 'm-rig-multiple', 'm-rig-controls', 'm-met-reproducible',
]);

const BASE_CHECKS: readonly CheckBase[] = [
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

export const CHECKS: readonly ReviewCheck[] = BASE_CHECKS.map(c => {
  const procedure = PROCEDURES[c.id];
  if (!procedure) throw new Error(`No procedure for check ${c.id}`);
  return { ...c, ...procedure, ...(PER_AIM_IDS.has(c.id) ? { granularity: 'per-aim' as const } : {}) };
});

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
