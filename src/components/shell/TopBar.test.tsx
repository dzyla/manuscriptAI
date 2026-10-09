// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TopBar, type TopBarItems } from './TopBar';

afterEach(cleanup);

const items = (over: Partial<TopBarItems> = {}): TopBarItems => ({
  file: [{ id: 'import', label: 'Import Word document…', onSelect: () => {} }, { id: 'undo', label: 'Undo', onSelect: () => {} }],
  insert: [{ id: 'figure', label: 'Figure…', onSelect: () => {} }],
  ai: [{ id: 'rewrite', label: 'Rewrite the selection', onSelect: () => {} }, { id: 'analyze', label: 'Analyze all', anywhere: true, onSelect: () => {} }],
  overflow: [{ id: 'settings', label: 'Settings…', onSelect: () => {} }],
  ...over,
});
const bar = (selection: 'none' | 'text' | 'figure' | 'table' = 'none', it: TopBarItems = items(), extra = {}) =>
  render(<TopBar title="Doc" onTitleChange={() => {}} selection={selection} items={it} {...extra} />);

describe('TopBar', () => {
  it('keeps roughly eight controls at rest, not fifty-three', () => {
    const { container } = bar();
    expect(container.querySelectorAll('button').length).toBeLessThanOrEqual(8);
    expect(container.querySelectorAll('button').length).toBe(4); // File, Insert, AI, overflow
  });

  it('disables the AI items with no selection and says why', () => {
    bar();
    fireEvent.click(screen.getByTestId('topbar-ai'));
    const item = screen.getByTestId('item-rewrite') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.getAttribute('title')).toMatch(/select/i);
  });

  it('keeps the items that do not need a selection usable, so the menu is never all grey for a reason that is not the selection', () => {
    bar();
    fireEvent.click(screen.getByTestId('topbar-ai'));
    expect((screen.getByTestId('item-analyze') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables the AI items once text is selected', () => {
    bar('text');
    fireEvent.click(screen.getByTestId('topbar-ai'));
    expect((screen.getByTestId('item-rewrite') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['figure', 'table'] as const)('keeps the text actions disabled when a %s is selected (there is no text to act on)', (kind) => {
    bar(kind);
    fireEvent.click(screen.getByTestId('topbar-ai'));
    expect((screen.getByTestId('item-rewrite') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps undo and redo in the File menu rather than the bar', () => {
    bar();
    expect(screen.queryByTestId('control-undo')).toBeNull();
    expect(screen.queryByTestId('item-undo')).toBeNull(); // closed menu: nothing drawn
    fireEvent.click(screen.getByTestId('topbar-file'));
    expect(screen.getByTestId('item-undo')).toBeTruthy();
  });

  it('runs the chosen item once and closes the menu; a toggle that keeps it open leaves it open', () => {
    const onSelect = vi.fn(), toggle = vi.fn();
    bar('none', items({ file: [{ id: 'a', label: 'A', onSelect }, { id: 'b', label: 'B', keepOpen: true, onSelect: toggle }] }));
    fireEvent.click(screen.getByTestId('topbar-file'));
    fireEvent.click(screen.getByTestId('item-b'));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('item-a')).toBeTruthy();
    fireEvent.click(screen.getByTestId('item-a'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('item-a')).toBeNull();
  });

  it('closes on Escape and on a click outside, and opens one menu at a time', () => {
    bar();
    fireEvent.click(screen.getByTestId('topbar-file'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('item-undo')).toBeNull();
    fireEvent.click(screen.getByTestId('topbar-file'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('item-undo')).toBeNull();
    fireEvent.click(screen.getByTestId('topbar-file'));
    fireEvent.mouseDown(screen.getByTestId('topbar-insert'));
    fireEvent.click(screen.getByTestId('topbar-insert'));
    expect(screen.queryByTestId('item-undo')).toBeNull();
    expect(screen.getByTestId('item-figure')).toBeTruthy();
  });

  it('shows the selection-aware group between the menus and the overflow, and the body-style selector only while no text is selected', () => {
    const body = <select data-testid="topbar-body-style" />;
    const extra = { bodyStyle: body, children: <span data-testid="the-group" /> };
    const { unmount } = bar('none', items(), extra);
    expect(screen.getByTestId('topbar-body-style')).toBeTruthy();
    expect(screen.getByTestId('the-group')).toBeTruthy();
    unmount();
    bar('text', items(), extra);
    expect(screen.queryByTestId('topbar-body-style')).toBeNull();
  });

  it('renames the document, and shows Stop only while a request runs', () => {
    const onTitleChange = vi.fn(), onStop = vi.fn();
    const { unmount } = render(<TopBar title="Doc" onTitleChange={onTitleChange} selection="none" items={items()} onStop={onStop} />);
    fireEvent.change(screen.getByTestId('topbar-title'), { target: { value: 'New name' } });
    expect(onTitleChange).toHaveBeenCalledWith('New name');
    expect(screen.queryByTestId('topbar-stop')).toBeNull();
    unmount();
    render(<TopBar title="Doc" onTitleChange={onTitleChange} selection="none" items={items()} onStop={onStop} busy />);
    fireEvent.click(screen.getByTestId('topbar-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('an expandable item shows its panel and children only while expanded', () => {
    const it2 = items({ ai: [{ id: 'x', label: 'X', anywhere: true, expanded: false, panel: <i data-testid="panel" />, children: [{ id: 'c', label: 'C', anywhere: true }] }] });
    const { unmount } = bar('none', it2);
    fireEvent.click(screen.getByTestId('topbar-ai'));
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(screen.getByTestId('item-x').getAttribute('aria-expanded')).toBe('false');
    unmount();
    bar('none', items({ ai: [{ ...it2.ai[0], expanded: true }] }));
    fireEvent.click(screen.getByTestId('topbar-ai'));
    expect(screen.getByTestId('panel')).toBeTruthy();
    expect(screen.getByTestId('item-c')).toBeTruthy();
  });
});
