// src/components/shell/AppShell.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Rail } from './Rail';
import { StatusBar } from './StatusBar';

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
