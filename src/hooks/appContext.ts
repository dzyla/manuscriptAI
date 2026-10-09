import type { RefObject } from 'react';
import type { EditorRef } from '../components/Editor';
import type { PanelTab } from '../components/shell/shellLogic';

export type ShowToast = (message: string, type?: 'success' | 'info' | 'error', action?: { label: string; onClick: () => void }) => void;

/** What the App-level hooks share: the editor handle, the toast, and the legacy "reveal this tab" call that also opens the rail task. */
export interface AppCtx {
  editorRef: RefObject<EditorRef | null>;
  showToast: ShowToast;
  openTab: (tab: PanelTab) => void;
}
