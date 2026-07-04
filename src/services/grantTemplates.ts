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

// ─── Fellowship / career-award built-ins (copy & adjust via the template manager) ───

GRANT_TEMPLATES.push(
  {
    id: 'nih-f31',
    name: 'NIH F31/F32 — NRSA Fellowship',
    mechanism: 'F31/F32',
    description: 'Predoctoral (F31) / postdoctoral (F32) fellowship. Aims (1 page) + Research Strategy (6 pages) + training-focused sections.',
    sections: [
      { title: 'Project Summary / Abstract', pageLimit: 1, guidance: '30 lines max. Frame the science AND the training: what you will discover and what you will learn to become an independent scientist.' },
      SPECIFIC_AIMS,
      { title: 'Research Strategy', pageLimit: 6, guidance: 'Significance, Innovation, and Approach in one section. Emphasize how the research plan doubles as a training vehicle: which techniques and analytical skills you will acquire under whose guidance.' },
      { title: 'Applicant Background and Goals', pageLimit: 6, guidance: 'Your scientific trajectory: past training, career goals, and how this fellowship bridges them. Written with your sponsor; include a training timeline.' },
      { title: 'Sponsor and Training Environment', guidance: 'Sponsor track record, mentoring plan, institutional resources, courses, and committees. Usually drafted by the sponsor.' },
    ],
  },
  {
    id: 'nih-k99',
    name: 'NIH K99/R00 — Pathway to Independence',
    mechanism: 'K99/R00',
    description: 'Mentored-to-independent transition award. Aims (1 page) + Research Strategy (6 pages) + career development plan.',
    sections: [
      { title: 'Project Summary / Abstract', pageLimit: 1, guidance: '30 lines max. Make the two-phase structure visible: mentored K99 phase goals and independent R00 phase goals.' },
      SPECIFIC_AIMS,
      { title: 'Candidate Information and Career Development', pageLimit: 6, guidance: 'Career goals, training activities for the K99 phase, and the skills gap this award closes. Combined page limit shared with Research Strategy is 12 pages; keep each in balance.' },
      { title: 'Research Strategy', pageLimit: 6, guidance: 'Significance, Innovation, Approach. Design aims so the K99 phase de-risks the R00 phase; the R00 aims must be portable to your independent lab.' },
      { title: 'Training in Rigor and Reproducibility', guidance: 'How the plan builds rigorous experimental design, statistics, and transparency practices.' },
    ],
  },
);

export function getGrantTemplate(id: string | null | undefined): GrantTemplate | undefined {
  if (!id) return undefined;
  return GRANT_TEMPLATES.find(t => t.id === id) ?? customTemplateCache.find(t => t.id === id);
}

// ─── Custom templates (user-edited or AI-generated), persisted in Dexie ───────

import { db } from '../db/manuscriptDb';

let customTemplateCache: GrantTemplate[] = [];

export async function loadCustomTemplates(): Promise<GrantTemplate[]> {
  try {
    const rows = await db.grantTemplates.toArray();
    customTemplateCache = rows
      .map(r => r.template as GrantTemplate)
      .filter(t => t && t.id && Array.isArray(t.sections));
  } catch { customTemplateCache = []; }
  return customTemplateCache;
}

export function getCustomTemplates(): GrantTemplate[] {
  return customTemplateCache;
}

export async function saveCustomTemplate(template: GrantTemplate): Promise<void> {
  await db.grantTemplates.put({ id: template.id, template, updatedAt: Date.now() });
  await loadCustomTemplates();
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  await db.grantTemplates.delete(id);
  await loadCustomTemplates();
}

/**
 * Validate and normalize a template object (e.g. from the LLM generator or a
 * hand-edited form). Returns null if unusable.
 */
export function normalizeTemplate(raw: any, idPrefix = 'custom'): GrantTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const sectionsIn = Array.isArray(raw.sections) ? raw.sections : [];
  const sections: GrantTemplateSection[] = sectionsIn
    .filter((s: any) => s && typeof s.title === 'string' && s.title.trim())
    .slice(0, 16)
    .map((s: any) => {
      const pl = Number(s.pageLimit);
      return {
        title: String(s.title).trim().slice(0, 120),
        pageLimit: Number.isFinite(pl) && pl > 0 && pl <= 100 ? Math.round(pl * 2) / 2 : undefined,
        guidance: String(s.guidance ?? '').trim().slice(0, 600) || 'Write this section.',
      };
    });
  if (sections.length === 0) return null;
  return {
    id: `${idPrefix}-${Date.now()}`,
    name: String(raw.name ?? 'Custom Template').trim().slice(0, 120) || 'Custom Template',
    mechanism: String(raw.mechanism ?? 'Custom').trim().slice(0, 20) || 'Custom',
    description: String(raw.description ?? '').trim().slice(0, 400),
    sections,
  };
}

/** Words → pages under NIH formatting assumptions; one decimal place. */
export function wordsToPages(words: number): number {
  return Math.round((words / WORDS_PER_PAGE) * 10) / 10;
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
