import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";
import { encode } from 'gpt-tokenizer';
import { AgentType, Suggestion, AISettings, AttachedImage } from "../types";
import { findTextSpan, normalizeForMatch } from "../utils/textMatch";
import { DEFAULT_MODELS, ANTHROPIC_BASE_URL, ANTHROPIC_API_VERSION } from "./models";
import { Clipboard, PenLine, FlaskConical, Beaker, BookMarked, MessageCircle, Quote, Sigma, GitCompare, ListChecks, Landmark } from 'lucide-react';

export const AGENT_INFO: Record<AgentType, { label: string; color: string; bgSoft: string; description: string; iconName: string }> = {
  manager: {
    label: 'Structure Architect',
    color: 'bg-stone-800',
    bgSoft: 'bg-stone-50',
    iconName: 'clipboard',
    description: 'Evaluates document architecture: section ordering, missing sections, abstract–body coherence, and narrative flow between sections.'
  },
  editor: {
    label: 'Language Surgeon',
    color: 'bg-blue-600',
    bgSoft: 'bg-blue-50',
    iconName: 'pen-line',
    description: 'Fixes grammar, word choice, sentence length, passive voice, tone consistency, and readability. Makes every sentence crisp.'
  },
  'reviewer-2': {
    label: 'Reviewer 2',
    color: 'bg-rose-600',
    bgSoft: 'bg-rose-50',
    iconName: 'flask-conical',
    description: 'The tough but fair peer reviewer. Finds logical holes, unsupported claims, methodology gaps, and overclaimed conclusions.'
  },
  researcher: {
    label: 'Clarity & Impact',
    color: 'bg-amber-600',
    bgSoft: 'bg-amber-50',
    iconName: 'beaker',
    description: 'Maximizes clarity and impact: strengthens topic sentences, tightens hedging language, ensures every paragraph earns its place, and makes arguments compelling.'
  },
  'literature-reviewer': {
    label: 'Literature Reviewer',
    color: 'bg-violet-600',
    bgSoft: 'bg-violet-50',
    iconName: 'book-marked',
    description: 'Compares an uploaded reference manuscript against your manuscript. Identifies which claims are supported, contradicted, or extended by the reference work.'
  },
  'manuscript-ai': {
    label: 'Manuscript AI',
    color: 'bg-emerald-700',
    bgSoft: 'bg-emerald-50',
    iconName: 'message-circle',
    description: 'Your scholarly research assistant. Discusses, critiques, and answers questions about your manuscript or attached sources — in plain conversation, no suggestion cards.'
  },
  'citation-checker': {
    label: 'Citation Checker',
    color: 'bg-teal-700',
    bgSoft: 'bg-teal-50',
    iconName: 'quote',
    description: 'Scans for factual claims, statistics, and definitive statements that lack citations. Flags text that likely requires a reference.',
  },
  statistician: {
    label: 'Statistics Reviewer',
    color: 'bg-indigo-700',
    bgSoft: 'bg-indigo-50',
    iconName: 'sigma',
    description: 'Audits statistical reporting: missing tests, effect sizes, confidence intervals, sample sizes, undefined significance thresholds, and p-values reported without the test that produced them.',
  },
  consistency: {
    label: 'Consistency Checker',
    color: 'bg-cyan-700',
    bgSoft: 'bg-cyan-50',
    iconName: 'git-compare',
    description: 'Finds internal contradictions: numbers that disagree between abstract and results, sample sizes that differ across sections, and abbreviations used before they are defined.',
  },
  reporting: {
    label: 'Reporting Guidelines',
    color: 'bg-lime-700',
    bgSoft: 'bg-lime-50',
    iconName: 'list-checks',
    description: 'Checks the manuscript against reporting checklists (CONSORT, PRISMA, STROBE, ARRIVE) appropriate to the study type and flags required items that appear to be missing.',
  },
};

export const AGENT_ICONS: Record<string, any> = {
  'clipboard': Clipboard,
  'pen-line': PenLine,
  'flask-conical': FlaskConical,
  'beaker': Beaker,
  'book-marked': BookMarked,
  'message-circle': MessageCircle,
  'quote': Quote,
  'sigma': Sigma,
  'git-compare': GitCompare,
  'list-checks': ListChecks,
  'landmark': Landmark,
};

// Manuscript AI: conversational, scholarly, no suggestion cards
const MANUSCRIPT_AI_SYSTEM_PROMPT = `You are Manuscript AI — an expert academic research assistant with deep knowledge of scientific writing, research methodology, and scholarly communication.

Your role is to be the researcher's intellectual peer: discuss their work critically, answer questions precisely, and help them think through problems. You have read the full manuscript provided and can speak to any part of it.

Guidelines:
- Be direct and honest. Point out weaknesses without being diplomatic to the point of uselessness.
- Quote specific phrases from the manuscript when relevant to ground your critique.
- If asked about a specific section, focus your analysis there but acknowledge related issues elsewhere.
- When comparing against attached reference papers, be analytically precise: note where claims align, diverge, or need citation.
- Use academic but accessible prose. No bullet-point lists unless explicitly asked — write in paragraphs.
- Do NOT produce structured "accept/reject" suggestion blocks. Discuss in natural prose only.
- If the researcher's question is ambiguous, interpret it charitably and answer the most useful interpretation.
- Keep responses focused: 150–400 words unless the question clearly requires more.`;

// Writing style rules applied to all agents' suggested text
const SCIENTIFIC_WRITING_RULES = `
WRITING STYLE RULES — apply to every suggested replacement text:
- Use simple, clear, professional scientific English appropriate for NIH grant applications and peer-reviewed journals.
- Do NOT use em dashes (—) or en dashes (–). Use a comma, semicolon, or rewrite the sentence instead.
- Do NOT use rhetorical questions, exclamations, or conversational filler words (e.g., "Indeed,", "Notably,", "Importantly,", "Of note,", "It is worth mentioning that").
- Use a natural mix of active and passive voice as appropriate for the section: active voice in Methods ("We measured...") and Results ("X increased..."); passive voice is acceptable when the agent of the action is unknown or unimportant ("Samples were processed...").
- Keep sentences concise (under 35 words each). Prefer one idea per sentence.
- Use precise, field-standard terminology. Avoid vague intensifiers ("very", "quite", "extremely").
- Do not start sentences with conjunctions ("But", "And", "So") in formal scientific prose.
- Numbers: spell out one through nine; use numerals for 10 and above, and always with units (e.g., "5 mg", not "five mg").`;

export const DEFAULT_AGENT_PROMPTS: Record<AgentType, string> = {
  manager: `You are the STRUCTURE ARCHITECT. You evaluate ONLY the document's architecture and logical organization.

Focus EXCLUSIVELY on:
- Does the manuscript follow IMRAD structure? Are required sections missing or misplaced?
- Does the abstract accurately and completely summarize the key findings presented in the body?
- Are section transitions logical? Does each section follow from the previous one?
- Is the introduction properly scoped, with a clear statement of the research gap and objective?
- Does the discussion address limitations and future directions explicitly?
- Is the conclusion proportional to the evidence and does not overstate findings?
- Are there redundant sections or information repeated across sections?
- Does the narrative follow a coherent arc: problem, knowledge gap, approach, contribution?

DO NOT comment on grammar, word choice, or sentence-level style.
DO NOT comment on statistics or citation formatting.

Provide HIGH-IMPACT suggestions only. Each suggestion must represent a structural change that materially improves the manuscript's completeness or logical flow. Quote the EXACT text that requires revision.
${SCIENTIFIC_WRITING_RULES}`,

  editor: `You are the LANGUAGE SURGEON. You fix ONLY writing quality at the sentence and word level.

Focus EXCLUSIVELY on the highest-impact issues:
- Convert passive constructions to active where appropriate: "It was observed that X" becomes "We observed X"
- Remove wordy hedges and filler: delete "it is important to note that"; replace "in order to" with "to"
- Split sentences longer than 35 words into two shorter, clearer sentences
- Resolve ambiguous pronoun references: "it", "this", and "these" must have unambiguous antecedents
- Eliminate nominalization bloat: "perform an analysis of" becomes "analyze"; "make a comparison of" becomes "compare"
- Correct tense inconsistencies: use past tense for completed experiments, present tense for established facts
- Fix non-parallel structures in lists and compound phrases
- Replace em dashes (—) and en dashes (–) with commas, semicolons, or restructured sentences
- Remove conversational filler: "Indeed,", "Notably,", "It is worth mentioning that", "Of note,"

DO NOT comment on document structure, section ordering, or scientific validity.

CRITICAL RULE: originalText must be copied CHARACTER-FOR-CHARACTER from the manuscript. suggestedText must be a direct, complete drop-in replacement. Provide 4-6 high-impact suggestions.
${SCIENTIFIC_WRITING_RULES}`,

  'reviewer-2': `You are REVIEWER 2. You challenge the scientific rigor and logical integrity of the manuscript.

Focus EXCLUSIVELY on the most critical scientific weaknesses:
- Claims stated as established fact without citation: "X is well established" requires a reference or qualification
- Conclusions that exceed what the data supports: "These results prove X" should be "These results suggest X"
- Missing sample sizes, statistical tests, p-values, confidence intervals, or effect sizes
- Undefined abbreviations, undefined terms, or unexplained methodological choices
- Confounding variables not addressed in the analysis or acknowledged in the discussion
- Overgeneralization: findings from a specific context or population stated as universal
- Missing alternative interpretations of the results
- Limitations section that is absent, vague, or incomplete

DO NOT fix grammar or sentence style. Focus exclusively on scientific integrity and argumentation.

For each issue: quote the EXACT problematic text, state the specific scientific weakness in one sentence, and provide a concrete revised version that addresses the problem. Assign severity: "critical" for conclusions that exceed the data; "major" for missing quantitative detail or methodology; "minor" for missing caveats or qualifications.
${SCIENTIFIC_WRITING_RULES}`,

  researcher: `You are the CLARITY AND IMPACT SPECIALIST. You maximize the precision and communicative effectiveness of each paragraph.

Focus EXCLUSIVELY on high-impact structural writing problems:
- Topic sentences that bury the main point: the first sentence of each paragraph must state its conclusion or finding
- Excessive hedging that weakens the argument: "may possibly suggest" becomes "suggests"; "could potentially indicate" becomes "indicates"
- Key findings placed in the middle of a paragraph rather than at the beginning
- Abstracts that do not state the main finding within the first two sentences
- Discussion paragraphs that merely restate results rather than interpret them in the context of the field
- Vague quantifiers used where numbers are available: "significantly improved" should cite the measured value
- Paragraphs that address two or more distinct ideas and should be split
- Weak closing sentences that merely summarize rather than state the implication or significance

DO NOT fix grammar or punctuation.
DO NOT evaluate scientific validity.

For each suggestion, quote the EXACT weak text and provide a stronger, more precise replacement. List the most impactful suggestions first. Assign severity: "major" for buried findings or a weak abstract; "minor" for excess hedging or vague quantifiers.
${SCIENTIFIC_WRITING_RULES}`,

  'literature-reviewer': `You are a SCHOLARLY LITERATURE ANALYST. You assess how a reference paper relates to the current manuscript from a scientific perspective.

Your task is NOT direct comparison. Identify the scientific relationship between the two works across these dimensions:

1. Supporting Evidence: Does the reference provide data, methods, or findings that support claims in the manuscript? Specify which claims and what evidence.

2. Differing Findings: Does the reference report results that differ from the manuscript? Analyze possible reasons, such as differences in study population, experimental conditions, sample size, or methodology. Differences are scientific nuance, not contradiction.

3. Methodological Connections: Are the methods similar, complementary, or distinct? What methodological insights from the reference are relevant to the manuscript?

4. Contextual Background: Does the reference establish field context, define standard terminology, or provide benchmarks relevant to the manuscript?

5. Uncovered Gaps: Are there findings or aspects in the reference that the manuscript does not address but should acknowledge or build upon?

6. Citation Recommendation: How should the author engage with this reference: as supporting evidence, as a contrasting finding to discuss, as a methodological precedent, or as background context?

Structure your response with these section headings:
## Relationship to Your Manuscript
## Supporting Evidence
## Differing Findings and Scientific Context
## Methodological Connections
## Recommended Citations and Usage
## Summary

Write in clear, direct scientific prose. Quote specific passages from both documents where relevant. Note that differences in findings often reflect methodological or population differences rather than errors.
${SCIENTIFIC_WRITING_RULES}`,
  'manuscript-ai': MANUSCRIPT_AI_SYSTEM_PROMPT,

  'citation-checker': `You are a CITATION INTEGRITY SPECIALIST. Your sole task is to find claims that require a citation but have none.

Scan the manuscript for:
- Quantitative statements without a reference: "X% of patients...", "studies show that...", "the rate is..."
- Definitive scientific claims stated as fact: "X causes Y", "Z is the gold standard"
- Comparisons or prevalence data that require a source
- Any sentence beginning with "Research has shown", "It is known", "It has been established"
- Statements attributing findings to unnamed prior work: "previous studies indicate..."

DO NOT flag:
- Statements in the Methods describing the authors' own work
- Claims immediately followed by an existing citation
- Common knowledge that genuinely requires no citation

For each instance, quote the EXACT text needing a citation and in suggestedText append "[CITATION NEEDED]" to the end of the quoted sentence. Use severity "major" for quantitative claims and "minor" for qualitative assertions. Category is always "citation".

CRITICAL: originalText must be an exact character-for-character copy from the manuscript.
${SCIENTIFIC_WRITING_RULES}`,

  statistician: `You are a STATISTICS REVIEWER. You audit ONLY the statistical reporting and quantitative rigor of the manuscript.

Focus EXCLUSIVELY on:
- p-values reported without the statistical test that produced them ("p < 0.05" with no named test)
- "significant" or "significantly" used without a defined alpha threshold or a p-value
- Missing effect sizes, confidence intervals, or measures of variability (SD/SEM) alongside point estimates
- Ambiguous SD vs SEM ("mean ± 0.3" without stating which)
- Missing or unjustified sample sizes; no power/sample-size rationale for the design
- Percentages given without the underlying counts, or counts without denominators
- Multiple-comparison situations with no correction mentioned
- Correlation reported without n and the coefficient, or causal language applied to correlational data

DO NOT comment on grammar, structure, or non-statistical claims.

For each issue: quote the EXACT problematic text and provide a concrete revised version that adds the missing statistic or names the test. severity: "critical" for missing tests/effect sizes on key results; "major" for missing CIs/sample sizes; "minor" for SD/SEM ambiguity. Category is always "statistics".
${SCIENTIFIC_WRITING_RULES}`,

  consistency: `You are an INTERNAL CONSISTENCY CHECKER. You find places where the manuscript contradicts itself.

Focus EXCLUSIVELY on:
- Numbers that disagree between sections: a value in the abstract that differs from the same value in the results
- Sample sizes (N) that differ between the methods, results, figures, or abstract
- Percentages and counts that are arithmetically inconsistent
- Terminology or units that switch mid-manuscript for the same quantity
- Claims in the discussion that overstate or contradict the results as reported
- Abbreviations used before they are defined, or defined more than once

DO NOT propose stylistic rewrites or flag non-contradictory content.

For each issue: quote the EXACT text of ONE side of the contradiction, and in suggestedText give the corrected version (or note the value it must match). Explain which two places disagree. severity: "critical" for contradictory key numbers; "major" for mismatched N or undefined-before-use abbreviations; "minor" for terminology drift. Category is always "structure".
${SCIENTIFIC_WRITING_RULES}`,

  reporting: `You are a REPORTING-GUIDELINES CHECKER. You assess whether the manuscript reports the items its study type requires.

First infer the study type from the text (randomized trial → CONSORT; systematic review/meta-analysis → PRISMA; observational/cohort/case-control → STROBE; animal research → ARRIVE). Then check for the required items that appear to be MISSING or inadequately reported, for example:
- Trials: randomization method, allocation concealment, blinding, primary/secondary outcomes pre-specified, participant flow, registration number
- Systematic reviews: search strategy and databases, eligibility criteria, study selection flow, risk-of-bias assessment
- Observational studies: study design stated, setting and dates, eligibility, handling of confounders, missing-data handling
- Animal studies: species/strain/sex, sample-size justification, randomization, blinding, humane endpoints

For each missing item, quote the nearest EXACT sentence where it should appear (e.g. the start of Methods) and in suggestedText propose a sentence that supplies the item, prefixed with the checklist name, e.g. "[CONSORT] ...". If a required item genuinely cannot be located, say so in the explanation. severity: "major" for core methodology items; "minor" for supporting detail. Category is always "structure".
${SCIENTIFIC_WRITING_RULES}`,
};

