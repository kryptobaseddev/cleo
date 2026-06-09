/**
 * Tests for the pure Kanban board model + text renderer (T11934).
 *
 * Verifies the gateway rows → shared-lane bucketing → board model pipeline and
 * the plain-text render (the graceful-degrade fallback body). No pi-tui, no
 * gateway, no TTY required.
 *
 * @task T11934
 * @epic T11916
 */

import { describe, expect, it } from 'vitest';
import { buildKanbanBoard, renderKanbanBoardText, type TuiTaskRow } from '../kanban-board.js';

describe('buildKanbanBoard — lane bucketing via the shared SSoT (T11934)', () => {
  it('emits all seven lanes in canonical order even when empty', () => {
    const board = buildKanbanBoard([]);
    expect(board.columns.map((c) => c.lane)).toEqual([
      'backlog',
      'ready',
      'running',
      'review',
      'blocked',
      'done',
      'cancelled',
    ]);
    expect(board.total).toBe(0);
  });

  it('routes each status to the same lane the shared resolver picks', () => {
    const rows: TuiTaskRow[] = [
      { id: 'T1', status: 'cancelled' },
      { id: 'T2', status: 'done' },
      { id: 'T3', status: 'blocked' },
      {
        id: 'T4',
        status: 'active',
        gates: { implemented: true, testsPassed: true, qaPassed: true },
      },
      { id: 'T5', status: 'active' },
      { id: 'T6', status: 'pending', nextAction: 'spawn-worker' },
      { id: 'T7', status: 'pending' },
    ];
    const board = buildKanbanBoard(rows);
    const laneOf = (id: string) =>
      board.columns.find((c) => c.cards.some((card) => card.id === id))?.lane;

    expect(laneOf('T1')).toBe('cancelled');
    expect(laneOf('T2')).toBe('done');
    expect(laneOf('T3')).toBe('blocked');
    expect(laneOf('T4')).toBe('review');
    expect(laneOf('T5')).toBe('running');
    expect(laneOf('T6')).toBe('ready');
    expect(laneOf('T7')).toBe('backlog');
    expect(board.total).toBe(7);
  });

  it('drops archived/proposed rows before resolution', () => {
    const rows: TuiTaskRow[] = [
      { id: 'T1', status: 'archived' },
      { id: 'T2', status: 'proposed' },
      { id: 'T3', status: 'pending' },
    ];
    const board = buildKanbanBoard(rows);
    expect(board.total).toBe(1);
    expect(board.columns.find((c) => c.lane === 'backlog')?.count).toBe(1);
  });

  it('honours blockedBy + unmetDependsCount signals from the row', () => {
    const rows: TuiTaskRow[] = [
      { id: 'T1', status: 'pending', blockedBy: 'waiting for key' },
      { id: 'T2', status: 'pending', depends: ['T1'], unmetDependsCount: 1 },
    ];
    const board = buildKanbanBoard(rows);
    const blocked = board.columns.find((c) => c.lane === 'blocked');
    expect(blocked?.count).toBe(2);
  });

  it('defaults a missing status to backlog (never throws)', () => {
    const board = buildKanbanBoard([{ id: 'T1' }]);
    expect(board.columns.find((c) => c.lane === 'backlog')?.count).toBe(1);
  });

  it('projects epic/assignee/proof onto the card', () => {
    const board = buildKanbanBoard([
      {
        id: 'T1',
        title: 'Do thing',
        status: 'active',
        parentId: 'E9',
        assignee: 'pi-worker-1',
        proof: 'pr:1027',
      },
    ]);
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'T1');
    expect(card).toMatchObject({
      id: 'T1',
      title: 'Do thing',
      epic: 'E9',
      assignee: 'pi-worker-1',
      proof: 'pr:1027',
    });
  });
});

describe('renderKanbanBoardText — plain-text fallback body (T11934)', () => {
  it('renders a header line with the total and every lane label', () => {
    const board = buildKanbanBoard([{ id: 'T1', status: 'pending' }]);
    const lines = renderKanbanBoardText(board);
    expect(lines[0]).toContain('CLEO Cockpit');
    expect(lines[0]).toContain('1 task');
    const text = lines.join('\n');
    for (const label of ['Backlog', 'Ready', 'Running', 'Review', 'Blocked', 'Done', 'Cancelled']) {
      expect(text).toContain(label);
    }
  });

  it('shows the lane hint as the empty-state for an empty lane', () => {
    const lines = renderKanbanBoardText(buildKanbanBoard([]));
    expect(lines.join('\n')).toContain('Pending — not yet eligible to dispatch');
  });

  it('renders a card line with id + tags', () => {
    const board = buildKanbanBoard([
      { id: 'T42', title: 'Wire it', status: 'active', parentId: 'E1', proof: 'commit:abc' },
    ]);
    const cardLine = renderKanbanBoardText(board).find((l) => l.includes('T42'));
    expect(cardLine).toBeDefined();
    expect(cardLine).toContain('Wire it');
    expect(cardLine).toContain('epic:E1');
    expect(cardLine).toContain('proof:commit:abc');
  });

  it('caps cards per lane and reports the overflow', () => {
    const rows: TuiTaskRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `T${i}`,
      status: 'pending',
    }));
    const lines = renderKanbanBoardText(buildKanbanBoard(rows), { maxCardsPerLane: 2 });
    expect(lines.join('\n')).toContain('and 3 more');
  });
});
