import type { MouseEvent } from 'react';

/**
 * Mouse-down is swallowed so the editor keeps its selection; the action runs on click. Every control on the floating selection bar uses this:
 * without it the press collapses the selection and the action runs on nothing.
 */
export const press = (fn: () => void) => ({ onMouseDown: (e: MouseEvent) => e.preventDefault(), onClick: fn });
