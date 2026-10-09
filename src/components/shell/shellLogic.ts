import { useDeferredValue, useMemo } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { DocFormat, VoiceProfile } from '../../types';
import { readPageLimit } from '../../services/pageLimit';
import { estimatePages, type PageEstimate } from '../../services/pagination';
import { styleDistance } from '../../services/proseAudit/score';
import { activeSummary } from '../../services/proseAudit/profile';
import { auditMatchesDoc, type StyleAuditSnapshot } from '../style/styleSync';
import { worstOverBudget } from '../GrantPanel';
import type { RailTask } from './Rail';
import type { DocStats } from './StatusBar';

export type PanelTab = 'chat' | 'suggestions' | 'history' | 'sources' | 'outline' | 'style';

export const TASK_TAB: Record<RailTask, PanelTab> = {
  write: 'outline', cite: 'sources', review: 'suggestions', format: 'style',
};
export const TAB_TASK: Record<PanelTab, RailTask> = {
  chat: 'review', suggestions: 'review', history: 'write', outline: 'write', sources: 'cite', style: 'format',
};

/**
 * The page limit shown beside the count: the author's own, set in the Format panel and stored on the document's format.
 * Null while unset, and the status bar then shows the estimate alone. The app never supplies a number itself: real
 * limits depend on the activity code and the funding announcement, and a template's section limits do not sum to a
 * document limit (an R01's sections sum to 14, its page-limited body is 13).
 */
export function documentPageLimit(format: DocFormat | null | undefined): number | null {
  return readPageLimit(format?.pageLimitPages);
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
export function railSelect(current: RailTask | null, clicked: RailTask): { task: RailTask | null; tab: PanelTab | null } {
  return current === clicked ? { task: null, tab: null } : { task: clicked, tab: TASK_TAB[clicked] };
}

/** A legacy call site revealing a tab: the tab and its owning rail task move together. */
export function revealTab(tab: PanelTab): { task: RailTask; tab: PanelTab } {
  return { task: TAB_TASK[tab], tab };
}

/**
 * Characters (text only, no block separators), top-level blocks and reading time (200 words a minute) of the document.
 * `words` is passed in: the status bar already counts them from the same text it shows.
 */
export function docStats(doc: JSONContent | null, words: number): DocStats {
  let chars = 0;
  const walk = (n: JSONContent) => {
    if (n.type === 'text') chars += n.text?.length ?? 0;
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return { chars, paragraphs: doc?.content?.length ?? 0, readingMin: Math.ceil(words / 200) };
}

/** The grant section furthest over its page budget, deferred like the page estimate so typing never waits on it. Null outside grant mode and when nothing is over. */
export function useOverBudget(html: string, templateId: string | null | undefined, grant: boolean) {
  const deferred = useDeferredValue(html);
  return useMemo(() => (grant ? worstOverBudget(deferred, templateId) : null), [deferred, templateId, grant]);
}
