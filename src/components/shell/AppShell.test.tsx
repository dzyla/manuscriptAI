// src/components/shell/AppShell.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Rail } from './Rail';
import { StatusBar } from './StatusBar';
import { AppShell } from './AppShell';

afterEach(cleanup);

describe('Rail', () => {
  it('offers exactly the four tasks', () => {
    render(<Rail active={null} badges={{}} onSelect={() => {}} />);
    for (const label of ['Write', 'Cite', 'Review', 'Format']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy();
    }
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('reports the task when one is chosen', () => {
    const onSelect = vi.fn();
    render(<Rail active={null} badges={{}} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Review/i }));
    expect(onSelect).toHaveBeenCalledWith('review');
  });

  it('reports the active task again so the caller can close it', () => {
    const onSelect = vi.fn();
    render(<Rail active="cite" badges={{}} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Cite/i }));
    expect(onSelect).toHaveBeenCalledWith('cite');
  });

  it('marks only the active task as pressed', () => {
    render(<Rail active="write" badges={{}} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /Write/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Cite/i }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a badge count only when there is one', () => {
    render(<Rail active={null} badges={{ review: 3 }} onSelect={() => {}} />);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByTestId('badge-cite')).toBeNull();
  });
});

describe('StatusBar', () => {
  const estimate = { pages: 11, approximate: true, breaks: [] };

  it('marks an approximate page count with a tilde', () => {
    render(<StatusBar estimate={estimate} limitPages={12} words={4820} voiceDistance={22} saveState="Saved" />);
    expect(screen.getByText(/~11 of 12/)).toBeTruthy();
  });

  it('drops the tilde once the estimate is exact', () => {
    render(<StatusBar estimate={{ ...estimate, approximate: false }} limitPages={12} words={1} voiceDistance={null} saveState="Saved" />);
    expect(screen.getByText(/\b11 of 12\b/)).toBeTruthy();
    expect(screen.queryByText(/~11/)).toBeNull();
  });

  it('shows the page count without a limit when none applies', () => {
    render(<StatusBar estimate={estimate} limitPages={null} words={10} voiceDistance={null} saveState="Saved" />);
    expect(screen.getByText(/~11 pp/)).toBeTruthy();
    expect(screen.queryByText(/of/)).toBeNull();
  });

  it('omits the voice figure when no audit has run', () => {
    render(<StatusBar estimate={estimate} limitPages={12} words={10} voiceDistance={null} saveState="Saved" />);
    expect(screen.queryByText(/voice/i)).toBeNull();
  });

  it('says the estimate ignores figure and table flow', () => {
    render(<StatusBar estimate={estimate} limitPages={12} words={10} voiceDistance={null} saveState="Saved" />);
    expect(screen.getByTitle(/ignores figure and table flow/i)).toBeTruthy();
  });
});

describe('StatusBar honesty', () => {
  const estimate = { pages: 11, approximate: true, breaks: [] };
  it('carries the approximation note only while the count is approximate', () => {
    render(<StatusBar estimate={{ ...estimate, approximate: false }} limitPages={12} words={1} voiceDistance={null} saveState="Saved" />);
    expect(screen.queryByTitle(/ignores figure and table flow/i)).toBeNull();
  });
  it('flags a count over the limit', () => {
    render(<StatusBar estimate={{ ...estimate, pages: 13 }} limitPages={12} words={1} voiceDistance={null} saveState="Saved" />);
    expect(screen.getByText(/13 of 12/).className).toContain('is-over');
  });
  it('does not flag a count within the limit', () => {
    render(<StatusBar estimate={estimate} limitPages={12} words={1} voiceDistance={null} saveState="Saved" />);
    expect(screen.getByText(/11 of 12/).className).not.toContain('is-over');
  });
});

describe('AppShell', () => {
  const base = { topBar: <i>top</i>, canvas: <i>canvas</i>, statusBar: <i>status</i>, badges: {}, onSelect: () => {} };
  it('renders no panel while no task is active', () => {
    render(<AppShell {...base} panel={<i>the panel</i>} active={null} />);
    expect(screen.queryByText('the panel')).toBeNull();
    expect(screen.getByText('canvas')).toBeTruthy();
  });
  it('renders the panel for the active task', () => {
    render(<AppShell {...base} panel={<i>the panel</i>} active="cite" />);
    expect(screen.getByText('the panel')).toBeTruthy();
  });
  it('keeps a closed panel mounted but hidden when asked, so its state survives', () => {
    const { rerender } = render(<AppShell {...base} panel={<input aria-label="draft" />} active="cite" keepPanelMounted />);
    const input = screen.getByLabelText('draft') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half a message' } });
    rerender(<AppShell {...base} panel={<input aria-label="draft" />} active={null} keepPanelMounted />);
    const again = document.querySelector('input') as HTMLInputElement;
    expect(again).toBe(input);
    expect(again.value).toBe('half a message');
    expect(again.closest('aside')!.hidden).toBe(true);
  });
  it('drops the rail and panel in focus mode but keeps the canvas and bars', () => {
    render(<AppShell {...base} panel={<i>the panel</i>} active="cite" hideChrome />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('the panel')).toBeNull();
    expect(screen.getByText('canvas')).toBeTruthy();
    expect(screen.getByText('top')).toBeTruthy();
  });
  it('shows the rail with every badge at zero and no badge elements', () => {
    render(<AppShell {...base} panel={null} active={null} badges={{ review: 0, cite: 0 }} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByTestId('badge-review')).toBeNull();
  });
});
