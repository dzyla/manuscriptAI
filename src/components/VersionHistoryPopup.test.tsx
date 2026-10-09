// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import 'fake-indexeddb/auto';
import VersionHistoryPopup from './VersionHistoryPopup';
import { WritePanel } from './panels/WritePanel';
import { db } from '../db/manuscriptDb';
import { restoreIfPresent, SNAPSHOT_GONE_MESSAGE } from '../services/versionSnapshots';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.versionSnapshots.clear(); });

const snap = (id: string, name: string, content: string) => ({ id, name, timestamp: Date.now(), title: `T-${id}`, content, wordCount: 1 });
const openPopup = () => fireEvent.click(screen.getByTitle('Version History'));

describe('VersionHistoryPopup', () => {
  it('save writes a snapshot of the current title and content under the typed name', async () => {
    render(<VersionHistoryPopup currentTitle="My title" currentContent="<p>current words</p>" onRestore={() => {}} />);
    openPopup();
    fireEvent.click(screen.getByTitle('Save snapshot'));
    fireEvent.change(screen.getByPlaceholderText(/Snapshot —/), { target: { value: 'Checkpoint' } });
    fireEvent.click(screen.getByTitle('Save with this name'));
    await waitFor(async () => expect(await db.versionSnapshots.count()).toBe(1));
    expect(await db.versionSnapshots.toCollection().first()).toMatchObject({ name: 'Checkpoint', title: 'My title', content: '<p>current words</p>' });
  });

  it('restore hands the chosen snapshot (not another) to the document', async () => {
    await db.versionSnapshots.bulkAdd([snap('a', 'Older', '<p>OLD</p>'), { ...snap('b', 'Newer', '<p>NEW</p>'), timestamp: Date.now() + 1000 }]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onRestore = vi.fn();
    render(<VersionHistoryPopup currentTitle="t" currentContent="<p>x</p>" onRestore={onRestore} />);
    openPopup();
    await screen.findByText('Older');
    const li = screen.getByText('Older').closest('li')!;
    fireEvent.click(li.querySelector('[title="Restore"]')!);
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', content: '<p>OLD</p>', title: 'T-a' }));
  });

  it('delete removes the snapshot, and only after confirmation', async () => {
    await db.versionSnapshots.add(snap('a', 'Doomed', '<p>x</p>'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<VersionHistoryPopup currentTitle="t" currentContent="" onRestore={() => {}} />);
    openPopup();
    await screen.findByText('Doomed');
    fireEvent.click(screen.getByTitle('Delete'));
    expect(await db.versionSnapshots.count()).toBe(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(async () => expect(await db.versionSnapshots.count()).toBe(0));
  });

  it('preview shows the snapshot content', async () => {
    await db.versionSnapshots.add(snap('a', 'Look', '<p>PREVIEW_BODY</p>'));
    render(<VersionHistoryPopup currentTitle="t" currentContent="" onRestore={() => {}} />);
    openPopup();
    await screen.findByText('Look');
    fireEvent.click(screen.getByTitle('Preview'));
    expect(screen.getByText('PREVIEW_BODY')).toBeTruthy();
  });
});

describe('the popup and the Write panel share one live list', () => {
  const panel = (onRestore = vi.fn()) => render(
    <WritePanel outline={[]} history={[]} onGoTo={() => {}} onRevertHistory={() => {}} getDocument={() => ({ title: 'T', content: '<p>x</p>' })} onRestore={onRestore} />,
  );

  it('a save from the popup appears in an already-open Versions section without reopening it', async () => {
    panel();
    fireEvent.click(screen.getByTestId('section-versions'));
    expect(screen.getByText('No snapshots yet')).toBeTruthy();
    render(<VersionHistoryPopup currentTitle="t" currentContent="<p>y</p>" onRestore={() => {}} />);
    openPopup();
    fireEvent.click(screen.getAllByTitle('Save snapshot').at(-1)!); // the popup's (rendered last); the panel has its own
    fireEvent.change(screen.getByPlaceholderText(/Snapshot —/), { target: { value: 'From the top bar' } });
    fireEvent.click(screen.getByTitle('Save with this name'));
    expect((await screen.findAllByText('From the top bar')).length).toBeGreaterThan(0);
    expect(screen.queryByText('No snapshots yet')).toBeNull();
  });

  it('the panel delete removes the record', async () => {
    await db.versionSnapshots.add(snap('a', 'Gone soon', '<p>x</p>'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    panel();
    await screen.findByText('Gone soon');
    fireEvent.click(screen.getByTestId('control-delete-version'));
    await waitFor(async () => expect(await db.versionSnapshots.count()).toBe(0));
    await waitFor(() => expect(screen.queryByText('Gone soon')).toBeNull());
  });

  it('restoring a snapshot that no longer exists is refused, and an existing one is restored from the stored record', async () => {
    const onRestore = vi.fn();
    await db.versionSnapshots.add(snap('a', 'Real', '<p>STORED</p>'));
    expect(await restoreIfPresent('gone', onRestore)).toBe(false);
    expect(onRestore).not.toHaveBeenCalled();
    expect(await restoreIfPresent('a', onRestore)).toBe(true);
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', content: '<p>STORED</p>' }));
  });

  it('a refused restore tells the author in the panel and in the popup, and does not touch the document', async () => {
    await db.versionSnapshots.add(snap('a', 'Vanishing', '<p>x</p>'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onRestore = vi.fn();
    const panelView = panel(onRestore);
    await screen.findByText('Vanishing');
    vi.spyOn(db.versionSnapshots, 'get').mockResolvedValue(undefined); // the record went between the list render and the click
    fireEvent.click(screen.getByTestId('control-restore-version'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(SNAPSHOT_GONE_MESSAGE));
    panelView.unmount();
    alert.mockClear();
    render(<VersionHistoryPopup currentTitle="t" currentContent="<p>x</p>" onRestore={onRestore} />);
    openPopup();
    const li = (await screen.findByText('Vanishing')).closest('li')!;
    fireEvent.click(li.querySelector('[title="Restore"]')!);
    await waitFor(() => expect(alert).toHaveBeenCalledWith(SNAPSHOT_GONE_MESSAGE));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('a snapshot deleted elsewhere leaves the panel list (its restore button goes with it)', async () => {
    await db.versionSnapshots.add(snap('a', 'Stale', '<p>x</p>'));
    panel();
    await screen.findByText('Stale');
    await act(async () => { await db.versionSnapshots.delete('a'); });
    await waitFor(() => expect(screen.queryByText('Stale')).toBeNull());
  });
});
