/**
 * A note-free handoff must not be byte-identical to a lost one (GH #1277).
 *
 * `computeHandoff` assigned `note` only when a note existed
 * (`if (options.note) { handoff.note = options.note }`), and `cleanHandoff`
 * strips the empty arrays around it, so what reached the consumer read as a
 * COMPLETE handoff. A session whose handoff was never written and a session
 * that simply recorded no note produced the same object. The human renderer
 * was silent for the same reason, so neither surface disclosed it.
 *
 * This is the third instance of the same family — #1243 (`cleo show` omitting
 * `description` entirely), #1242 (an undisclosed truncated page), now this.
 * Each was fixed at its producer and re-emerged elsewhere, which is why the
 * contract rule below matters more than the producer change: it makes the
 * absence a VIOLATION rather than a shape that merely happens to be right.
 *
 * @task T12159
 * @epic T12119
 */

import { describe, expect, it } from 'vitest';

describe('handoff note disclosure (GH #1277)', () => {
  describe('briefing contract — a handoff missing `note` is a violation', () => {
    it('emits a missing-key violation when lastSession.handoff omits note', async () => {
      const { assertBriefingContract } = await import('../briefing.js');

      const briefing = {
        lastSession: {
          endedAt: '2026-09-12T10:00:00.000Z',
          duration: 42,
          // The pre-fix shape: every array present, `note` simply absent.
          handoff: {
            lastTask: 'T001',
            tasksCompleted: ['T001'],
            tasksCreated: [],
            decisionsRecorded: 0,
            nextSuggested: [],
            openBlockers: [],
            openBugs: [],
          },
        },
        currentTask: null,
        nextTasks: [],
        openBugs: [],
        blockedTasks: [],
        activeEpics: [],
      };

      const violations = assertBriefingContract(briefing as never, {
        'lastSession.handoff': { requireKeys: ['note', 'nextAction'] },
      });

      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe('missing-key');
      expect(violations[0]?.field).toBe('lastSession.handoff');
      expect(violations[0]?.message).toContain('note');
      expect(violations[0]?.message).toContain('nextAction');
    });

    it('accepts an explicit null note — recorded-as-absent is disclosure, not omission', async () => {
      const { assertBriefingContract } = await import('../briefing.js');

      const briefing = {
        lastSession: {
          endedAt: '2026-09-12T10:00:00.000Z',
          handoff: {
            lastTask: 'T001',
            decisionsRecorded: 0,
            note: null,
            noteChars: 0,
            nextAction: null,
            nextActionChars: 0,
          },
        },
        currentTask: null,
        nextTasks: [],
        openBugs: [],
        blockedTasks: [],
        activeEpics: [],
      };

      const violations = assertBriefingContract(briefing as never, {
        'lastSession.handoff': { requireKeys: ['note', 'nextAction'] },
      });

      expect(violations).toHaveLength(0);
    });

    it('does not fire when there is no last session at all', async () => {
      const { assertBriefingContract } = await import('../briefing.js');

      const violations = assertBriefingContract(
        {
          lastSession: null,
          currentTask: null,
          nextTasks: [],
          openBugs: [],
          blockedTasks: [],
          activeEpics: [],
        } as never,
        { 'lastSession.handoff': { requireKeys: ['note', 'nextAction'] } },
      );

      // A fresh project has no handoff to be missing a key from. Firing here
      // would make the rule permanently red and therefore ignored.
      expect(violations).toHaveLength(0);
    });

    it('is wired into the DEFAULT contract, not only available to callers', async () => {
      const { getDefaultBriefingContract } = await import('../briefing.js');
      const required = getDefaultBriefingContract()['lastSession.handoff']?.requireKeys;
      expect(required).toContain('note');
      // GH #1277 — nextAction carries the identical defect; a rule that guards
      // one twin and not the other under-covers the object it names.
      expect(required).toContain('nextAction');
    });
  });

  describe('human renderer — silence is not an acceptable answer', () => {
    it('prints an explicit "(none recorded)" when no note was recorded', async () => {
      const { renderBriefing } = await import('../../render/session/briefing.js');

      const out = renderBriefing(
        {
          lastSession: {
            endedAt: '2026-09-12T10:00:00.000Z',
            handoff: {
              lastTask: 'T001',
              decisionsRecorded: 0,
              note: null,
              noteChars: 0,
              nextAction: null,
              nextActionChars: 0,
            },
          },
          nextTasks: [],
        },
        false,
      );

      expect(out).toContain('Note:');
      expect(out).toContain('(none recorded)');
    });

    it('still prints the note verbatim when one exists', async () => {
      const { renderBriefing } = await import('../../render/session/briefing.js');

      const out = renderBriefing(
        {
          lastSession: {
            endedAt: '2026-09-12T10:00:00.000Z',
            handoff: {
              lastTask: 'T001',
              decisionsRecorded: 0,
              note: 'left mid-merge',
              noteChars: 14,
            },
          },
          nextTasks: [],
        },
        false,
      );

      expect(out).toContain('left mid-merge');
      expect(out).not.toContain('(none recorded)');
    });
  });
});

describe('nextAction — the twin defect, fixed in the same change (GH #1277)', () => {
  it('flags a handoff that records note but omits nextAction', async () => {
    const { assertBriefingContract, getDefaultBriefingContract } = await import('../briefing.js');

    const violations = assertBriefingContract(
      {
        lastSession: {
          endedAt: '2026-09-12T10:00:00.000Z',
          // note disclosed, nextAction still omitted — a half-fix must not pass.
          handoff: { lastTask: 'T001', decisionsRecorded: 0, note: null, noteChars: 0 },
        },
        currentTask: null,
        nextTasks: [],
        openBugs: [],
        blockedTasks: [],
        activeEpics: [],
      } as never,
      getDefaultBriefingContract(),
    );

    const missing = violations.filter((v) => v.kind === 'missing-key');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('nextAction');
    expect(missing[0]?.message).not.toContain('note,');
  });

  it('renders an explicit "(none set)" when no next action was set', async () => {
    const { renderBriefing } = await import('../../render/session/briefing.js');

    const out = renderBriefing(
      {
        lastSession: {
          endedAt: '2026-09-12T10:00:00.000Z',
          handoff: {
            lastTask: 'T001',
            decisionsRecorded: 0,
            note: null,
            noteChars: 0,
            nextAction: null,
            nextActionChars: 0,
          },
        },
        nextTasks: [],
      },
      false,
    );

    expect(out).toContain('Next action:');
    expect(out).toContain('(none set)');
  });
});