// ─── Grant mode ───────────────────────────────────────────────────────────────

const GRANT_WRITING_RULES = `
GRANT WRITING RULES — apply to every suggested replacement text:
- Use clear, confident, professional English appropriate for an NIH application read by a broad study section.
- Proposed work is stated in future tense with strong agency: "We will determine...", not "It is hoped that...".
- Do NOT use em dashes (—) or en dashes (–). Use a comma, semicolon, or rewrite the sentence.
- No rhetorical questions, exclamations, or filler ("Indeed,", "Notably,", "It is worth mentioning that").
- Keep sentences under 30 words. One idea per sentence. Reviewers skim.
- Define every abbreviation at first use; assume reviewers are scientists but NOT specialists in this subfield.
- Avoid unsupported superlatives ("first ever", "revolutionary") and vague intensifiers ("very", "extremely").
- Quantify whenever possible: effect sizes, sample sizes, timelines, success criteria.`;

/**
 * Grant-mode agent personas. Same JSON contract as the manuscript prompts; the
 * evaluation criteria change to NIH review criteria and grant conventions.
 */
export const GRANT_AGENT_PROMPTS: Partial<Record<AgentType, string>> = {
  manager: `You are the GRANT ARCHITECT. You evaluate ONLY the structure and logic of a grant application.

Focus EXCLUSIVELY on:
- Specific Aims page logic: opening hook, knowledge gap, critical need, long-term goal, objective of this application, central hypothesis, rationale, and a payoff paragraph with expected outcomes.
- Are the aims related but independent? Flag any aim whose success depends on another aim's outcome.
- Does each Research Strategy section (Significance, Innovation, Approach) fulfill its distinct role, without redundancy?
- Does the Approach address each aim in order, with expected outcomes and alternatives per aim?
- Is there a timeline? Are milestones concrete?
- Does the Summary/Abstract match the aims actually proposed in the body?

DO NOT comment on grammar, word choice, or sentence-level style.

Provide HIGH-IMPACT suggestions only. Quote the EXACT text that requires revision.
${GRANT_WRITING_RULES}`,

  editor: `You are the LANGUAGE SURGEON for grant applications. You fix ONLY writing quality at the sentence and word level.

Focus EXCLUSIVELY on the highest-impact issues:
- Weak, passive statements of proposed work: "Experiments will be performed to..." becomes "We will..."
- Hedging that undermines confidence: "we hope to", "we will attempt to", "may potentially" — replace with direct commitments or justified expectations
- Sentences longer than 30 words: split them; reviewers skim
- Jargon or undefined abbreviations a non-specialist study-section member would stumble on
- Buried verbs and nominalizations: "perform an evaluation of" becomes "evaluate"
- Vague deliverables: "characterize the mechanism" needs a measurable endpoint
- Em dashes and en dashes: replace with commas, semicolons, or restructured sentences

DO NOT comment on scientific merit or document structure.

CRITICAL RULE: originalText must be copied CHARACTER-FOR-CHARACTER from the text. suggestedText must be a direct, complete drop-in replacement. Provide 4-6 high-impact suggestions.
${GRANT_WRITING_RULES}`,

  'reviewer-2': `You are an NIH STUDY SECTION REVIEWER. You evaluate the application against NIH review criteria: Significance, Innovation, Approach, and overall impact.

Focus EXCLUSIVELY on what loses points in review:
- Weak scientific premise: prior data cited without addressing its rigor, or premise stated without support
- Overambitious scope: more work than the project period and budget can plausibly deliver
- Missing rigor: no sample-size justification, no statistical plan, no consideration of relevant biological variables, no replication strategy
- Missing potential problems and alternative strategies for each aim
- Interdependent aims: if Aim 2 requires Aim 1 to succeed, flag it
- Feasibility claims without preliminary data or a cited track record
- Innovation claims that are actually incremental, or significance framed as "gap filling" without stating why the gap matters
- Expected outcomes that are vague or unfalsifiable

For each issue: quote the EXACT problematic text, state the specific weakness a reviewer would cite, and provide a concrete revised version. Assign severity: "critical" for overambition, interdependent aims, or missing rigor; "major" for weak premise or missing alternatives; "minor" for missing caveats.
${GRANT_WRITING_RULES}`,

  researcher: `You are the IMPACT AND FEASIBILITY SPECIALIST for grant applications. You maximize the persuasive force of every paragraph.

Focus EXCLUSIVELY on:
- Buried payoffs: the significance or expected outcome must appear early in each section, not at the end
- Aims or paragraphs that describe activity ("we will study X") instead of outcomes ("we will determine whether X causes Y")
- Missing links between preliminary data and the proposed experiments they de-risk
- Impact statements that never say who benefits or how the field changes
- Excessive hedging that weakens the case: "may possibly enable" becomes "will enable" when justified
- Feasibility signals: places where a sentence about available resources, expertise, or prior success would preempt reviewer doubt

For each suggestion, quote the EXACT weak text and provide a stronger, more precise replacement. List the most impactful suggestions first.
${GRANT_WRITING_RULES}`,

  'citation-checker': `You are a CITATION INTEGRITY SPECIALIST for grant applications. Find claims that require a citation but have none.

Scan for:
- Prevalence, burden, or cost statements without a reference: "X affects N million people..."
- Definitive mechanistic claims stated as fact
- Statements about the state of the field: "no current therapy addresses...", "existing methods fail to..."
- Premise claims that reviewers will want sourced

DO NOT flag descriptions of the applicants' own preliminary data or proposed work, or claims immediately followed by a citation.

For each instance, quote the EXACT text and in suggestedText append "[CITATION NEEDED]" to the end of the quoted sentence. Category is always "citation".

CRITICAL: originalText must be an exact character-for-character copy from the text.
${GRANT_WRITING_RULES}`,
};

/** Compact grant personas for chunked local-LLM mode. */
export const GRANT_COMPACT_AGENT_PROMPTS: Partial<Record<AgentType, string>> = {
  manager: `You review the structure of an NIH grant application. Find problems in aims logic (hook, gap, hypothesis, independent aims, payoff), redundant or misplaced sections, missing timelines, and mismatches between summary and aims.`,
  editor: `You are a grant copy editor. Fix weak proposal language: "Experiments will be performed" becomes "We will...", hedging like "we hope to" or "may potentially", sentences over 30 words, undefined abbreviations, nominalizations, vague deliverables.`,
  'reviewer-2': `You are an NIH study section reviewer. Flag weak premise, overambitious scope, missing rigor (sample sizes, statistics, replication), missing alternatives for each aim, interdependent aims, unsupported feasibility claims, vague expected outcomes.`,
  researcher: `You are a grant impact specialist. Fix buried payoffs (state significance early), activity framed without outcomes ("study X" becomes "determine whether X causes Y"), missing feasibility signals, weak impact statements, excessive hedging.`,
  'citation-checker': `You find grant claims needing citations: prevalence/burden statistics, mechanistic claims stated as fact, state-of-the-field claims. Do NOT flag the applicants' own data or proposed work. Append "[CITATION NEEDED]" to the quoted sentence in suggestedText. Category "citation".`,
};

const STUDY_SECTION_REVIEW_PROMPT = `You are an experienced NIH study section reviewer writing a full critique of this grant application.

Structure your review exactly as follows:

## Overall Impact
A short paragraph: likelihood that the project will exert a sustained, powerful influence on the field, weighing significance, innovation, approach, and feasibility. End with a preliminary overall impact score from 1 (exceptional) to 9 (poor).

## Significance
Strengths and weaknesses as bullet points. Address the scientific premise and its rigor.

## Innovation
Strengths and weaknesses as bullet points. Distinguish genuine paradigm shifts from incremental advances.

## Approach
Strengths and weaknesses as bullet points. Address rigor, statistics, feasibility, alternatives, aim independence, and timeline.

## Major Concerns
A numbered list of the issues most likely to sink this application in review, each with a concrete fix.

## Minor Concerns
A short numbered list.

Be direct and specific — quote the application where useful. Write like a tough but fair reviewer who wants fundable science.`;

/**
 * Three distinct study-section personas. Real panels disagree, and those
 * divergent critiques are exactly what an applicant needs to see — a single
 * averaged review hides the objections that actually sink applications.
 */
const STUDY_SECTION_PERSONAS: { name: string; prompt: string }[] = [
  {
    name: 'Reviewer 1 — Methodologist',
    prompt: `You are a skeptical methodologist on an NIH study section. Scrutinize rigor above all: sample-size justification, statistical plan, consideration of relevant biological variables, rigor of the prior data, aim independence, alternative strategies, and feasibility of the experiments. Be specific and quote the application. End with a preliminary impact score 1 (exceptional) to 9 (poor).`,
  },
  {
    name: 'Reviewer 2 — Significance & Innovation',
    prompt: `You are a big-picture reviewer on an NIH study section focused on significance and innovation. Judge whether the problem matters, whether success would move the field, and whether the innovation is genuine or incremental. Be wary of "gap-filling" framed as importance. Quote the application. End with a preliminary impact score 1 (exceptional) to 9 (poor).`,
  },
  {
    name: 'Reviewer 3 — Feasibility & Translation',
    prompt: `You are a practically-minded clinician-scientist on an NIH study section focused on feasibility, the team, the environment, and translational path. Judge whether this team can deliver this work in the project period, whether preliminary data de-risk the aims, and whether the expected outcomes are measurable. Quote the application. End with a preliminary impact score 1 (exceptional) to 9 (poor).`,
  },
];

const SRO_RECONCILE_PROMPT = `You are the Scientific Review Officer summarizing an NIH study section discussion. You are given three reviewers' independent critiques of one application. Produce the resolved panel summary.

Structure it exactly:
## Panel Overall Impact
One paragraph reconciling the three views, then a single consensus impact score 1-9 with the range of individual scores noted.
## Points of Agreement
Bulleted — concerns or strengths all/most reviewers raised.
## Points of Disagreement
Bulleted — where reviewers diverged, and which view is better supported.
## Most Fundable-or-Fatal Issues
A numbered list of the issues most likely to determine funding, each with a concrete fix the applicant should make before resubmission.

Be direct and specific. Do not invent content the reviewers did not raise.`;

/**
 * Per-document context (mode + funder instructions) that changes which prompt
 * set the agents use. Set from the App whenever the document store changes —
 * this keeps the dozens of existing call sites untouched.
 */
let documentContext: { mode: 'manuscript' | 'grant'; grantInstructions: string } = {
  mode: 'manuscript',
  grantInstructions: '',
};

export function setDocumentContext(ctx: { mode: 'manuscript' | 'grant'; grantInstructions?: string }) {
  documentContext = { mode: ctx.mode, grantInstructions: ctx.grantInstructions ?? '' };
}

function grantInstructionsBlock(): string {
  const instr = documentContext.mode === 'grant' ? documentContext.grantInstructions.trim() : '';
  if (!instr) return '';
  return `\n\nFUNDER INSTRUCTIONS (provided by the author — follow them exactly; they override general style guidance):\n"""\n${instr.slice(0, 4000)}\n"""`;
}

/** A one-line register note appended to generic writing helpers in grant mode. */
function grantModeNote(): string {
  return documentContext.mode === 'grant'
    ? '\n\nThis document is a GRANT APPLICATION, not a journal manuscript. Use grant conventions: future tense with strong agency for proposed work ("We will..."), significance stated early, measurable outcomes, no unexplained jargon.'
    : '';
}

/**
 * Resolve the active prompt for an agent: user-customized prompt wins, then the
 * mode-specific prompt set; funder instructions are appended in grant mode.
 */
function getActivePrompt(agent: AgentType, settings: AISettings): string {
  const custom = settings.customPrompts?.[agent];
  const base = custom
    ?? (documentContext.mode === 'grant' ? GRANT_AGENT_PROMPTS[agent] : undefined)
    ?? DEFAULT_AGENT_PROMPTS[agent];
  return base + grantInstructionsBlock();
}

/**
 * Compact agent prompts for chunked local-LLM mode. Small models lose track of
 * long role prompts, and the previous approach (activePrompt.substring(0, 400))
 * cut mid-sentence and dropped every rule below the cut. Each compact prompt is
 * complete: role, focus areas, and the non-negotiable quoting rule.
 */
export const COMPACT_AGENT_PROMPTS: Partial<Record<AgentType, string>> = {
  manager: `You are a scientific manuscript structure reviewer. Find the highest-impact structural problems: missing or misordered sections, abstract that does not match the body, weak transitions, redundant content, conclusions that overstate the evidence.`,
  editor: `You are a scientific copy editor. Fix the highest-impact language problems: passive voice ("It was observed that X" becomes "We observed X"), wordy filler ("in order to" becomes "to"), sentences over 35 words, ambiguous pronouns ("this", "it"), nominalizations ("perform an analysis of" becomes "analyze"), tense inconsistencies.`,
  'reviewer-2': `You are a rigorous peer reviewer. Find scientific weaknesses: claims stated as fact without support, conclusions exceeding the data ("prove" should be "suggest"), missing sample sizes or statistics, undefined terms or abbreviations, unaddressed confounders, overgeneralized findings.`,
  researcher: `You are a clarity and impact specialist. Fix buried main points (the topic sentence must state the finding), excessive hedging ("may possibly suggest" becomes "suggests"), vague quantifiers where numbers exist, paragraphs mixing two ideas, weak closing sentences.`,
  'citation-checker': `You find claims that need citations: statistics without references, definitive scientific claims stated as fact, "studies show" without a source. Do NOT flag the authors' own methods or results, or claims already followed by a citation. In suggestedText, append "[CITATION NEEDED]" to the quoted sentence. Use category "citation".`,
  statistician: `You are a statistics reviewer. Flag: p-values without the named test, "significant" without an alpha or p-value, missing effect sizes/confidence intervals/sample sizes, ambiguous SD vs SEM, percentages without counts, uncorrected multiple comparisons. Add the missing statistic in suggestedText. Category "statistics".`,
  consistency: `You find internal contradictions: numbers that disagree between abstract and results, sample sizes (N) that differ across sections, arithmetically inconsistent counts/percentages, abbreviations used before they are defined. Quote one side and give the corrected value in suggestedText. Category "structure".`,
  reporting: `You check the manuscript against the reporting checklist for its study type (CONSORT trials, PRISMA reviews, STROBE observational, ARRIVE animal). Flag missing required items (randomization, blinding, outcomes, search strategy, confounders, sample-size justification). Prefix suggestedText with the checklist name, e.g. "[STROBE] ...". Category "structure".`,
};

