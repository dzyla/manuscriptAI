// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FigureControls } from './FigureControls';
import { FIGURE_PROMPTS } from './figurePrompts';

afterEach(cleanup);
const click = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el); };

const setup = (extra = {}) => {
  const f = { onDescribe: vi.fn(), onQuality: vi.fn(), onRelevance: vi.fn(), onAsk: vi.fn(), onDelete: vi.fn(), onAlign: vi.fn(), onSize: vi.fn() };
  render(<FigureControls {...f} {...extra} />);
  return f;
};

describe('FigureControls', () => {
  it('offers the four figure-AI questions, the fifth (quality check), layout and delete', () => {
    setup();
    for (const id of ['describe', 'quality', 'relevance', 'ask', 'delete-figure', 'align-figure', 'size-figure']) expect(screen.getAllByTestId(`control-${id}`).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('control-align-figure')).toHaveLength(3);
    expect(screen.getAllByTestId('control-size-figure')).toHaveLength(4);
  });

  it('each control reports its own callback exactly once', () => {
    const f = setup();
    click(screen.getByTestId('control-describe'));
    click(screen.getByTestId('control-quality'));
    click(screen.getByTestId('control-relevance'));
    click(screen.getByTestId('control-delete-figure'));
    expect(f.onDescribe).toHaveBeenCalledTimes(1);
    expect(f.onQuality).toHaveBeenCalledTimes(1);
    expect(f.onRelevance).toHaveBeenCalledTimes(1);
    expect(f.onDelete).toHaveBeenCalledTimes(1);
    expect(f.onAsk).not.toHaveBeenCalled();
  });

  it('align and size say which one was chosen', () => {
    const f = setup();
    click(screen.getAllByTestId('control-align-figure')[1]);
    expect(f.onAlign).toHaveBeenCalledWith('center');
    click(screen.getAllByTestId('control-size-figure')[1]);
    expect(f.onSize).toHaveBeenCalledWith('50%');
  });

  it('Ask opens a question box; sending reports the question once and closes it; an empty question is never sent', () => {
    const f = setup();
    expect(screen.queryByTestId('control-ask-text')).toBeNull();
    click(screen.getByTestId('control-ask'));
    const send = screen.getByTestId('control-ask-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId('control-ask-text'), { key: 'Enter' });
    expect(f.onAsk).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('control-ask-text'), { target: { value: '  what is the x axis?  ' } });
    click(send);
    expect(f.onAsk).toHaveBeenCalledTimes(1);
    expect(f.onAsk).toHaveBeenCalledWith('what is the x axis?');
    expect(screen.queryByTestId('control-ask-text')).toBeNull();
  });

  it('Enter sends and Escape abandons the question', () => {
    const f = setup();
    click(screen.getByTestId('control-ask'));
    fireEvent.change(screen.getByTestId('control-ask-text'), { target: { value: 'why?' } });
    fireEvent.keyDown(screen.getByTestId('control-ask-text'), { key: 'Escape' });
    expect(f.onAsk).not.toHaveBeenCalled();
    click(screen.getByTestId('control-ask'));
    fireEvent.change(screen.getByTestId('control-ask-text'), { target: { value: 'why?' } });
    fireEvent.keyDown(screen.getByTestId('control-ask-text'), { key: 'Enter' });
    expect(f.onAsk).toHaveBeenCalledWith('why?');
  });

  it('a figure with no caption has no context line, and shows one when there is context', () => {
    const { unmount } = render(<FigureControls onDescribe={() => {}} onRelevance={() => {}} onAsk={() => {}} onDelete={() => {}} />);
    expect(document.body.textContent).not.toContain('Context:');
    unmount();
    cleanup();
    render(<FigureControls onDescribe={() => {}} onRelevance={() => {}} onAsk={() => {}} onDelete={() => {}} context="Figure 1. Binding curves." />);
    expect(document.body.textContent).toContain('Context: "Figure 1. Binding curves."');
  });

  it('controls the caller did not wire are disabled rather than silently doing nothing', () => {
    render(<FigureControls onDescribe={() => {}} onRelevance={() => {}} onAsk={() => {}} onDelete={() => {}} />);
    expect((screen.getByTestId('control-quality') as HTMLButtonElement).disabled).toBe(true);
    for (const b of screen.getAllByTestId('control-align-figure')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('the figure prompts keep their wording', () => {
    expect(FIGURE_PROMPTS.describe).toMatch(/purely visually/);
    expect(FIGURE_PROMPTS.quality).toMatch(/visual integrity/);
    expect(FIGURE_PROMPTS.relevance).toMatch(/surrounding manuscript text/);
  });
});
