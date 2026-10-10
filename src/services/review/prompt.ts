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
  /** `text`, when given, lets empty-body sections be left out of the anchors (their kinds still count). */
  sections: (Pick<Section, 'key' | 'kind' | 'title'> & { text?: string })[];
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
  'Factor 3, Expertise and Resources, is rated sufficient or insufficient. Each check below says which factor it informs, or \'presentation\' for issues outside the factors.';

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
  const sectionKeys = ctx.sections.filter(s => s.kind !== 'references' && !(s.text !== undefined && s.text.trim() === '')).map(s => s.key);
  if (sectionKeys.length === 0) return null;

  const parts: string[] = [ctx.customPreamble?.trim() || PREAMBLES[ctx.docType][role]];
  if (ctx.docType === 'grant') {
    const context = [FRAMEWORK];
    if (ctx.mechanism?.trim()) context.push(`Mechanism: ${ctx.mechanism.trim()}.`);
    context.push(ctx.projectYears ? `Project period: ${ctx.projectYears} years.` : 'Project period: not stated; judge scope against the mechanism.');
    parts.push(context.join('\n'));
  }
  const funder = ctx.funderInstructions?.trim().replace(/"""/g, '"');
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
      additionalProperties: false,
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
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
