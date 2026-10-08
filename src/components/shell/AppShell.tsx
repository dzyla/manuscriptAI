import type { ReactNode } from 'react';
import { Rail, type RailTask, type RailBadges } from './Rail';

/**
 * Page-first layout: top bar, a four-task rail, one optional panel, the page canvas, a status bar.
 * The panel renders only while a task is active; `hideChrome` (focus mode) drops the rail and panel; the caller decides what the top and status bars show.
 */
export function AppShell({ topBar, panel, canvas, statusBar, active, badges, onSelect, hideChrome = false, keepPanelMounted = false }: {
  topBar: ReactNode;
  panel: ReactNode;
  canvas: ReactNode;
  statusBar: ReactNode;
  active: RailTask | null;
  badges: RailBadges;
  onSelect: (t: RailTask) => void;
  hideChrome?: boolean;
  /** Hide a closed panel with CSS instead of unmounting it, so its in-progress state (chat draft, search) survives. */
  keepPanelMounted?: boolean;
}) {
  const showPanel = !hideChrome && active !== null;
  return (
    <div className="u-shell">
      <div className="u-shell-top">{topBar}</div>
      <div className="u-shell-body">
        {!hideChrome && <Rail active={active} badges={badges} onSelect={onSelect} />}
        {(showPanel || keepPanelMounted) && (
          <aside className="u-shell-panel" data-task={active} hidden={!showPanel}>{panel}</aside>
        )}
        <main className="u-shell-canvas">{canvas}</main>
      </div>
      <div className="u-shell-status">{statusBar}</div>
    </div>
  );
}