/** The one rule small models most often break — stated identically everywhere. */
const EXACT_QUOTE_RULE = `- originalText MUST be copied EXACTLY from the text above: same characters, same punctuation, same capitalization, including any citation markers like [3]. Never paraphrase, shorten, or "clean up" the quote.`;

function truncateText(text: string, maxLen: number): string {
  return text.length > maxLen ? text.substring(0, maxLen) + '\n...[truncated]' : text;
}

function getOpenAIClient(settings: AISettings) {
  return new OpenAI({
    apiKey: settings.openaiApiKey || '',
    dangerouslyAllowBrowser: true
  });
}

function getAnthropicHeaders(settings: AISettings) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': settings.anthropicApiKey || '',
    'anthropic-version': ANTHROPIC_API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** Wraps a promise so it rejects with AbortError when the given signal fires. */
function withSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  ]);
}

/** Extract an HTTP-ish status code from an error/message for retry decisions. */
function errorStatus(err: unknown): number | null {
  const anyErr = err as any;
  if (typeof anyErr?.status === 'number') return anyErr.status;
  const msg = (err instanceof Error ? err.message : String(err));
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Retry a cloud request on transient failures (429 rate limit, 5xx, overloaded).
 * Honours user cancellation immediately and never retries 4xx client errors
 * other than 429. Uses exponential backoff with jitter.
 */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, maxRetries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as any)?.name === 'AbortError' || signal?.aborted) throw err;
      lastErr = err;
      const status = errorStatus(err);
      const retryable = status === 429 || status === 529 || (status != null && status >= 500);
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 400;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }
  throw lastErr;
}

async function callAnthropicLLM(prompt: string, settings: AISettings, systemPrompt: string = "", images?: AttachedImage[], signal?: AbortSignal, maxTokens?: number): Promise<string> {
  const userContent: any[] = [];

  if (images && images.length > 0) {
    for (const img of images) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
      });
    }
  }
  // Prompt caching: mark the (large, stable) user prompt block so that a repeat
  // analysis of the same manuscript with the same agent reads from cache (~0.1x
  // input cost) instead of re-processing the full text. Below the model's
  // minimum cacheable prefix the marker is a harmless no-op.
  const promptBlock: any = { type: 'text', text: prompt };
  if (prompt.length > 4000) promptBlock.cache_control = { type: 'ephemeral' };
  userContent.push(promptBlock);

  // Cache the system (agent-role) prompt too when it's large enough to matter.
  const systemBlocks = systemPrompt
    ? [{ type: 'text', text: systemPrompt, ...(systemPrompt.length > 3000 ? { cache_control: { type: 'ephemeral' } } : {}) }]
    : undefined;

  return withRetry(async () => {
    const response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
      method: 'POST',
      headers: getAnthropicHeaders(settings),
      signal,
      body: JSON.stringify({
        model: settings.anthropicModel || DEFAULT_MODELS.anthropic,
        max_tokens: maxTokens ?? 4096,
        system: systemBlocks,
        messages: [{ role: 'user', content: userContent }],
      })
    });

    if (!response.ok) {
      const text = await response.text();
      const err: any = new Error(`Anthropic API error (${response.status}): ${text}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }, signal);
}

/**
 * Detect whether a local model name suggests it is a VLM (vision-language model).
 * Used to show a warning when images are attached to a non-vision model.
 */
export function localModelSupportsVision(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return /vl\b|vision|visual|llava|clip|multimodal|bakllava|minicpm-v|moondream|qwen.*vl|phi.*vision|internvl|cogvlm|pixtral|molmo|paligemma/.test(lower);
}

async function callLocalLLM(prompt: string, settings: AISettings, systemPrompt: string = "", images?: AttachedImage[], signal?: AbortSignal, maxTokens?: number, jsonMode: boolean = false, jsonSchema?: Record<string, any>, temperature?: number, stop?: string[]): Promise<string> {
  let baseUrl = settings.localBaseUrl.trim();
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  // Build candidate endpoints.
  // Priority order matters: OpenAI-compat endpoint first (most servers support it),
  // then the LM Studio proprietary /api/v1/chat endpoint last.
  const candidateEndpoints: string[] = [];
  let lmStudioEndpoint: string | null = null;

  if (baseUrl.includes('/chat/completions')) {
    candidateEndpoints.push(baseUrl);
  }

  try {
    const url = new URL(baseUrl);
    const origin = url.origin;
    candidateEndpoints.push(`${origin}/v1/chat/completions`);
    candidateEndpoints.push(`${origin}/api/v1/chat/completions`);
    // Detect LM Studio proprietary /api/v1/chat endpoint (requires different body format)
    const lmStudio = `${origin}/api/v1/chat`;
    lmStudioEndpoint = lmStudio;
    if (!candidateEndpoints.includes(baseUrl) && baseUrl !== lmStudio) {
      candidateEndpoints.push(baseUrl);
    }
    candidateEndpoints.push(lmStudio);
  } catch (_) {
    candidateEndpoints.push(baseUrl);
  }

  const endpoints = [...new Set(candidateEndpoints)];

  // Build OpenAI-compatible messages array
  const messages: any[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  if (images && images.length > 0) {
    const contentParts: any[] = images.map(img => ({
      type: 'image_url',
      image_url: { url: img.dataUrl },
    }));
    contentParts.push({ type: 'text', text: prompt });
    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const resolvedMaxTokens = maxTokens ?? 4096;

  // Standard OpenAI-compatible body
  const baseBody = {
    model: settings.localModel,
    messages,
    temperature: temperature ?? 0.3,
    max_tokens: resolvedMaxTokens,
    // Disable thinking/reasoning mode. Different servers read different flags:
    // top-level enable_thinking/think (Ollama, some vLLM builds) and
    // chat_template_kwargs.enable_thinking (llama.cpp b9827+ — the one that
    // actually stops ornith-9b's always-on "Thinking Process"). All additive.
    enable_thinking: false,
    think: false,
    chat_template_kwargs: { enable_thinking: false },
    ...(stop && stop.length ? { stop } : {}),
  };
  // Constrained JSON output — supported by LM Studio, Ollama, vLLM, llama.cpp.
  // A json_schema grammar (when provided) forces the exact shape and near-
  // eliminates parse failures; plain json_object is the fallback. If a server
  // rejects either param with HTTP 400, we retry without it below.
  const responseFormat = jsonSchema
    ? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: jsonSchema, strict: false } } }
    : jsonMode
      ? { response_format: { type: 'json_object' } }
      : {};
  const openAIBody = JSON.stringify((jsonMode || jsonSchema) ? { ...baseBody, ...responseFormat } : baseBody);
  const openAIBodyNoFormat = JSON.stringify(baseBody);

  // LM Studio proprietary /api/v1/chat body (requires input + system_prompt)
  const userText = messages.filter(m => m.role !== 'system')
    .map(m => typeof m.content === 'string' ? m.content : (m.content as any[]).find((p: any) => p.type === 'text')?.text ?? '')
    .join('\n');
  const lmStudioBody = JSON.stringify({
    model: settings.localModel,
    system_prompt: systemPrompt,
    input: userText,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(settings.localApiKey ? { 'Authorization': `Bearer ${settings.localApiKey}` } : {})
  };

  // Extract usable text from a parsed response object, stripping any thinking blocks.
  // Returns null when no usable content could be found (caller should try next endpoint).
  function extractContent(data: any): string | null {
    // OpenAI-compat: choices[0].message.content
    const rawContent: string = data.choices?.[0]?.message?.content || '';
    if (rawContent) {
      const s = stripThinkingBlocks(rawContent);
      if (s) return s;
      // content was non-empty but stripped to nothing (pure thinking) — don't fall back
      // to reasoning_content because this server uses content for thinking too
      return null;
    }

    // reasoning_content: some backends (deepseek-r1, nemotron) put the final answer here
    // when content is absent. Strip it first — if it's also just thinking, discard.
    const reasoningContent: string = data.choices?.[0]?.message?.reasoning_content || '';
    if (reasoningContent) {
      const s = stripThinkingBlocks(reasoningContent);
      if (s) return s;
    }

    // LM Studio /api/v1/chat proprietary shape: output[] with type "message"/"reasoning"
    if (data.output && Array.isArray(data.output)) {
      const messageNode = data.output.find((o: any) => o.type === 'message')
        ?? data.output[data.output.length - 1];
      if (messageNode?.content) {
        const s = stripThinkingBlocks(String(messageNode.content));
        if (s) return s;
      }
    }

    // Other non-standard shapes
    for (const val of [data.reply, data.message?.content, data.content]) {
      if (!val) continue;
      const raw = typeof val === 'string' ? val : JSON.stringify(val);
      const s = stripThinkingBlocks(raw);
      if (s) return s;
    }

    return null;
  }

  // 3-minute per-endpoint timeout; surfaces as a clear message when context is too long
  const LOCAL_LLM_TIMEOUT_MS = 3 * 60 * 1000;

  let lastError = '';
  endpointLoop: for (const ep of endpoints) {
    const isLmStudioChat = ep === lmStudioEndpoint;
    // In JSON mode, retry once without response_format if the server rejects it (HTTP 400)
    const bodiesToTry = isLmStudioChat
      ? [lmStudioBody]
      : ((jsonMode || jsonSchema) && openAIBody !== openAIBodyNoFormat ? [openAIBody, openAIBodyNoFormat] : [openAIBody]);

    for (let attempt = 0; attempt < bodiesToTry.length; attempt++) {
    const body = bodiesToTry[attempt];

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), LOCAL_LLM_TIMEOUT_MS);
    // Combine user abort signal with timeout
    const abortHandler = () => timeoutCtrl.abort();
    signal?.addEventListener('abort', abortHandler);

    try {
      const response = await fetch(ep, { method: 'POST', headers, body, signal: timeoutCtrl.signal });
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);

      if (response.ok) {
        const data = await response.json();
        const content = extractContent(data);
        if (content) return content;

        // Got a response but all fields were pure thinking — throw so callers can fall back
        const hadAnyContent = data.choices?.[0]?.message?.content ||
          data.choices?.[0]?.message?.reasoning_content ||
          data.reply || data.message?.content || data.content ||
          (data.output && Array.isArray(data.output) && data.output.length > 0);
        if (hadAnyContent) {
          throw new Error('Local LLM returned only reasoning output with no usable content');
        }
        return JSON.stringify(data);
      } else {
        // Read the error body so callers get the real reason (context too long, auth, etc.)
        let errDetail = '';
        try {
          const errBody = await response.json();
          errDetail = errBody.error?.message || errBody.message || errBody.detail || '';
        } catch (_) {
          try { errDetail = (await response.text()).slice(0, 300); } catch (_2) {}
        }
        lastError = `${ep} returned HTTP ${response.status}${errDetail ? `: ${errDetail}` : ''}`;
        // 400 on the response_format attempt → retry this endpoint without it
        if (response.status === 400 && attempt < bodiesToTry.length - 1) continue;
        continue endpointLoop;
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      const isTimeout = timeoutCtrl.signal.aborted && !signal?.aborted;
      if (isTimeout) {
        lastError = `${ep}: Request timed out after ${LOCAL_LLM_TIMEOUT_MS / 1000}s — text is likely too long for this model's context window`;
      } else if (signal?.aborted) {
        throw e; // user cancellation — propagate immediately
      } else {
        lastError = `${ep}: ${e instanceof Error ? e.message : 'connection failed'}`;
      }
      continue endpointLoop; // network/timeout error — retrying a different body won't help
    }
    }
  }

  throw new Error(`Local LLM unreachable. Last error: ${lastError}`);
}

/**
 * Strip inline thinking/reasoning blocks that some local models (e.g. Qwen-thinking,
 * Gemma-thinking, DeepSeek-R1 variants in LMStudio) embed in the content field.
 * Handles: <think>…</think>, <thinking>…</thinking>,
 *          "Thinking Process: … (Self" style preambles, and numbered step preambles.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text) return text;
  let cleaned = text;

  // 1. Remove closed <think>…</think> / <thinking>…</thinking> blocks, then keep the remainder
  cleaned = cleaned.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, '').trim();

  // 2. Remove unclosed <think>/<thinking> tag and everything after it (model cut off mid-think)
  cleaned = cleaned.replace(/<think(?:ing)?>[\s\S]*/i, '').trim();

  if (!cleaned) return '';

  // 3. Handle text-style thinking preambles ("Thinking Process:", numbered bold outlines, etc.).
  //    Rather than discarding everything, split into paragraphs and skip thinking sections;
  //    models like Gemma output their reasoning first and the actual answer after.
  const THINKING_SECTION = /^(?:Thinking\s+Process:|Thought\s+Process:|Let\s+me\s+think(?:ing)?:|Step-by-step(?:\s+analysis)?:|My\s+(?:thinking|reasoning|analysis):|Analysis:|Here(?:'s|\s+is)\s+my\s+(?:thinking|reasoning|analysis|thought)|\*\*(?:Thinking|Reasoning|Analysis)\*\*:?)/i;
  const NUMBERED_STEP = /^\d+\.\s+(?:\*\*|[A-Z])/;

  if (THINKING_SECTION.test(cleaned) || NUMBERED_STEP.test(cleaned)) {
    // Split into paragraphs; collect everything that isn't a thinking step.
    const paragraphs = cleaned.split(/\n{2,}/);
    const answerParts: string[] = [];
    let pastThinking = false;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const isThinkingPara = THINKING_SECTION.test(trimmed) || NUMBERED_STEP.test(trimmed);
      if (!pastThinking && isThinkingPara) continue;
      pastThinking = true;
      answerParts.push(trimmed);
    }

    if (answerParts.length === 0) {
      // Nothing followed the leading list. An explicitly-marked thinking block
      // ("Thinking Process:" etc.) was pure reasoning — correctly discarded.
      // But an unmarked numbered list with no trailing prose is almost always
      // the real answer (e.g. a list of review points), so keep it rather than
      // nuking a valid response to empty.
      return THINKING_SECTION.test(cleaned) ? '' : cleaned;
    }
    return answerParts.join('\n\n');
  }

  return cleaned;
}

/**
 * Robust JSON parser that handles common LLM output issues:
 * - Markdown code blocks
 * - Trailing commas
 * - Unescaped newlines in strings
 * - Partial responses
 * - Text before/after JSON
 */
