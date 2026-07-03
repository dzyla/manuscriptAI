/**
 * NIH grant templates. Each template imprints an H2-section skeleton into the
 * editor with per-section guidance the author overwrites. Page limits follow
 * current NIH research-grant instructions (Forms-H/I era); word budgets assume
 * ~500 words per page of single-spaced 11-pt text.
 */

export interface GrantTemplateSection {
  title: string;
  /** NIH page limit for this section (undefined = no formal limit) */
  pageLimit?: number;
  /** Shown in the template picker and imprinted as an italic guidance paragraph */
  guidance: string;
}

export interface GrantTemplate {
  id: string;
  name: string;
  mechanism: string;
  description: string;
  sections: GrantTemplateSection[];
}

export const WORDS_PER_PAGE = 500;

const SPECIFIC_AIMS: GrantTemplateSection = {
  title: 'Specific Aims',
  pageLimit: 1,
  guidance: 'One page. Open with a hook establishing importance, then the knowledge gap and the critical need. State your long-term goal, the objective of THIS application, your central hypothesis, and the rationale. List 2-3 aims that are related but not interdependent (failure of Aim 1 must not sink Aim 2). Close with a payoff paragraph: expected outcomes and positive impact.',
};

const SIGNIFICANCE: GrantTemplateSection = {
  title: 'Significance',
  guidance: 'Why does this problem matter? Describe the scientific premise, the importance of the problem, and how the proposed research will improve scientific knowledge, technical capability, or clinical practice. Address rigor of the prior research supporting your premise.',
};

const INNOVATION: GrantTemplateSection = {
  title: 'Innovation',
  guidance: 'How does this application challenge or shift current research or clinical paradigms? Novel concepts, approaches, methodologies, instrumentation, or interventions. Innovation is about the field, not about you being new to it.',
};

const APPROACH: GrantTemplateSection = {
  title: 'Approach',
  guidance: 'For each aim: rationale and preliminary data, experimental design, expected outcomes, potential problems and alternative strategies, and rigor (sample sizes, statistics, biological variables, replication). Include a timeline. This section carries the most review weight.',
};

export const GRANT_TEMPLATES: GrantTemplate[] = [
  {
    id: 'nih-r01',
    name: 'NIH R01 — Research Project Grant',
    mechanism: 'R01',
    description: 'The standard NIH investigator-initiated award. Specific Aims (1 page) + Research Strategy (12 pages: Significance, Innovation, Approach).',
    sections: [
      { title: 'Project Summary / Abstract', pageLimit: 1, guidance: '30 lines max. A succinct description of the proposed work understandable to a scientifically literate reader: broad goals, specific objectives, methods, and expected significance.' },
      { title: 'Project Narrative', guidance: 'Two to three sentences describing the relevance of this research to public health, in plain language.' },
      SPECIFIC_AIMS,
      { ...SIGNIFICANCE, pageLimit: 2 },
      { ...INNOVATION, pageLimit: 1 },
      { ...APPROACH, pageLimit: 9 },
    ],
  },
  {
    id: 'nih-r21',
    name: 'NIH R21 — Exploratory/Developmental',
    mechanism: 'R21',
    description: 'High-risk, high-reward exploratory research; preliminary data not required. Specific Aims (1 page) + Research Strategy (6 pages). Two-year limit.',
    sections: [
      { title: 'Project Summary / Abstract', pageLimit: 1, guidance: '30 lines max. Emphasize the exploratory, novel nature of the work and its potential to open new research directions.' },
      { title: 'Project Narrative', guidance: 'Two to three sentences on public-health relevance, in plain language.' },
      SPECIFIC_AIMS,
      { ...SIGNIFICANCE, pageLimit: 1.5 },
      { ...INNOVATION, pageLimit: 1 },
      { ...APPROACH, pageLimit: 3.5 },
    ],
  },
  {
    id: 'nih-r03',
    name: 'NIH R03 — Small Grant',
    mechanism: 'R03',
    description: 'Small, self-contained projects: pilot studies, secondary data analysis, method development. Specific Aims (1 page) + Research Strategy (6 pages). Two-year, $50k/yr limit.',
    sections: [
      { title: 'Project Summary / Abstract', pageLimit: 1, guidance: '30 lines max. Make clear the project is self-contained and feasible within two years with modest resources.' },
      { title: 'Project Narrative', guidance: 'Two to three sentences on public-health relevance, in plain language.' },
      SPECIFIC_AIMS,
      { ...SIGNIFICANCE, pageLimit: 1.5 },
      { ...INNOVATION, pageLimit: 1 },
      { ...APPROACH, pageLimit: 3.5 },
    ],
  },
  {
    id: 'custom-grant',
    name: 'Custom Grant Skeleton',
    mechanism: 'Custom',
    description: 'A generic funder-agnostic skeleton. Rename, add, or delete sections freely; paste the funder’s own requirements into Grant Instructions so the AI agents enforce them.',
    sections: [
      { title: 'Summary', guidance: 'A one-paragraph overview of the proposed work: problem, approach, and expected impact.' },
      { title: 'Specific Aims', guidance: 'The goals of the project, stated as 2-3 concrete, non-interdependent aims.' },
      { title: 'Background and Significance', guidance: 'The state of the field, the gap this project fills, and why it matters.' },
      { title: 'Approach', guidance: 'Design, methods, preliminary data, expected outcomes, pitfalls and alternatives, timeline.' },
      { title: 'Timeline and Deliverables', guidance: 'Milestones by project period and the concrete outputs the funder can expect.' },
    ],
  },
];

export function getGrantTemplate(id: string | null | undefined): GrantTemplate | undefined {
  return GRANT_TEMPLATES.find(t => t.id === id);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a template as TipTap-compatible HTML: H2 per section + italic guidance paragraph. */
export function templateToHtml(template: GrantTemplate): string {
  return template.sections.map(s => {
    const limit = s.pageLimit ? ` <em>(${s.pageLimit} page${s.pageLimit === 1 ? '' : 's'})</em>` : '';
    return `<h2>${escapeHtml(s.title)}</h2><p><em>${escapeHtml(s.guidance)}</em>${limit}</p><p></p>`;
  }).join('');
}
