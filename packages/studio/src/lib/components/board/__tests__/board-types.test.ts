/**
 * Tests for T11927 — the generic Board bucketing helper.
 *
 * `bucketBoardCards` is the pure routing core of `Board.svelte`. Verifies the
 * OCP contract: arbitrary lanes, stable order, empty lanes preserved, and
 * unknown-lane cards dropped defensively.
 *
 * @task T11927
 * @epic T11559
 */

import { describe, expect, it } from 'vitest';
import { type BoardCard, type BoardLane, bucketBoardCards } from '../board-types.js';

const LANES: BoardLane[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];

function card(id: string, lane: string): BoardCard & { lane: string } {
  return { id, title: `Task ${id}`, status: 'pending', priority: 'medium', lane };
}

const resolver = (c: BoardCard): string => (c as BoardCard & { lane?: string }).lane ?? 'todo';

describe('bucketBoardCards (T11927)', () => {
  it('routes each card to its resolved lane', () => {
    const cards = [card('T1', 'todo'), card('T2', 'doing'), card('T3', 'done')];
    const cols = bucketBoardCards(cards, LANES, resolver);
    expect(cols.map((c) => c.lane.id)).toEqual(['todo', 'doing', 'done']);
    expect(cols[0].cards.map((c) => c.id)).toEqual(['T1']);
    expect(cols[1].cards.map((c) => c.id)).toEqual(['T2']);
    expect(cols[2].cards.map((c) => c.id)).toEqual(['T3']);
  });

  it('produces a column for every lane even when empty', () => {
    const cols = bucketBoardCards([card('T1', 'todo')], LANES, resolver);
    expect(cols).toHaveLength(3);
    expect(cols[1].count).toBe(0);
    expect(cols[1].cards).toEqual([]);
  });

  it('preserves input order within a lane', () => {
    const cards = [card('T3', 'todo'), card('T1', 'todo'), card('T2', 'todo')];
    const cols = bucketBoardCards(cards, LANES, resolver);
    expect(cols[0].cards.map((c) => c.id)).toEqual(['T3', 'T1', 'T2']);
  });

  it('drops cards whose resolved lane is not in the lane set (defensive)', () => {
    const cards = [card('T1', 'todo'), card('T9', 'nonexistent-lane')];
    const cols = bucketBoardCards(cards, LANES, resolver);
    const allRouted = cols.flatMap((c) => c.cards.map((x) => x.id));
    expect(allRouted).toEqual(['T1']);
  });

  it('computes count equal to the lane card length', () => {
    const cards = [card('T1', 'doing'), card('T2', 'doing')];
    const cols = bucketBoardCards(cards, LANES, resolver);
    const doing = cols.find((c) => c.lane.id === 'doing');
    expect(doing?.count).toBe(2);
  });

  it('honours arbitrary lane taxonomies (OCP — open for extension)', () => {
    const customLanes: BoardLane[] = [
      { id: 'alpha', label: 'Alpha' },
      { id: 'omega', label: 'Omega' },
    ];
    const cards = [card('T1', 'omega'), card('T2', 'alpha')];
    const cols = bucketBoardCards(cards, customLanes, resolver);
    expect(cols.map((c) => c.lane.id)).toEqual(['alpha', 'omega']);
    expect(cols.find((c) => c.lane.id === 'omega')?.cards.map((c) => c.id)).toEqual(['T1']);
  });
});