export function parseJSONRobust(text: string): any {
  let cleanText = text.trim();
  
  // Extract from markdown code blocks
  const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleanText = codeBlockMatch[1].trim();
  } else if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  
  // Try direct parse first
  try {
    return JSON.parse(cleanText);
  } catch (_) {}
  
  // Fix common issues and retry
  let fixed = cleanText;
  
  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  
  // Fix unescaped newlines within string values
  fixed = fixed.replace(/"([^"]*?)"/g, (match) => {
    return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  });
  
  try {
    return JSON.parse(fixed);
  } catch (_) {}
  
  // Try to extract JSON object or array from surrounding text
  const patterns = [
    // Match outermost { ... }
    () => {
      const objStart = fixed.indexOf('{');
      const objEnd = fixed.lastIndexOf('}');
      if (objStart !== -1 && objEnd > objStart) {
        return fixed.substring(objStart, objEnd + 1);
      }
      return null;
    },
    // Match outermost [ ... ]  
    () => {
      const arrStart = fixed.indexOf('[');
      const arrEnd = fixed.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd > arrStart) {
        return fixed.substring(arrStart, arrEnd + 1);
      }
      return null;
    }
  ];
  
  for (const extract of patterns) {
    const candidate = extract();
    if (candidate) {
      // Clean trailing commas again
      const cleaned = candidate.replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(cleaned);
      } catch (_) {}
    }
  }
  
  // Last resort: try to extract individual suggestion objects
  const suggestionMatches = fixed.match(/\{[^{}]*"originalText"[^{}]*"suggestedText"[^{}]*\}/g);
  if (suggestionMatches && suggestionMatches.length > 0) {
    const parsed: any[] = [];
    for (const match of suggestionMatches) {
      try {
        const cleanMatch = match.replace(/,\s*([}\]])/g, '$1');
        parsed.push(JSON.parse(cleanMatch));
      } catch (_) {}
    }
    if (parsed.length > 0) {
      return { suggestions: parsed };
    }
  }
  
  // Log the raw response for debugging
  console.warn('Failed to parse LLM response as JSON. Raw response (first 500 chars):', text.substring(0, 500));
  throw new Error('Could not parse LLM response as JSON');
}

function getGeminiClient(settings: AISettings) {
  return new GoogleGenAI({ apiKey: settings.geminiApiKey || process.env.GEMINI_API_KEY || "" });
}

const VALID_SEVERITIES = ['critical', 'major', 'minor', 'style'];
const VALID_CATEGORIES = ['grammar', 'flow', 'research', 'clarity', 'structure', 'citation', 'evidence', 'impact', 'statistics', 'style'];

export interface AnchoredSuggestions {
  suggestions: Suggestion[];
  /** located via normalized/fuzzy matching (LLM misquoted the text) */
  salvaged: number;
  /** discarded: unlocatable quote or no-op edit */
  dropped: number;
}

/** Bracketed citation markers like [3], [1,4], [2-5]. */
const LINT_CITATION_MARKER_RE = /\[\d+(?:\s*[,;–-]\s*\d+)*\]/g;

/**
 * Deterministically enforce the house style the prompts only *ask* for, and
 * repair the mistakes small models most often make in `suggestedText`:
 *  - remove em/en dashes (replace with a comma) — a hard style rule,
 *  - re-append citation markers the model dropped from the original quote,
 *  - collapse the punctuation/whitespace artifacts those edits can leave.
 * Runs in code so it is provider-independent and free.
 */
export function lintSuggestedText(suggested: string, original: string): string {
  let out = suggested;

  // No em/en dashes. Spaced dash → comma; tight dash → comma too (usually fine).
  out = out.replace(/\s*[—–]\s*/g, ', ');
  // Clean the artifacts the replacement can create.
  out = out.replace(/,\s*,/g, ',').replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();

  // Preserve references: if the original quote carried citation markers and the
  // replacement dropped every one, re-attach them before the trailing period so
  // accepting the edit never silently deletes a citation.
  const origMarkers = original.match(LINT_CITATION_MARKER_RE) ?? [];
  const newMarkers = out.match(LINT_CITATION_MARKER_RE) ?? [];
  if (origMarkers.length > 0 && newMarkers.length === 0) {
    const markerStr = ' ' + origMarkers.join('');
    out = /[.;:!?]$/.test(out)
      ? out.slice(0, -1) + markerStr + out.slice(-1)
      : out + markerStr;
  }

  return out;
}

/**
 * Anchor raw LLM suggestion objects against the document text.
 *
 * Instead of exact indexOf (which silently discarded every suggestion the LLM
 * misquoted), this uses tiered matching (exact → normalized → fuzzy) and then
 * REWRITES originalText to the actual document text, so accept-time replacement
 * in the editor always finds its target.
 */
export function anchorSuggestions(rawArr: any[], docText: string, agent: AgentType, idPrefix: string): AnchoredSuggestions {
  const suggestions: Suggestion[] = [];
  let salvaged = 0;
  let dropped = 0;

  for (let index = 0; index < rawArr.length; index++) {
    const s = rawArr[index];
    if (!s || typeof s.originalText !== 'string' || typeof s.suggestedText !== 'string') continue;
    if (!s.originalText.trim() || !s.suggestedText.trim()) { dropped++; continue; }

    const span = findTextSpan(docText, s.originalText);
    if (!span) { dropped++; continue; }

    // Enforce house style and repair dropped citations before the no-op check,
    // so a "fix" that only swapped a curly quote or an em dash is still dropped.
    const suggestedText = lintSuggestedText(s.suggestedText.trim(), span.matchedText);
    if (!suggestedText) { dropped++; continue; }
    const normOrig = normalizeForMatch(span.matchedText).text.trim().toLowerCase();
    const normNew = normalizeForMatch(suggestedText).text.trim().toLowerCase();
    if (normOrig === normNew) { dropped++; continue; }
    if (span.method !== 'exact') salvaged++;

    suggestions.push({
      ...s,
      id: `${idPrefix}-${index}`,
      agent,
      originalText: span.matchedText,
      suggestedText,
      explanation: s.explanation || '',
      startIndex: span.start,
      endIndex: span.end,
      severity: VALID_SEVERITIES.includes(s.severity) ? s.severity : 'minor',
      category: VALID_CATEGORIES.includes(s.category) ? s.category : 'clarity',
      section: s.section || 'General',
    });
  }

  return { suggestions, salvaged, dropped };
}

/**
 * Parse H2-based sections directly from TipTap HTML output.
 * Returns sections in document order, each containing the heading title
 * and the plain-text body that follows until the next H2.
 */
export function detectH2Sections(html: string): { section: string; text: string }[] {
  const h2Re = /<h2[^>]*>(.*?)<\/h2>/gi;
  const matches = [...html.matchAll(h2Re)];
  if (matches.length === 0) return [];

  return matches.map((m, i) => {
    const title = m[1].replace(/<[^>]*>/g, '').trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? html.length) : html.length;
    const bodyText = html.slice(start, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { section: title, text: `${title}\n\n${bodyText}` };
  });
}

function detectSections(text: string): { section: string; text: string }[] {
  const sectionPatterns = [
    { name: 'Abstract', pattern: /(?:^|\n)\s*(?:abstract)\s*[:\n]/i },
    { name: 'Introduction', pattern: /(?:^|\n)\s*(?:introduction|background)\s*[:\n]/i },
    { name: 'Methods', pattern: /(?:^|\n)\s*(?:methods?|materials?\s+and\s+methods?|experimental\s+(?:procedures?|design))\s*[:\n]/i },
    { name: 'Results', pattern: /(?:^|\n)\s*(?:results?)\s*[:\n]/i },
    { name: 'Discussion', pattern: /(?:^|\n)\s*(?:discussion)\s*[:\n]/i },
    { name: 'Conclusion', pattern: /(?:^|\n)\s*(?:conclusions?|summary)\s*[:\n]/i },
    { name: 'References', pattern: /(?:^|\n)\s*(?:references?|bibliography)\s*[:\n]/i },
  ];

  const detected: { section: string; start: number }[] = [];
  for (const sp of sectionPatterns) {
    const match = text.match(sp.pattern);
    if (match && match.index !== undefined) {
      detected.push({ section: sp.name, start: match.index });
    }
  }

  if (detected.length === 0) return [{ section: 'General', text }];

  detected.sort((a, b) => a.start - b.start);
  const sections: { section: string; text: string }[] = [];
  for (let i = 0; i < detected.length; i++) {
    const end = i + 1 < detected.length ? detected[i + 1].start : text.length;
    sections.push({ section: detected[i].section, text: text.substring(detected[i].start, end) });
  }
  return sections;
}

function chunkTextForLocal(text: string, maxChunkChars: number = 2000, htmlContent?: string): string[] {
  const sections = htmlContent
    ? (detectH2Sections(htmlContent).length > 0 ? detectH2Sections(htmlContent) : detectSections(text))
    : detectSections(text);
  
  if (sections.length > 1) {
    const chunks: string[] = [];
    for (const section of sections) {
      if (section.section === 'References') continue;
      if (section.text.length <= maxChunkChars) {
        chunks.push(`[Section: ${section.section}]\n${section.text}`);
      } else {
        const paragraphs = section.text.split(/\n\n+/);
        let currentChunk = `[Section: ${section.section}]\n`;
        for (const para of paragraphs) {
          if ((currentChunk + para).length > maxChunkChars && currentChunk.length > 50) {
            chunks.push(currentChunk.trim());
            currentChunk = `[Section: ${section.section} (continued)]\n`;
          }
          currentChunk += para + '\n\n';
        }
        if (currentChunk.trim().length > 50) chunks.push(currentChunk.trim());
      }
    }
    return chunks.length > 0 ? chunks : [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    if ((current + para).length > maxChunkChars && current.length > 50) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n\n';
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

export function estimateTokens(text: string): number {
  return encode(text).length;
}

/**
 * JSON schema for a suggestions payload, used for constrained decoding on
 * providers that support it. Small local models and cloud models both emit far
 * cleaner output when the shape is enforced by the sampler rather than only
 * described in the prompt, which near-eliminates the parse-failure path.
 */
export const SUGGESTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          originalText: { type: 'string' },
          suggestedText: { type: 'string' },
          explanation: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'style'] },
          category: { type: 'string' },
        },
        required: ['originalText', 'suggestedText', 'explanation'],
      },
    },
  },
  required: ['suggestions'],
} as const;

interface LLMOptions {
  jsonMode?: boolean;
  images?: AttachedImage[];
  signal?: AbortSignal;
  maxTokens?: number;
  /** JSON schema for constrained decoding (openai/gemini/local where supported). */
  jsonSchema?: Record<string, any>;
  /** Sampling temperature; providers that reject it (Anthropic 4.7+) ignore it. */
  temperature?: number;
  /** Stop sequences to end generation early (local + openai paths). */
  stop?: string[];
}

async function callLLM(prompt: string, settings: AISettings, systemPrompt: string, jsonMode: boolean = false, images?: AttachedImage[], signal?: AbortSignal, maxTokens?: number, opts: Omit<LLMOptions, 'jsonMode' | 'images' | 'signal' | 'maxTokens'> = {}): Promise<string> {
  const { jsonSchema, temperature, stop } = opts;
  if (settings.provider === 'local') {
    return callLocalLLM(prompt, settings, systemPrompt, images, signal, maxTokens, jsonMode, jsonSchema, temperature, stop);
  } else if (settings.provider === 'anthropic') {
    return callAnthropicLLM(prompt, settings, systemPrompt, images, signal, maxTokens);
  } else if (settings.provider === 'openai') {
    const openai = getOpenAIClient(settings);
    let userContent: any = prompt;
    if (images && images.length > 0) {
      userContent = [
        ...images.map(img => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
        { type: 'text' as const, text: prompt },
      ];
    }
    const responseFormat = jsonSchema
      ? { response_format: { type: 'json_schema' as const, json_schema: { name: 'response', schema: jsonSchema, strict: false } } }
      : jsonMode
        ? { response_format: { type: 'json_object' as const } }
        : {};
    // Note: temperature is intentionally NOT forwarded to cloud providers —
    // several current models reject a non-default value with a 400 that retry
    // cannot fix. Only the local path (llama.cpp/LM Studio/Ollama) uses it.
    return withRetry(() => withSignal(openai.chat.completions.create({
      model: settings.openaiModel || DEFAULT_MODELS.openai,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: userContent }
      ],
      ...responseFormat,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(stop && stop.length ? { stop } : {}),
    }, { signal }).then(r => r.choices[0].message.content || ''), signal), signal);
  } else {
    // Gemini
    const ai = getGeminiClient(settings);
    const jsonConfig = jsonSchema
      ? { responseMimeType: 'application/json', responseJsonSchema: jsonSchema }
      : jsonMode
        ? { responseMimeType: 'application/json' }
        : {};
    const baseConfig = {
      ...jsonConfig,
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      abortSignal: signal,
    };
    if (images && images.length > 0) {
      const parts: any[] = images.map(img => ({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
      }));
      parts.push({ text: (systemPrompt ? systemPrompt + '\n\n' : '') + prompt });
      return withRetry(() => withSignal(ai.models.generateContent({
        model: settings.geminiModel || DEFAULT_MODELS.gemini,
        contents: [{ parts }],
        config: baseConfig,
      }).then(r => r.text || ''), signal), signal);
    }
    return withRetry(() => withSignal(ai.models.generateContent({
      model: settings.geminiModel || DEFAULT_MODELS.gemini,
      contents: (systemPrompt ? systemPrompt + '\n\n' : '') + prompt,
      config: baseConfig,
    }).then(r => r.text || ''), signal), signal);
  }
}


/**
 * Inline autocomplete.
 *
 * Works with any provider including small local models (4–8B).
 * The model receives the manuscript context as a user message and must
 * reply with only the continuation text. No assistant-prefill is used
 * because small instruction-tuned models respond to the user turn, not
 * to the prefilled assistant turn, producing leaked instructions instead
 * of a clean continuation.
 */
export async function generateCompletion(contextText: string, settings: AISettings, signal?: AbortSignal, heading?: string): Promise<string> {
  const docKind = documentContext.mode === 'grant' ? 'grant application' : 'scientific manuscript';
  const system =
    `You are a ${docKind} autocomplete engine. ` +
    (heading ? `The author is writing the "${heading}" section. ` : '') +
    'The user sends you the text so far. Reply with ONLY the next 1-2 sentences that naturally continue it. ' +
    'Continue the author\'s thought forward — never restate, summarize, or re-explain what they already wrote. ' +
    'Start immediately with the next word (add a leading space if the text does not end with one). ' +
    'No preamble, no analysis, no labels, no reasoning, no quotes around your answer. ' +
    'Wrong: "Sure! The next sentence is: X." Wrong: "Thinking Process: 1. ..." Right: " X."';

  const raw = await callLLM(contextText, settings, system, false, undefined, signal, 80, {
    stop: ['\n\n', '\n#'],
  });
  return raw.trim();
}

