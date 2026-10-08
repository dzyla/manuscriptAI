import { useDeferredValue, useMemo } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { DocFormat, DocumentMode, VoiceProfile } from '../../types';
import { estimatePages, type PageEstimate } from '../../services/pagination';
import { styleDistance } from '../../services/proseAudit/score';
import { activeSummary } from '../../services/proseAudit/profile';
import { auditMatchesDoc, type StyleAuditSnapshot } from '../style/styleSync';
import type { RailTask } from './Rail';

export type SidebarTab = 'chat' | 'suggestions' | 'history' | 'sources' | 'outline' | 'style';

export const TASK_TAB: Record<RailTask, SidebarTab> = {
  write: 'outline', cite: 'sources', review: 'suggestions', format: 'style',
};
export const TAB_TASK: Record<SidebarTab, RailTask> = {
  chat: 'review', suggestions: 'review', history: 'write', outline: 'write', sources: 'cite', style: 'format',
};

/**
 * The page limit shown beside the count. Deliberately null for now: summing a template's section
 * limits gives 14 for an R01, where NIH's page-limited body is 13 (1 page Specific Aims + 12 Research
 * Strategy), and an author at 13.5 pages would read "not over". The explicit `documentPageLimit` per
 * template lands in Task 7, with values sourced from NIH guidance or the FOA, never inferred here.
 */
export function documentPageLimit(_mode: DocumentMode, _templateId: string | null | undefined): number | null {
  return null;
}

/** The style distance to the author's own voice, or null when there is no honest figure to show. */
export function voiceFigure(
  audit: StyleAuditSnapshot | null,
  currentText: string | undefined,
  profile: VoiceProfile | undefined,
): number | null {
  if (!auditMatchesDoc(audit, currentText)) return null; // never report a measurement of text that is gone
  const { summary, isGeneric } = activeSummary(profile);
  return isGeneric ? null : Math.round(styleDistance(audit.metrics.summary, summary).score);
}

/** Deferred so typing is never blocked by a whole-document walk; memoised on document and format only. */
export function usePageEstimate(doc: JSONContent | null, format: DocFormat | null): PageEstimate {
  const deferred = useDeferredValue(doc);
  return useMemo(() => estimatePages(deferred, format ?? null), [deferred, format]);
}

/**
 * What a rail click does. Clicking the open task closes the panel and leaves the tab alone (`tab: null`);
 * clicking another opens it on that task's tab. The rail task is never derived from a tab change after the
 * fact: tab changes go through `revealTab`, which sets both together.
 */
export function railSelect(current: RailTask | null, clicked: RailTask): { task: RailTask | null; tab: SidebarTab | null } {
  return current === clicked ? { task: null, tab: null } : { task: clicked, tab: TASK_TAB[clicked] };
}

/** A legacy call site revealing a tab: the tab and its owning rail task move together. */
export function revealTab(tab: SidebarTab): { task: RailTask; tab: SidebarTab } {
  return { task: TAB_TASK[tab], tab };
}
