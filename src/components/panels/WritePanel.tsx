import { memo, useCallback, useEffect, useState } from 'react';
import { Clock, History as HistoryIcon, List } from 'lucide-react';
import type { HistoryItem, VersionSnapshot } from '../../types';
import { Outline } from './write/Outline';
import { History } from './write/History';
import { Versions } from './write/Versions';
import type { OutlineItem } from './write/outline';
import { Section } from './Section';

export interface WritePanelProps {
  outline: OutlineItem[];
  wordCounts?: Record<string, number>;
  history: HistoryItem[];
  /** Jump to a heading by its text (looked up in the live document at click time). */
  onGoTo: (headingText: string) => void;
  onAnalyzeSection?: (sectionText: string, sectionTitle: string) => void;
  onRevertHistory: (historyId: string) => void;
  onHistoryItemClick?: (item: HistoryItem) => void;
  /** Read when a snapshot is saved, not on every render: typing must not re-render this panel. */
  getDocument: () => { title: string; content: string };
  onRestore: (snapshot: VersionSnapshot) => void | Promise<void>;
  /** Opens this section when it changes (a legacy caller asking for the history tab). */
  reveal?: 'outline' | 'history';
}

/**
 * The Write panel: the outline of the open document, the history of applied suggestions, and named version snapshots.
 * It stays mounted when another panel is open (the host hides it), so its sections keep their state.
 */
export const WritePanel = memo(function WritePanel(p: WritePanelProps) {
  const [open, setOpen] = useState({ outline: true, history: false, versions: false });
  const [versionCount, setVersionCount] = useState(0);
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));
  useEffect(() => { if (p.reveal) setOpen(o => ({ ...o, [p.reveal!]: true })); }, [p.reveal]);
  const onCount = useCallback((n: number) => setVersionCount(n), []);

  return (
    <div className="space-y-3">
      <Section id="outline" label="Outline" count={p.outline.length} icon={<List size={13} />} open={open.outline} onToggle={() => toggle('outline')}>
        <Outline outline={p.outline} wordCounts={p.wordCounts ?? {}} onGoTo={p.onGoTo} onAnalyzeSection={p.onAnalyzeSection} />
      </Section>
      <Section id="history" label="History" count={p.history.length} icon={<HistoryIcon size={13} />} open={open.history} onToggle={() => toggle('history')}>
        <History history={p.history} onRevert={p.onRevertHistory} onItemClick={p.onHistoryItemClick} />
      </Section>
      <Section id="versions" label="Versions" count={versionCount} icon={<Clock size={13} />} open={open.versions} onToggle={() => toggle('versions')}>
        <Versions getDocument={p.getDocument} onCount={onCount} onRestore={p.onRestore} />
      </Section>
    </div>
  );
});