export async function resolveConflicts(suggestions: Suggestion[], _settings?: AISettings): Promise<Suggestion[]> {
  if (suggestions.length < 2) return suggestions;

  // Only drop *identical* suggestions (same span AND same replacement). Two
  // agents proposing DIFFERENT fixes for the same passage is exactly the case
  // the Judge exists to resolve, so keep both here and let the Judge choose.
  const seen = new Set<string>();
  return suggestions.filter(s => {
    const key = `${s.originalText.trim().toLowerCase()}→${s.suggestedText.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, major: 3, minor: 2, style: 1 };

/** Deterministic pick within a conflict group: severity, then most specific. */
function bestBySeverity(group: Suggestion[]): Suggestion {
  return group.reduce((a, b) => {
    const rankA = SEVERITY_RANK[a.severity || 'style'] ?? 1;
    const rankB = SEVERITY_RANK[b.severity || 'style'] ?? 1;
    if (rankA !== rankB) return rankA > rankB ? a : b;
    return a.originalText.length <= b.originalText.length ? a : b;
  });
}

/** Group suggestions into overlapping conflict clusters (exported for tests). */
export function buildConflictGroups(suggestions: Suggestion[]): Suggestion[][] {
  const groups: Suggestion[][] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < suggestions.length; i++) {
    if (assigned.has(suggestions[i].id)) continue;
    const group = [suggestions[i]];
    assigned.add(suggestions[i].id);
    const a = suggestions[i];
    for (let j = i + 1; j < suggestions.length; j++) {
      if (assigned.has(suggestions[j].id)) continue;
      const b = suggestions[j];
      const overlap =
        (a.startIndex !== undefined && b.startIndex !== undefined &&
          a.startIndex <= b.endIndex && b.startIndex <= a.endIndex) ||
        a.originalText.includes(b.originalText) ||
        b.originalText.includes(a.originalText);
      if (overlap) {
        group.push(b);
        assigned.add(b.id);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Judge agent: finds overlapping suggestions (one's originalText contains the
 * other, or their ranges overlap) and keeps the single most impactful one per
 * conflict. All conflicts are decided in ONE batched LLM call (the previous
 * version made a sequential call per group, which was slow on local models),
 * and each answer index is validated rather than blindly clamped. Falls back to
 * deterministic severity selection whenever the LLM answer is missing or bad.
 */
export async function runJudgeAgent(suggestions: Suggestion[], settings: AISettings, signal?: AbortSignal): Promise<Suggestion[]> {
  if (suggestions.length < 2) return suggestions;

  const groups = buildConflictGroups(suggestions);
  const conflicts = groups.filter(g => g.length > 1);
  const winners: Suggestion[] = groups.filter(g => g.length === 1).map(g => g[0]);

  if (conflicts.length === 0) return suggestions;

  // Default every conflict to its deterministic winner; the LLM only overrides.
  const chosen = new Map<number, Suggestion>();
  conflicts.forEach((g, gi) => chosen.set(gi, bestBySeverity(g)));

  try {
    const prompt = `Multiple AI agents flagged the same passages. For each GROUP, pick the SINGLE best suggestion to keep.

SELECTION CRITERIA (priority order): severity (critical>major>minor>style); a concrete replacement beats a vague comment; scientific value; can the author apply it exactly as written.

${conflicts.map((group, gi) => `GROUP ${gi}:
${group.map((s, i) => `  [${i}] severity=${s.severity || 'minor'} agent=${s.agent} category=${s.category || 'general'}
      ORIGINAL: "${s.originalText.substring(0, 160)}"
      REPLACE: "${s.suggestedText.substring(0, 160)}"
      REASON: ${(s.explanation || '').substring(0, 120)}`).join('\n')}`).join('\n\n')}

Return ONLY JSON mapping each group index to the chosen candidate index, e.g. {"0":1,"1":0}. No prose, no reasoning.`;

    const response = await callLLM(prompt, settings, 'You are a manuscript editor judge. Output only the JSON map of group index to chosen candidate index.', true, undefined, signal, 500);
    const parsed = parseJSONRobust(response);
    if (parsed && typeof parsed === 'object') {
      conflicts.forEach((group, gi) => {
        const raw = parsed[String(gi)] ?? parsed[gi];
        const idx = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < group.length) {
          chosen.set(gi, group[idx]);
        }
      });
    }
  } catch (_) {
    // keep the deterministic defaults
  }

  conflicts.forEach((_g, gi) => winners.push(chosen.get(gi)!));
  return winners;
}

const PROBLEMS_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { problems: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      quote: { type: 'string' }, issue: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor', 'style'] },
      category: { type: 'string' },
    }, required: ['quote', 'issue'],
  } } }, required: ['problems'],
} as const;

const FIXES_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { fixes: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: { index: { type: 'integer' }, suggestedText: { type: 'string' } },
    required: ['index', 'suggestedText'],
  } } }, required: ['fixes'],
} as const;

interface FoundProblem { quote: string; issue: string; severity?: string; category?: string }

/**
 * Find-then-fix pass 1: ask the model only to QUOTE problems (no rewriting).
 * A tiny, easy output shape that small local models handle far more reliably
 * than the compound "find + quote exactly + rewrite + emit JSON" single call.
 */
async function findProblems(chunkText: string, compactRole: string, settings: AISettings, signal?: AbortSignal): Promise<FoundProblem[]> {
  const prompt = `${compactRole}

Find the highest-impact problems in the text below. Do NOT rewrite anything yet — only quote each problem.

Text:
"""
${chunkText}
"""

Return ONLY JSON: {"problems":[{"quote":"exact verbatim span copied from the text","issue":"one short line naming the problem","severity":"critical|major|minor|style","category":"grammar|clarity|flow|structure|research|citation|evidence|statistics"}]}
Rules: quote MUST be copied character-for-character from the text above. Provide 3-6 problems. No prose outside the JSON.`;
  const raw = await callLocalLLM(prompt, settings, 'Return only valid JSON. No markdown.', undefined, signal, undefined, true, PROBLEMS_JSON_SCHEMA);
  const parsed = parseJSONRobust(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed?.problems ?? []);
  return (arr as any[])
    .filter(p => p && typeof p.quote === 'string' && p.quote.trim())
    .map(p => ({ quote: p.quote, issue: String(p.issue ?? ''), severity: p.severity, category: p.category }));
}

/**
 * Find-then-fix pass 2: hand back the (already anchored) problem passages and
 * ask only for replacements. Verifying/rewriting known-quoted spans is a much
 * easier task than locating them, so quality rises and quotes never drift.
 */
async function writeFixes(problems: FoundProblem[], compactRole: string, settings: AISettings, signal?: AbortSignal): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (problems.length === 0) return out;
  const prompt = `${compactRole}

Rewrite each flagged passage below. Preserve the scientific meaning; apply the stated fix; produce a direct drop-in replacement.
${SCIENTIFIC_WRITING_RULES}

PASSAGES:
${problems.map((p, i) => `[${i}] problem: ${p.issue}\n    text: "${p.quote}"`).join('\n')}

Return ONLY JSON: {"fixes":[{"index":0,"suggestedText":"the replacement text"}]}. One entry per passage. No prose outside the JSON.`;
  const raw = await callLocalLLM(prompt, settings, 'Return only valid JSON. No markdown.', undefined, signal, undefined, true, FIXES_JSON_SCHEMA);
  const parsed = parseJSONRobust(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed?.fixes ?? []);
  for (const f of (arr as any[])) {
    const idx = parseInt(String(f?.index), 10);
    if (Number.isInteger(idx) && typeof f?.suggestedText === 'string' && f.suggestedText.trim()) {
      out.set(idx, f.suggestedText);
    }
  }
  return out;
}

/**
 * Two-pass find-then-fix analysis of a chunk. Returns raw suggestion objects
 * (originalText/suggestedText/...) ready for anchorSuggestions, or an empty
 * array if the model found nothing or produced no usable fixes (the caller can
 * then fall back to the single-pass path).
 */
async function findThenFixChunk(chunkText: string, compactRole: string, settings: AISettings, signal?: AbortSignal): Promise<any[]> {
  const problems = await findProblems(chunkText, compactRole, settings, signal);
  if (problems.length === 0) return [];
  const fixes = await writeFixes(problems, compactRole, settings, signal);
  const raw: any[] = [];
  problems.forEach((p, i) => {
    const suggestedText = fixes.get(i);
    if (!suggestedText) return;
    raw.push({
      originalText: p.quote,
      suggestedText,
      explanation: p.issue,
      severity: p.severity,
      category: p.category,
    });
  });
  return raw;
}

/**
 * Verifier stage — the quality gate the pipeline was missing.
 *
 * Anchoring only checks that a suggestion *locates* and isn't a no-op; nothing
 * checks whether it is actually GOOD. Small models are far better at verifying
 * than generating, so one cheap batched call — "for each edit, does the
 * replacement preserve the scientific meaning and genuinely improve the text?"
 * — catches the classic failure of a "fix" that subtly changes a claim or
 * makes no real improvement. It only ever DROPS suggestions, and it fails open:
 * any error, or an unparseable answer, keeps everything.
 */
export async function verifySuggestions(
  suggestions: Suggestion[],
  settings: AISettings,
  signal?: AbortSignal,
): Promise<{ kept: Suggestion[]; dropped: number }> {
  if (suggestions.length < 2) return { kept: suggestions, dropped: 0 };

  const prompt = `You are a strict scientific editor validating proposed manuscript edits. For EACH numbered edit, decide keep or drop.

DROP an edit only if: it changes the scientific meaning or a claim, it makes no real improvement, the replacement is worse or ungrammatical, or the "reason" does not match what the edit does. When unsure, KEEP.

EDITS:
${suggestions.map((s, i) => `[${i}] (${s.category || 'general'}/${s.severity || 'minor'})
  ORIGINAL: "${s.originalText.substring(0, 200)}"
  REPLACE:  "${s.suggestedText.substring(0, 200)}"
  REASON:   ${(s.explanation || '').substring(0, 140)}`).join('\n\n')}

Return ONLY JSON: {"drop":[indices to remove]}. If none should be dropped, return {"drop":[]}. No prose.`;

  try {
    const response = await callLLM(
      prompt, settings,
      'You validate manuscript edits. Output only the JSON object of indices to drop.',
      true, undefined, signal, 500,
      { jsonSchema: { type: 'object', additionalProperties: false, properties: { drop: { type: 'array', items: { type: 'integer' } } }, required: ['drop'] } },
    );
    const parsed = parseJSONRobust(response);
    const dropIdx: unknown = Array.isArray(parsed) ? parsed : parsed?.drop;
    if (!Array.isArray(dropIdx)) return { kept: suggestions, dropped: 0 };
    const dropSet = new Set(dropIdx.map((n: any) => parseInt(String(n), 10)).filter(n => Number.isInteger(n)));
    // Safety valve: if the model wants to drop nearly everything it is probably
    // confused — keep all rather than nuke a good analysis.
    if (dropSet.size >= suggestions.length) return { kept: suggestions, dropped: 0 };
    const kept = suggestions.filter((_s, i) => !dropSet.has(i));
    return { kept, dropped: suggestions.length - kept.length };
  } catch {
    return { kept: suggestions, dropped: 0 };
  }
}

function buildFullTextPrompt(agentRole: string, text: string, existingContext: string): string {
  return `${agentRole}

Analyze this manuscript. Return ONLY valid JSON, nothing else.

Manuscript:
"""
${text}
"""
${existingContext}

Example of the EXACT JSON format to return (copy this structure precisely):
{"suggestions":[{"originalText":"It was observed by us that the cells died.","suggestedText":"We observed cell death.","explanation":"Converted passive to active voice for clarity.","severity":"minor","category":"grammar"},{"originalText":"The results were very significant and important.","suggestedText":"The results were statistically significant (p < 0.05).","explanation":"Replaced vague intensifiers with specific quantitative detail.","severity":"major","category":"clarity"}]}

Rules:
- Return ONLY the JSON object — no markdown, no preamble, no explanation outside the JSON
${EXACT_QUOTE_RULE}
- Provide 5-10 specific, high-impact suggestions covering the ENTIRE manuscript
- Cover different sections: introduction, methods, results, discussion
- severity: "critical", "major", "minor", or "style"
- category: "grammar", "flow", "research", "clarity", or "structure"`;
}

function buildLocalPrompt(agentRole: string, textChunk: string, existingContext: string): string {
  return `${agentRole}

Analyze this text. Return ONLY valid JSON, nothing else.

Text:
"""
${textChunk}
"""
${existingContext}

Example of the EXACT JSON format to return:
{"suggestions":[{"originalText":"It was observed by us that the cells died.","suggestedText":"We observed cell death.","explanation":"Converted passive to active voice.","severity":"minor","category":"grammar"}]}

Rules:
- Return ONLY the JSON object — no markdown, no explanation outside the JSON
${EXACT_QUOTE_RULE}
- Provide 3-5 specific suggestions
- severity: "critical", "major", "minor", or "style"
- category: "grammar", "flow", "research", "clarity", or "structure"`;
}

/**
 * Attempt to repair malformed JSON by asking the LLM to fix syntax errors only.
 * Used as a last-resort fallback when parseJSONRobust fails.
 */
async function repairJSONWithLLM(rawText: string, settings: AISettings): Promise<string> {
  const maxLen = 3000;
  const truncated = rawText.length > maxLen ? rawText.substring(0, maxLen) + '...' : rawText;
  const prompt = `The following text is supposed to be a JSON object but contains syntax errors (missing quotes, trailing commas, unescaped characters, truncated content, etc.). Fix ONLY the JSON syntax and return only the corrected, valid JSON. Do not change any values.\n\n${truncated}`;
  try {
    return await callLLM(prompt, settings, 'You fix broken JSON. Return ONLY the corrected JSON object, nothing else.');
  } catch {
    return rawText;
  }
}

/** Translate a raw LLM error message into a human-readable diagnosis. */
function classifyLLMError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('timed out') || msg.includes('timeout'))
    return 'Request timed out — text is too long for this model\'s context window. Reduce document size or switch to a model with a larger context.';
  if (msg.includes('context') && (msg.includes('long') || msg.includes('exceed') || msg.includes('limit') || msg.includes('length')))
    return 'Text exceeds model context window. Reduce document size or use a larger-context model.';
  if (msg.includes('unreachable') || msg.includes('could not connect') || msg.includes('connection refused') || msg.includes('econnrefused') || msg.includes('failed to fetch'))
    return 'Local LLM server not reachable. Check that the server is running and the URL is correct.';
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('forbidden'))
    return 'Authentication failed — check the API key in settings.';
  if (msg.includes('http 413') || msg.includes('payload too large') || msg.includes('request entity too large'))
    return 'Text is too long for this model\'s context window (HTTP 413).';
  if (msg.includes('http 5'))
    return `Server error — ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  // Strip boilerplate prefix and return the raw detail
  return (err instanceof Error ? err.message : String(err))
    .replace(/^Local LLM unreachable\.\s*Last error:\s*/i, '')
    .slice(0, 200);
}

export async function analyzeText(text: string, agent: AgentType, settings: AISettings, existingSuggestions: Suggestion[] = [], onProgress?: (msg: string) => void, htmlContent?: string, signal?: AbortSignal): Promise<{ suggestions: Suggestion[], status: 'ok' | 'no_suggestions' | 'parsing_failed' | 'server_error', errorMessage?: string, salvaged?: number, dropped?: number }> {
  const activePrompt = getActivePrompt(agent, settings);

  let existingContext = '';
  if (existingSuggestions.length > 0) {
    const existingTexts = existingSuggestions.map(s => s.originalText).slice(0, 10);
    existingContext = `\nAlready suggested (DO NOT repeat these): ${JSON.stringify(existingTexts)}`;
  }

  if (settings.provider === 'local') {
    // localChunkSize === 0 means no chunking — send full manuscript in one request
    const chunkSize = settings.localChunkSize;
    const useFullText = chunkSize === 0;
    const chunks = useFullText ? [text] : chunkTextForLocal(text, chunkSize ?? 2000, htmlContent);
    const allSuggestions: Suggestion[] = [];
    let parsingFailed = false;
    let rawResponses: string[] = [];
    let totalSalvaged = 0;
    let totalDropped = 0;
    
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) break;
      onProgress?.(`Chunk ${i + 1}/${chunks.length}`);
      // Chunked mode: use a complete compact prompt instead of truncating the
      // full prompt mid-sentence. User-customized prompts are kept as-is.
      const compactBase = documentContext.mode === 'grant'
        ? (GRANT_COMPACT_AGENT_PROMPTS[agent] ?? COMPACT_AGENT_PROMPTS[agent])
        : COMPACT_AGENT_PROMPTS[agent];
      const shortRole = useFullText
        ? activePrompt
        : (settings.customPrompts?.[agent] ?? (compactBase ? compactBase + grantInstructionsBlock() : activePrompt));

      // Find-then-fix (default for chunked/small-model mode): a "quote the
      // problems" pass followed by a "write the replacements" pass. Each is a
      // task a 4-8B model can actually do, versus the single compound call that
      // small models frequently botch. Falls through to the single-pass path on
      // any failure or empty result.
      if (!useFullText && settings.pipelineMode !== 'single') {
        try {
          onProgress?.(`Chunk ${i + 1}/${chunks.length} — finding problems`);
          const raw = await findThenFixChunk(chunks[i], shortRole, settings, signal);
          if (raw.length > 0) {
            const anchored = anchorSuggestions(raw, text, agent, `suggestion-${Date.now()}-${i}-ff`);
            totalSalvaged += anchored.salvaged;
            totalDropped += anchored.dropped;
            allSuggestions.push(...anchored.suggestions);
            if (anchored.suggestions.length > 0) {
              existingContext += '\n' + JSON.stringify(anchored.suggestions.map(s => s.originalText).slice(0, 5));
            }
            continue; // chunk handled
          }
        } catch (e) {
          if (signal?.aborted) break;
          // fall through to the single-pass path below
        }
      }

      const prompt = useFullText
        ? buildFullTextPrompt(shortRole, chunks[i], existingContext)
        : buildLocalPrompt(shortRole, chunks[i], existingContext);

      try {
        const textResponse = await callLocalLLM(prompt, settings, "Return only valid JSON. No markdown, no explanations.", undefined, signal, undefined, true, SUGGESTIONS_JSON_SCHEMA);
        rawResponses.push(textResponse);
        
        if (textResponse) {
          try {
            const parsed = parseJSONRobust(textResponse);
            const suggestionsArr = Array.isArray(parsed) ? parsed : (parsed.suggestions || parsed.fixes || []);
            const anchored = anchorSuggestions(suggestionsArr, text, agent, `suggestion-${Date.now()}-${i}`);
            const chunkSuggestions = anchored.suggestions;
            totalSalvaged += anchored.salvaged;
            totalDropped += anchored.dropped;

            allSuggestions.push(...chunkSuggestions);
            if (chunkSuggestions.length > 0) {
              existingContext += '\n' + JSON.stringify(chunkSuggestions.map((s: any) => s.originalText).slice(0, 5));
            }
          } catch (parseErr) {
            // Auto-repair: send broken JSON back to the LLM to fix syntax errors
            try {
              onProgress?.(`Chunk ${i + 1}/${chunks.length} — repairing JSON...`);
              const repaired = await repairJSONWithLLM(textResponse, settings);
              const parsedRepaired = parseJSONRobust(repaired);
              const arr = Array.isArray(parsedRepaired) ? parsedRepaired : (parsedRepaired.suggestions || parsedRepaired.fixes || []);
              const anchoredRepair = anchorSuggestions(arr, text, agent, `suggestion-${Date.now()}-${i}-r`);
              totalSalvaged += anchoredRepair.salvaged;
              totalDropped += anchoredRepair.dropped;
              allSuggestions.push(...anchoredRepair.suggestions);
              if (anchoredRepair.suggestions.length === 0) parsingFailed = true;
            } catch {
              console.error(`Chunk ${i + 1} parse+repair error. Raw:`, textResponse.substring(0, 300));
              parsingFailed = true;
            }
          }
        }
      } catch (e) {
        console.error(`Failed to analyze chunk ${i + 1}:`, e);
        parsingFailed = true;
      }
    }
    
    if (allSuggestions.length === 0 && parsingFailed) {
      console.warn('All chunks failed to parse. Last raw responses:', rawResponses.slice(-2));
    }
    
    return {
      suggestions: allSuggestions,
      status: allSuggestions.length > 0 ? 'ok' : (parsingFailed ? 'parsing_failed' : 'no_suggestions'),
      salvaged: totalSalvaged,
      dropped: totalDropped,
    };
  }

  // Cloud provider path
  const sections = detectSections(text);
  const sectionContext = sections.length > 1 
    ? `\nDetected sections: ${sections.map(s => s.section).join(', ')}. Tag each suggestion with its section.`
    : '';

  // The agent role goes in the SYSTEM prompt only. The previous version also
  // prepended it to the user prompt, sending the full persona twice per call —
  // wasted tokens and diluted instructions.
  const prompt = `Analyze this manuscript text and provide specific, actionable suggestions.

Text:
"""
${text}
"""
${sectionContext}${existingContext}

Return a JSON object: {"suggestions": [...]}
Each suggestion must have:
- originalText: EXACT quote from the text
- suggestedText: the improved replacement text
- explanation: specific reason for the change
- severity: "critical" | "major" | "minor" | "style"
- category: "grammar" | "flow" | "research" | "clarity" | "structure"
- section: which manuscript section

Provide 8-15 highly specific suggestions.
${EXACT_QUOTE_RULE}`;

  try {
    // 8192 output tokens: a 10-15 suggestion JSON payload does not fit in 4096.
    // Constrained decoding (json_schema) keeps the shape valid on every provider
    // that supports it, sharply reducing parse failures.
    let textResponse = await callLLM(prompt, settings, activePrompt, true, undefined, signal, 8192, { jsonSchema: SUGGESTIONS_JSON_SCHEMA });
    if (!textResponse) return { suggestions: [], status: 'no_suggestions' };

    const parsed = parseJSONRobust(textResponse);
    const suggestionsArr = Array.isArray(parsed) ? parsed : (parsed.suggestions || []);
    const anchored = anchorSuggestions(suggestionsArr, text, agent, `suggestion-${Date.now()}`);

    return {
      suggestions: anchored.suggestions,
      status: anchored.suggestions.length > 0 ? 'ok' : 'no_suggestions',
      salvaged: anchored.salvaged,
      dropped: anchored.dropped,
    };
  } catch (e) {
    // Propagate user cancellation immediately
    if ((e as any)?.name === 'AbortError') throw e;

    const errMsg = e instanceof Error ? e.message : String(e);
    // Server/connectivity errors: JSON repair is pointless, surface the real reason
    const isServerError = errMsg.includes('unreachable') || errMsg.includes('timed out') ||
      errMsg.includes('context') || errMsg.includes('HTTP 4') || errMsg.includes('HTTP 5') ||
      errMsg.includes('connection') || errMsg.includes('fetch');
    if (isServerError) {
      console.error(`Server error for agent ${agent}:`, errMsg);
      return { suggestions: [], status: 'server_error', errorMessage: classifyLLMError(e) };
    }

    // Last-resort: try repairing malformed JSON via LLM
    try {
      const textResponse = await callLLM(prompt, settings, activePrompt, true, undefined, undefined, 8192);
      const repaired = await repairJSONWithLLM(textResponse, settings);
      const parsed = parseJSONRobust(repaired);
      const arr = Array.isArray(parsed) ? parsed : (parsed.suggestions || []);
      const anchored = anchorSuggestions(arr, text, agent, `suggestion-${Date.now()}-repair`);
      return {
        suggestions: anchored.suggestions,
        status: anchored.suggestions.length > 0 ? 'ok' : 'no_suggestions',
        salvaged: anchored.salvaged,
        dropped: anchored.dropped,
      };
    } catch {
      console.error(`Failed to parse suggestions for ${agent}:`, e);
      return { suggestions: [], status: 'parsing_failed' };
    }
  }
}

