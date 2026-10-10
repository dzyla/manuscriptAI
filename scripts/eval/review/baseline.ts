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