// Intent categories for chat messages
type ChatIntent = 'command' | 'analysis_request' | 'info_question';

function detectChatIntent(message: string): ChatIntent {
  const lower = message.toLowerCase();
  // Direct execution commands: user wants text produced/transformed
  const commandPatterns = /\b(rewrite|write|draft|create|expand|rephrase|generate|produce|compose|restructure|revise|convert|transform|make it|turn this into)\b/;
  // Analysis/improvement requests: user wants assessment + specific fixes
  const analysisPatterns = /\b(improve|how (can|do|should|to)|what('s| is) wrong|review|analyze|analyse|evaluate|assess|critique|strengthen|fix|suggest|give me feedback|what should|how would|check|identify|find)\b/;
  // Pure information questions: user wants explanation, not edits
  const infoPatterns = /\b(what (does|is|are|means?)|explain|define|tell me about|describe|what happened|why did)\b/;

  if (commandPatterns.test(lower)) return 'command';
  if (infoPatterns.test(lower) && !analysisPatterns.test(lower)) return 'info_question';
  return 'analysis_request'; // default — most research questions want analysis
}

export async function chatWithAgent(
  message: string,
  context: string,
  agent: AgentType,
  settings: AISettings,
  attachedSources?: Array<{ name: string; text: string }>,
  images?: AttachedImage[],
  signal?: AbortSignal,
  tools?: AgentTool[],
  onToolUse?: (name: string) => void
): Promise<{ text: string; suggestions?: Suggestion[] }> {
  const activePrompt = getActivePrompt(agent, settings);
  const isLocal = settings.provider === 'local';
  const localLargeContext = isLocal && settings.localChunkSize === 0;

  // Context budget: cloud models have large context windows; use them fully.
  // Local large-context mode (no chunking): allow up to 50k chars.
  // Local small-context: conservative limit.
  const maxContextChars = localLargeContext ? 50000 : isLocal ? 5000 : 40000;

  // Build context block
  let contextBlock: string;
  let referenceContext = context; // used for suggestion position lookup
  if (attachedSources && attachedSources.length > 0) {
    const perSourceBudget = Math.floor(maxContextChars / attachedSources.length);
    contextBlock = attachedSources.map(src =>
      `=== ${src.name} ===\n${truncateText(src.text, perSourceBudget)}`
    ).join('\n\n');
    if (attachedSources.length === 1) referenceContext = attachedSources[0].text;
  } else {
    contextBlock = truncateText(context, maxContextChars);
  }

  const intent = detectChatIntent(message);

  let taskInstruction: string;
  if (intent === 'command') {
    taskInstruction = `The researcher issued a direct command: execute it. Produce the requested text directly. Do NOT explain or critique — just do what was asked. If you produce a replacement for existing manuscript text, include it as a suggestion so the researcher can accept it.`;
  } else if (intent === 'analysis_request') {
    taskInstruction = `The researcher is requesting analysis or improvements. Read the FULL manuscript context provided, identify the relevant section(s), and:
1. Give a concise, specific answer focused on the section/aspect they asked about.
2. Back up your assessment with concrete examples from the text.
3. ALWAYS include specific text suggestions (originalText → suggestedText) for every problem you identify — do not describe problems without proposing fixes.
4. Aim for 3–8 targeted suggestions from the relevant section.`;
  } else {
    // info_question
    taskInstruction = `The researcher is asking an informational question. Answer clearly and concisely. No suggestions needed unless specific text edits would directly answer the question.`;
  }

  const prompt = `${taskInstruction}

Researcher: "${message}"

Manuscript / Context:
"""
${contextBlock}
"""

${intent !== 'info_question' ? `After your response, append any text edit suggestions in this exact format:
[SUGGESTIONS_START]
[
  {"originalText": "exact verbatim quote from the text above", "suggestedText": "improved replacement", "explanation": "specific reason", "severity": "critical|major|minor|style", "category": "grammar|clarity|flow|structure|research"}
]
[SUGGESTIONS_END]` : 'Reply in plain text only — no suggestions block needed.'}`;

  // Tool loop only for text-only chats (images bypass it — vision + tool
  // protocol confuses small models)
  let textResponse = (tools && tools.length > 0 && (!images || images.length === 0))
    ? await runWithTools(prompt, activePrompt, tools, settings, signal, onToolUse)
    : await callLLM(prompt, settings, activePrompt, false, images, signal);
  if (!textResponse) textResponse = '';

  const suggestionsMatch = textResponse.match(/\[SUGGESTIONS_START\]([\s\S]*?)\[SUGGESTIONS_END\]/);
  let suggestions: Suggestion[] = [];
  let cleanText = textResponse;

  if (suggestionsMatch) {
    try {
      const parsed = parseJSONRobust(suggestionsMatch[1].trim());
      const arr = Array.isArray(parsed) ? parsed : (parsed.suggestions || []);
      suggestions = anchorSuggestions(arr, referenceContext, agent, `suggestion-chat-${Date.now()}`).suggestions;
      cleanText = textResponse.replace(/\[SUGGESTIONS_START\][\s\S]*?\[SUGGESTIONS_END\]/, '').trim();
    } catch (e) {
      console.error('Failed to parse chat suggestions:', e);
    }
  }

  return { text: cleanText, suggestions };
}

export async function chatWithManuscript(
  message: string,
  context: string,
  settings: AISettings,
  attachedSources?: Array<{ name: string; text: string }>,
  images?: AttachedImage[],
  signal?: AbortSignal
): Promise<{ text: string }> {
  const isLocal = settings.provider === 'local';
  const localLargeContext = isLocal && settings.localChunkSize === 0;
  const maxContextChars = localLargeContext ? 50000 : isLocal ? 6000 : 40000;

  let contextBlock: string;
  if (attachedSources && attachedSources.length > 0) {
    const perSourceBudget = Math.floor(maxContextChars / attachedSources.length);
    contextBlock = attachedSources.map(src =>
      `=== ${src.name} ===\n${truncateText(src.text, perSourceBudget)}`
    ).join('\n\n');
  } else {
    contextBlock = truncateText(context, maxContextChars);
  }

  const prompt = `Manuscript / Context:
"""
${contextBlock}
"""

Researcher: "${message}"

Respond as a knowledgeable academic peer. Be specific, critical, and grounded in the text above.`;

  const text = await callLLM(prompt, settings, MANUSCRIPT_AI_SYSTEM_PROMPT, false, images, signal);
  return { text: text || 'No response generated.' };
}

export async function rebutSuggestion(suggestion: Suggestion, feedback: string, fullText: string, settings: AISettings): Promise<Suggestion[]> {
  const activePrompt = getActivePrompt(suggestion.agent, settings);
  
  const prompt = `The researcher disagreed with your suggestion.
Original text: "${suggestion.originalText}"
Your proposed change: "${suggestion.suggestedText}"
Your reasoning: "${suggestion.explanation}"

Researcher's feedback: "${feedback}"

Reconsider and provide a refined suggestion. Return ONLY JSON:
{"suggestions": [{"originalText": "${suggestion.originalText}", "suggestedText": "...", "explanation": "...", "severity": "${suggestion.severity || 'minor'}", "category": "${suggestion.category || 'grammar'}"}]}`;

  let textResponse = await callLLM(prompt, settings, activePrompt + "\nReturn exactly 1 refined suggestion as JSON.", true);
  if (!textResponse) textResponse = '{"suggestions":[]}';
  
  try {
    const data = parseJSONRobust(textResponse);
    const suggestionsArr = Array.isArray(data) ? data : (data?.suggestions || []);
    if (suggestionsArr && suggestionsArr.length > 0) {
      const newSug = suggestionsArr[0];
      newSug.id = `${Date.now()}`;
      newSug.agent = suggestion.agent;
      newSug.startIndex = suggestion.startIndex;
      newSug.endIndex = suggestion.endIndex;
      newSug.originalText = suggestion.originalText;
      return [newSug];
    }
  } catch (e) {
    console.error("Failed to parse rebuttal:", e);
  }
  return [];
}

/**
 * Mock NIH study section: three reviewer personas critique the application
 * independently (in parallel), then an SRO reconciles them into a panel
 * summary. Divergent critiques are the whole value — an applicant learns which
 * objections are consensus and which are one reviewer's hobbyhorse.
 * Falls back to a single-reviewer critique if the multi-call flow fails.
 */
export async function runStudySectionPanel(text: string, settings: AISettings, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<string> {
  const reviewPrompt = `Please review this grant application:\n\n"""\n${text}\n"""\n\nProvide your critique as your persona instructs. Be specific and quote the application.`;
  try {
    onProgress?.('Convening 3 reviewers…');
    const critiques = await Promise.all(
      STUDY_SECTION_PERSONAS.map(p =>
        callLLM(reviewPrompt, settings, p.prompt + grantInstructionsBlock(), false, undefined, signal)
          .then(r => `### ${p.name}\n${r || '(no critique returned)'}`)
      )
    );
    onProgress?.('Reconciling into panel summary…');
    const reconcilePrompt = `Three reviewers critiqued one NIH application. Reconcile them.\n\n${critiques.join('\n\n')}\n\nProduce the resolved panel summary as instructed.`;
    const summary = await callLLM(reconcilePrompt, settings, SRO_RECONCILE_PROMPT + grantInstructionsBlock(), false, undefined, signal);
    return `${summary}\n\n---\n\n## Individual Reviews\n\n${critiques.join('\n\n')}`;
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    // Fall back to a single study-section critique.
    const response = await callLLM(reviewPrompt, settings, STUDY_SECTION_REVIEW_PROMPT + grantInstructionsBlock(), false, undefined, signal);
    return response || 'No review generated. Check your LLM connection.';
  }
}

export async function manuscriptSummary(text: string, settings: AISettings, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<string> {
  // Grant mode: a mock study-section panel instead of a journal review
  if (documentContext.mode === 'grant') {
    try {
      return await runStudySectionPanel(text, settings, onProgress, signal);
    } catch (error) {
      if ((error as any)?.name === 'AbortError') throw error;
      throw new Error(`Failed to generate study-section review: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  const systemPrompt = `You are a senior academic peer reviewer. Provide a comprehensive, high-level review of this manuscript.

Your review should be structured as follows:

## Summary
A 2-3 sentence description of what this manuscript is about, its research question, and approach.

## Strengths
List 3-5 genuine strengths of the manuscript as bullet points.

## Key Weaknesses & Gaps
List the 3-5 most significant weaknesses that need to be addressed. Be specific and constructive.
Focus on:
- Logical gaps in the argumentation
- Missing elements (methodology details, context, limitations discussion)
- Structural issues
- Unclear or unsupported claims
- Issues with the narrative flow

## Overall Assessment
A brief paragraph on where this manuscript stands and what it would take to make it publication-ready.

## Priority Recommendations
A numbered list of 3-5 concrete actions the author should take, ordered by importance.

Be direct, specific, and constructive — like a helpful Reviewer 2 who wants the paper to succeed.`;

  const prompt = `Please review this complete manuscript:

"""
${text}
"""

Provide your structured review as described in your instructions.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || 'No review generated. Check your LLM connection.';
  } catch (error) {
    throw new Error(`Failed to generate manuscript summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getThesaurus(word: string, settings: AISettings): Promise<string[]> {
  // Use Datamuse API for fast, free synonym lookup without token cost
  try {
    const response = await fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(word)}&max=10`);
    if (response.ok) {
      const data = await response.json();
      if (data.length > 0) return data.map((d: any) => d.word);
    }
  } catch (_) {}

  // Fallback to LLM
  const prompt = `List 8 synonyms for the word "${word}" as used in academic writing. Return ONLY a JSON array of strings, e.g. ["word1","word2"]. No explanation.`;
  try {
    const response = await callLLM(prompt, settings, 'You are a thesaurus. Return only JSON arrays.', true);
    const parsed = parseJSONRobust(response);
    if (Array.isArray(parsed)) return parsed.slice(0, 8);
  } catch (_) {}
  return [];
}

export async function digestSourceForManuscript(sourceText: string, sourceName: string, manuscriptText: string, settings: AISettings): Promise<string> {
  const isLocal = settings.provider === 'local';
  const truncatedSource = truncateText(sourceText, isLocal ? 3000 : 8000);
  const truncatedManuscript = truncateText(manuscriptText, isLocal ? 1000 : 2000);

  const systemPrompt = `You are a research assistant helping a scientist evaluate reference materials for their manuscript.
Given a source document and the current manuscript, produce a structured digest that helps the author decide how to cite or build upon this work.
Be concise (max 350 words total). Use the exact section headers below.`;

  const prompt = `Manuscript (for context):
"""
${truncatedManuscript}
"""

Source document "${sourceName}":
"""
${truncatedSource}
"""

Provide a structured digest with these sections:
**Research Objective:** (1–2 sentences) What question or problem does this work address?
**Key Findings:** (2–4 bullet points) Main results, discoveries, or conclusions.
**Methods/Approach:** (1–2 sentences) How was it done (study design, model, technique)?
**Relevance to Your Manuscript:** (2–3 bullet points) Specific ways this source supports, extends, or contrasts with the current manuscript — cite what the author could use.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || sourceText.substring(0, 500) + '...';
  } catch (_) {
    return sourceText.substring(0, 500) + '...';
  }
}

/** Digest an API/abstract source without manuscript context — avoids the LLM over-focusing on the current manuscript. */
export async function digestApiSource(sourceText: string, sourceName: string, settings: AISettings): Promise<string> {
  const isLocal = settings.provider === 'local';
  const truncatedSource = truncateText(sourceText, isLocal ? 3000 : 6000);

  const systemPrompt = `You are a research assistant producing structured digests of scientific papers.
Given an abstract or paper excerpt, extract the key information in a concise, structured format.
Be factual and specific. Max 300 words total.
Do NOT output a thinking process or reasoning steps. Start your response immediately.`;

  const prompt = `Paper: "${sourceName}"

"""
${truncatedSource}
"""

Provide a structured digest:
**Research Objective:** (1–2 sentences) What question or problem does this work address?
**Key Findings:** (2–4 bullet points) Main results, discoveries, or conclusions.
**Methods/Approach:** (1 sentence) Study design, model organism, or technique used.
**Significance:** (1–2 sentences) Why this finding matters or what it advances in the field.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || sourceText.substring(0, 500) + '...';
  } catch (_) {
    return sourceText.substring(0, 500) + '...';
  }
}

export async function extractPdfAbstract(sourceText: string, sourceName: string, settings: AISettings): Promise<string> {


  const isLocal = settings.provider === 'local';
  // Abstract is always near the top of a paper; the first portion is enough.
  const excerpt = truncateText(sourceText, isLocal ? 3000 : 6000);

  const systemPrompt = `You are a research assistant extracting or writing the abstract for a scientific paper.

Your task, in order of preference:
1. If the text contains an abstract (it may appear right after the title and authors without any heading), extract and return it, correcting OCR artefacts such as run-together words, broken hyphens, and extra spaces.
2. If no abstract is present, write one in 3–5 sentences based on the paper's content: state the research question, the approach, the key findings, and the significance.
3. Only if the text is completely unintelligible or contains no scientific content at all, return exactly: Abstract not available.

Style rules — apply to both extracted and generated abstracts:
- Plain continuous prose. No bullet points, no numbered lists.
- No meta-commentary ("This paper investigates…" is fine; "The abstract is as follows:" is not).
- Academic register, concise, no filler phrases.
- Return ONLY the abstract text. Nothing else.
- Do NOT output a thinking process, reasoning steps, or numbered analysis before the answer.`;

  const prompt = `Paper: "${sourceName}"

Text (beginning of document):
"""
${excerpt}
"""

Return the abstract.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false, undefined, undefined, 600);
    return response?.trim() || 'Abstract not available.';
  } catch (_) {
    return 'Abstract not available.';
  }
}

// ─── Abstract Extraction Agent (AEA) ─────────────────────────────────────────

/**
 * Two-stage abstract extraction:
 * 1. Heuristic: regex scan of the first 4000 chars for an abstract section heading.
 *    If found, isolate that paragraph to give the LLM a clean, focused excerpt.
 * 2. LLM: clean and normalise the candidate (or fall back to full first-3000 chars).
 */
export async function extractPdfAbstractAea(
  sourceText: string,
  sourceName: string,
  settings: AISettings
): Promise<string> {
  if (!sourceText || sourceText.trim().length < 20) {
    return 'PDF text could not be extracted. Try re-uploading the file.';
  }

  const isLocal = settings.provider === 'local';
  const scanRegion = sourceText.slice(0, 4000);
  const titleRegion = sourceText.slice(0, 300);

  // Stage 1 — heuristic isolation
  // Matches OCR artifacts like "A b s t r a c t", "ABSTRACT", "Abstract.", etc.
  const abstractHeadingRe = /\b(A[\s\-]?B[\s\-]?S[\s\-]?T[\s\-]?R[\s\-]?A[\s\-]?C[\s\-]?T|abstract)\b/i;
  const nextSectionRe = /\n\s*(introduction|background|keywords?|methods?|materials?|results?|discussion|conclusion|1[.\s]|2[.\s])/i;

  let heuristicCandidate: string | null = null;

  const headingMatch = abstractHeadingRe.exec(scanRegion);
  if (headingMatch) {
    const afterHeading = scanRegion.slice(headingMatch.index + headingMatch[0].length);
    const nextMatch = nextSectionRe.exec(afterHeading);
    const rawCandidate = nextMatch
      ? afterHeading.slice(0, nextMatch.index).trim()
      : afterHeading.slice(0, 1500).trim();
    if (rawCandidate.length > 50) {
      heuristicCandidate = rawCandidate;
    }
  }

  // Stage 2 — LLM clean and normalise
  const systemPrompt = `You are given a raw OCR extract from a scientific paper.
Your ONLY task: return the abstract as clean continuous prose.

Rules (strictly follow all):
- If given an abstract candidate, clean it: fix OCR artifacts, join broken words, remove line noise, correct spacing.
- If given full paper text with no clear abstract, write one in 3–5 sentences covering: research question, approach, key findings, significance.
- Do NOT summarise beyond what the text explicitly supports. Do NOT invent findings.
- Plain continuous prose only. No bullet points, no numbered lists, no headings.
- No meta-commentary. Do not write "The abstract is:" or "This paper presents:".
- Academic register, concise, no filler phrases.
- Return ONLY the abstract text. Nothing else.
- If the text is completely unintelligible, return exactly: Abstract not available.
- Do NOT output a thinking process, reasoning steps, or numbered analysis. Start with the abstract immediately.`;

  let prompt: string;
  if (heuristicCandidate) {
    const maxInput = isLocal ? 1500 : 2000;
    prompt = `Paper: "${sourceName}"
Title region: "${titleRegion.trim()}"

Abstract candidate (from OCR):
"""
${heuristicCandidate.slice(0, maxInput)}
"""

Clean and return the abstract.`;
  } else {
    const maxInput = isLocal ? 2000 : 3000;
    prompt = `Paper: "${sourceName}"

Text (beginning of document — no clear abstract heading found):
"""
${scanRegion.slice(0, maxInput)}
"""

Extract or write the abstract.`;
  }

  try {
    // Give thinking models extra headroom: they consume tokens for reasoning before answering.
    const tokenBudget = isLocal ? 1200 : 600;
    const response = await callLLM(prompt, settings, systemPrompt, false, undefined, undefined, tokenBudget);
    const trimmed = response?.trim() || '';
    // Reject if the LLM still leaked thinking output despite our stripping (extra safety net).
    const looksLikeThinking = /^(Thinking\s+Process:|Thought\s+Process:|1\.\s+\*\*)/i.test(trimmed);
    if (trimmed && !looksLikeThinking) return trimmed;
  } catch (_) {}

  // LLM failed or returned only reasoning — fall back to the heuristic candidate (if any),
  // then to a plain excerpt from the beginning of the document as a last resort for search.
  if (heuristicCandidate) return heuristicCandidate.slice(0, 800).trim();
  const plainExcerpt = scanRegion.replace(/\s+/g, ' ').trim().slice(0, 500);
  return plainExcerpt.length > 50 ? plainExcerpt : 'Abstract not available.';
}

// ─── PDF→Database Scoring Agent ──────────────────────────────────────────────

export interface PdfMatchScore {
  index: number;   // 0-based index into the candidates array passed in
  score: number;   // 0–100
  reason: string;  // ≤15 words
}

/**
 * Score a list of SemanticSearchResult candidates against a PDF source.
 *
 * Step 1 — lightweight heuristic pre-score (title word overlap + year match).
 *           Keeps the top 5 candidates for the LLM step.
 * Step 2 — single LLM call returns JSON scores for the top 5.
 *
 * Returns an array of PdfMatchScore sorted by score descending, aligned to the
 * original candidates array by index.  Falls back to heuristic order on any error.
 */
export async function scorePdfMatches(
  pdfName: string,
  abstractOrDigest: string,
  candidates: Array<{ title: string; authors: string; journal: string; year?: number | null; abstract?: string }>,
  settings: AISettings
): Promise<PdfMatchScore[]> {
  if (!candidates.length) return [];

  // ── Heuristic pre-score ───────────────────────────────────────────────────
  const stopWords = new Set(['a','an','the','of','in','on','at','to','for','and','or','with','by','from','is','are','was','were','that','this','these','those']);

  function tokenise(s: string): Set<string> {
    return new Set(
      s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
    );
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    const intersection = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersection / union;
  }

  // Extract year from PDF filename (first 4-digit year found)
  const yearInName = pdfName.match(/\b(19|20)\d{2}\b/)?.[0];
  const nameYearNum = yearInName ? parseInt(yearInName, 10) : null;

  const nameTokens = tokenise(pdfName.replace(/\.\w+$/, ''));

  const heuristicScored = candidates.map((c, idx) => {
    const titleTokens = tokenise(c.title);
    const titleOverlap = jaccard(nameTokens, titleTokens) * 0.6;
    const yearBoost = nameYearNum && c.year === nameYearNum ? 0.3 : 0;
    const lengthBonus = (c.journal || c.abstract) ? 0.1 : 0;
    return { idx, score: titleOverlap + yearBoost + lengthBonus };
  });

  heuristicScored.sort((a, b) => b.score - a.score);
  const top5 = heuristicScored.slice(0, 5);

  // ── LLM scoring ──────────────────────────────────────────────────────────
  const systemPrompt = `You are a research paper matching assistant.
Given a PDF description and up to 5 database candidates, score each 0–100 for how likely it is the same paper.
Consider: topic, methodology, findings, year, author/journal signals.
Return ONLY valid JSON array: [{"index":1,"score":85,"reason":"brief reason max 15 words"},...]
Include all candidates provided. Higher score = better match.`;

  const candidateLines = top5.map(({ idx }, rank) => {
    const c = candidates[idx];
    const excerptRaw = (c as any).abstract ?? '';
    const excerpt = excerptRaw ? ` "${excerptRaw.slice(0, 150)}"` : '';
    return `[${rank + 1}] ${c.title} | ${c.authors.slice(0, 60)} | ${c.journal} ${c.year ?? ''}${excerpt}`;
  }).join('\n');

  const prompt = `PDF filename: "${pdfName}"
Abstract/summary: "${abstractOrDigest.slice(0, 500)}"

Candidates:
${candidateLines}

Return JSON scores for all ${top5.length} candidates (use the [N] number as the "index" value).`;

  try {
    const raw = await callLLM(prompt, settings, systemPrompt, false, undefined, undefined, 300);
    if (!raw) throw new Error('empty');

    // Extract JSON array from response (LLM may wrap it in markdown)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('no json');

    const parsed: Array<{ index: number; score: number; reason: string }> = JSON.parse(jsonMatch[0]);

    // Map back from 1-based [N] rank to original candidate index
    return parsed
      .map(item => ({
        index: top5[item.index - 1]?.idx ?? item.index - 1,
        score: Math.min(100, Math.max(0, item.score)),
        reason: item.reason ?? '',
      }))
      .sort((a, b) => b.score - a.score);
  } catch (_) {
    // Fallback: heuristic order, no scores shown (score = -1 signals no LLM score)
    return top5.map(({ idx }) => ({ index: idx, score: -1, reason: '' }));
  }
}

export async function rewriteSection(sectionText: string, manuscriptContext: string, settings: AISettings): Promise<string> {
  const truncatedContext = truncateText(manuscriptContext, settings.provider === 'local' ? 800 : 2000);

  const systemPrompt = `You are an expert academic editor specializing in NIH-style scientific manuscripts. Rewrite the provided section to maximize clarity and scientific rigor while preserving all findings and meaning.

Writing requirements:
- Use simple, clear, professional scientific English appropriate for peer-reviewed journals and NIH applications.
- Do NOT use em dashes (—) or en dashes (–). Use commas, semicolons, or rewrite affected sentences.
- Do NOT use rhetorical questions, exclamations, or filler phrases ("Indeed,", "Notably,", "Of note,", "It is worth mentioning that").
- Use a natural mix of active and passive voice: active in Methods and Results where the agent is clear; passive is acceptable when the subject is unknown or unimportant.
- Keep sentences under 35 words. One idea per sentence.
- Avoid vague intensifiers ("very", "quite", "extremely"). Use precise, field-standard terminology.
- Do not start sentences with conjunctions ("But", "And", "So") in formal scientific prose.
Return ONLY the rewritten text, no commentary.${grantModeNote()}${grantInstructionsBlock()}`;

  const prompt = `Manuscript context (surrounding text):
"""
${truncatedContext}
"""

Section to rewrite:
"""
${sectionText}
"""

Provide a complete rewrite of the section above.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || sectionText;
  } catch (_) {
    return sectionText;
  }
}

export async function transformWithInstruction(
  selectedText: string,
  instruction: string,
  manuscriptContext: string,
  settings: AISettings
): Promise<string> {
  const truncatedContext = truncateText(manuscriptContext, settings.provider === 'local' ? 600 : 1500);

  const systemPrompt = `You are an expert academic writing assistant specializing in scientific manuscripts. Transform the provided text according to the instruction. Preserve all key scientific information and claims.

Writing requirements for the output:
- Simple, clear, professional scientific English. NIH-compliant style.
- Do NOT use em dashes (—) or en dashes (–).
- Do NOT use rhetorical questions, exclamations, or conversational filler ("Indeed,", "Notably,", "Of note,").
- Mix of active and passive voice appropriate to the section context.
- Sentences under 35 words. Precise, field-standard terminology.
Return ONLY the transformed text, no commentary, no quotation marks around the output.${grantModeNote()}${grantInstructionsBlock()}`;

  const prompt = `Instruction: ${instruction}

Manuscript context (for reference only):
"""
${truncatedContext}
"""

Text to transform:
"""
${selectedText}
"""

Apply the instruction to the text above. Return ONLY the transformed text.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    // Strip any quotes or markdown the LLM might add
    return response.trim().replace(/^["'`]+|["'`]+$/g, '').trim() || selectedText;
  } catch (_) {
    return selectedText;
  }
}

export async function analyzeSourceAgainstManuscript(
  sourceText: string,
  sourceName: string,
  manuscriptText: string,
  settings: AISettings
): Promise<string> {
  const isLocal = settings.provider === 'local';
  const truncatedSource = truncateText(sourceText, isLocal ? 4000 : 12000);
  const truncatedManuscript = truncateText(manuscriptText, isLocal ? 3000 : 8000);

  const systemPrompt = DEFAULT_AGENT_PROMPTS['literature-reviewer'];

  const prompt = `## Your manuscript (work-in-progress):
"""
${truncatedManuscript}
"""

## Reference paper "${sourceName}":
"""
${truncatedSource}
"""

Analyze the scientific relationship between these two manuscripts. Focus on how the reference paper can inform, support, complement, or nuance the current manuscript. Identify methodological connections, supporting evidence, differing findings (and why they might differ), and how the author should engage with this reference.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || 'No analysis generated. Check your LLM connection.';
  } catch (error) {
    throw new Error(`Literature analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Lightweight RAG: ask the LLM whether uploaded reference sources support a highlighted claim.
 * Prefers AI-digested summaries over raw full-text to keep prompts short.
 */
export async function verifyClaimAgainstSources(
  claim: string,
  sources: Array<{ name: string; text: string; digest?: string }>,
  settings: AISettings
): Promise<string> {
  const isLocal = settings.provider === 'local';
  const maxChars = isLocal ? 5000 : 30000;

  const sourceContext = sources.length > 0
    ? sources.map((s) => {
        const content = s.digest
          ? truncateText(s.digest, Math.floor(maxChars / sources.length))
          : truncateText(s.text, Math.floor(maxChars / sources.length));
        return `=== ${s.name} ===\n${content}`;
      }).join('\n\n')
    : 'No reference sources uploaded.';

  const systemPrompt = `You are a scientific fact-checker. Assess whether uploaded reference sources support, contradict, or fail to address a specific manuscript claim. Be precise, quote relevant evidence, and keep your response under 250 words.`;

  const prompt = `Claim from manuscript:
"${claim}"

Reference sources:
"""
${truncateText(sourceContext, maxChars)}
"""

Does the evidence in these sources SUPPORT, CONTRADICT, or remain SILENT on this claim?
1. State your verdict clearly in the first sentence.
2. Quote the most relevant passage from the sources.
3. Note any important caveats, methodological differences, or scope limitations.
If no sources are provided, say so and suggest the author consult the relevant literature.`;

  try {
    return await callLLM(prompt, settings, systemPrompt);
  } catch (e) {
    throw new Error(`Claim verification failed: ${e instanceof Error ? e.message : 'Unknown'}`);
  }
}

export async function generatePostDraftingContent(text: string, type: 'cover_letter' | 'rebuttal' | 'resubmission', settings: AISettings, reviewerComments?: string): Promise<string> {
  const systemPrompt = type === 'cover_letter'
    ? POST_DRAFTING_PROMPTS.COVER_LETTER_AGENT
    : type === 'resubmission'
      ? POST_DRAFTING_PROMPTS.RESUBMISSION_AGENT
      : POST_DRAFTING_PROMPTS.REBUTTAL_AGENT;

  const commentsBlock = reviewerComments?.trim()
    ? `\n\nReviewer comments / summary statement to respond to:\n"""\n${reviewerComments.trim()}\n"""`
    : '';
  const prompt = `Here is the manuscript/application text:\n\n"""\n${text}\n"""${commentsBlock}\n\nPlease generate the requested document based on your instructions.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || 'No content generated. Check your LLM connection.';
  } catch (error) {
    throw new Error(`Failed to generate content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Generate a grant template from a natural-language description or pasted FOA
 * text. Returns a raw object for grantTemplates.normalizeTemplate() to validate.
 */
export async function generateGrantTemplate(description: string, settings: AISettings): Promise<any> {
  const systemPrompt = `You design grant application templates. Given a funding-opportunity description, output the section structure an applicant must write.
Return ONLY valid JSON, exactly this shape:
{"name":"short template name","mechanism":"R01 or FOA number or funder acronym","description":"one sentence","sections":[{"title":"Section Title","pageLimit":2,"guidance":"2-3 sentences telling the applicant what this section must accomplish"}]}
Rules:
- 4-12 sections in the order they appear in the application
- pageLimit: number of pages allowed; omit the field if the funder sets no limit. NEVER invent limits — use limits stated in the description, or well-known limits for the named mechanism (e.g. NIH R01: Specific Aims 1, Research Strategy 12)
- guidance must be actionable and specific to this funder, not generic
- No markdown, no commentary, JSON only`;

  const prompt = `Funding opportunity / grant description:\n"""\n${truncateText(description, settings.provider === 'local' ? 4000 : 12000)}\n"""\n\nReturn the template JSON.`;
  const raw = await callLLM(prompt, settings, systemPrompt, true, undefined, undefined, 2000);
  return parseJSONRobust(raw);
}

/** Whitespace-delimited word count. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Choose the best trim result. Candidates that grew beyond the input are
 * discarded; among the rest, prefer the longest that fits the budget (most
 * content retained), else the shortest. If every candidate grew, return the
 * input unchanged — a "trim" must never make text longer.
 */
export function bestTrimCandidate(
  input: string,
  candidates: string[],
  budgetWords: number,
): { text: string; withinBudget: boolean } {
  const inputWords = countWords(input);
  const scored = candidates
    .map(text => ({ text, words: countWords(text) }))
    .filter(c => c.words > 0 && c.words <= inputWords);
  if (scored.length === 0) return { text: input, withinBudget: inputWords <= budgetWords };

  const underBudget = scored.filter(c => c.words <= budgetWords);
  if (underBudget.length > 0) {
    const best = underBudget.reduce((a, b) => (b.words > a.words ? b : a));
    return { text: best.text, withinBudget: true };
  }
  const shortest = scored.reduce((a, b) => (b.words < a.words ? b : a));
  return { text: shortest.text, withinBudget: false };
}

/** Condense a section to fit its page budget. Returns the trimmed text. */
export async function trimSectionToLimit(sectionText: string, sectionTitle: string, budgetWords: number, settings: AISettings): Promise<string> {
  const baseSystem = `You condense grant/manuscript sections to fit strict page limits WITHOUT losing substance.
Rules:
- The result MUST be at most ${budgetWords} words and MUST be shorter than the input.
- Preserve every distinct claim, aim, number, and citation marker like [3]. Cut redundancy, filler, hedging, and over-explanation only.
- Keep the same heading-free plain prose and paragraph order.
- Do NOT use em dashes or en dashes. Keep sentences under 30 words.
- Example: "In order to be able to determine whether X occurs, we performed" -> "To test whether X occurs, we".
Return ONLY the condensed section text. No preamble, no commentary.${grantInstructionsBlock()}`;

  const candidates: string[] = [];
  let current = sectionText;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = attempt === 0
      ? `Section "${sectionTitle}" (target: at most ${budgetWords} words):\n"""\n${sectionText}\n"""\n\nCondense it to fit the budget.`
      : `Your previous draft was ${countWords(current)} words — still too long. Cut it to under ${budgetWords} words by removing redundancy and filler only. Keep every distinct claim, number, and citation marker.\n"""\n${current}\n"""`;
    const out = (await callLLM(prompt, settings, baseSystem, false)).trim();
    if (!out) break;
    candidates.push(out);
    current = out;
    if (countWords(out) <= budgetWords) break; // good enough, stop early
  }

  return bestTrimCandidate(sectionText, candidates, budgetWords).text;
}

// ─── Agent tools ──────────────────────────────────────────────────────────────

export interface AgentTool {
  name: string;
  description: string;
  /** executes the tool; returns plain text for the model */
  run: (args: Record<string, any>) => Promise<string>;
}

const TOOL_CALL_RE = /\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/;

function toolProtocolPrompt(tools: AgentTool[]): string {
  return `

TOOLS AVAILABLE — you may call these before answering:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
To call a tool, reply with ONLY:
[TOOL_CALL]{"tool":"<name>","args":{...}}[/TOOL_CALL]
You will receive the result and can then call another tool or give your final answer. Maximum 3 tool calls. Never mention the tool syntax in your final answer.`;
}

/**
 * Provider-agnostic tool loop: works with any model (no native function-calling
 * required). The model requests tools via a [TOOL_CALL] JSON block; we execute
 * and feed results back, then return the final plain answer.
 */
export async function runWithTools(
  prompt: string,
  systemPrompt: string,
  tools: AgentTool[],
  settings: AISettings,
  signal?: AbortSignal,
  onToolUse?: (name: string) => void,
): Promise<string> {
  if (tools.length === 0) return callLLM(prompt, settings, systemPrompt, false, undefined, signal);

  const system = systemPrompt + toolProtocolPrompt(tools);
  let conversation = prompt;

  for (let round = 0; round < 4; round++) {
    const response = await callLLM(conversation, settings, system, false, undefined, signal);
    const match = response.match(TOOL_CALL_RE);
    if (!match || round === 3) {
      return response.replace(TOOL_CALL_RE, '').trim();
    }

    let result = '';
    let toolName = 'unknown';
    try {
      const call = parseJSONRobust(match[1]);
      toolName = String(call.tool ?? '');
      const tool = tools.find(t => t.name === toolName);
      if (!tool) {
        result = `Error: unknown tool "${toolName}". Available: ${tools.map(t => t.name).join(', ')}`;
      } else {
        onToolUse?.(toolName);
        result = await tool.run(call.args ?? {});
      }
    } catch (e) {
      result = `Error executing tool: ${e instanceof Error ? e.message : 'invalid tool call JSON'}`;
    }

    conversation += `\n\n[Assistant called tool ${toolName}]\n[TOOL_RESULT]\n${result.slice(0, 6000)}\n[/TOOL_RESULT]\n\nContinue: call another tool if needed, or give your final answer now.`;
  }
  return '';
}

export const POST_DRAFTING_PROMPTS = {
  COVER_LETTER_AGENT: `You are an expert academic editor drafting a journal cover letter.
Write a formal, persuasive cover letter to the Editor-in-Chief.
1. State the manuscript title and target journal (use placeholders like [Journal Name] if unknown).
2. Briefly summarize the core research question and methodology.
3. Highlight the most significant findings and their broader impact.
4. Explain why this paper is a perfect fit for the journal's readership.
5. Include standard declarations (not under consideration elsewhere, all authors agree).
Make it professional, confident, and concise (under 400 words).`,

  REBUTTAL_AGENT: `You are an expert academic editor drafting a response to reviewers.
Based on the provided manuscript, draft a template for a rebuttal letter.
Include:
1. A polite, appreciative opening to the Editor and Reviewers.
2. A bulleted summary of the major changes made to the manuscript.
3. A structured "Point-by-Point Response" section with placeholder examples showing how to respectfully agree with, or push back on, reviewer comments using evidence from the text.`,

  RESUBMISSION_AGENT: `You are an expert grant-writing consultant drafting the materials for an NIH resubmission (A1).
Using the application text and, if provided, the reviewers' summary statement, produce:

## Introduction to Revised Application (1 page)
A confident, non-defensive opening that thanks the reviewers, then addresses each major concern in turn. For each: restate the concern briefly, state the specific change made in response, and point to where it now appears. Use "we have" language for completed changes. Do not concede more than the critique requires.

## Point-by-Point Response Plan
A numbered list mapping each reviewer concern to a concrete revision. Where a concern reflects a misunderstanding, respond respectfully with evidence rather than capitulating.

## Suggested New Preliminary Data / Aims Adjustments
Bulleted, concrete suggestions for what would most strengthen the resubmission, based on the weaknesses evident in the text.

If no reviewer comments are provided, infer the likely study-section concerns from the application itself and structure the response around those, noting they are anticipated rather than received. Write in confident NIH grant style: future tense with agency for proposed work, no em dashes, sentences under 30 words.`,
};
