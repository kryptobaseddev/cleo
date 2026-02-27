/**
 * Grade command - evaluate agent behavior for a completed session.
 *
 * Reads the audit log for the specified session and applies the
 * 5-dimension behavioral rubric to produce a score and diagnostic flags.
 *
 * Usage:
 *   ct grade <sessionId>      Grade a specific session
 *   ct grade --list           List all past grade results
 *
 * @task T4916
 */
import { Command } from 'commander';
import { cliOutput } from '../renderers/index.js';
import { gradeSession, readGrades } from '../../core/sessions/session-grade.js';

export function registerGradeCommand(program: Command): void {
  program
    .command('grade [sessionId]')
    .description('Grade agent behavior for a session (requires --grade flag on session start)')
    .option('--list', 'List all past grade results')
    .action(async (sessionId: string | undefined, opts: Record<string, unknown>) => {
      try {
        if (opts['list'] || !sessionId) {
          const grades = await readGrades();
          if (grades.length === 0) {
            cliOutput(
              {
                grades: [],
                message:
                  'No grade records found. Start a session with --grade flag to enable grading.',
              },
              { command: 'grade' },
            );
            return;
          }
          const summary = grades.map(g => ({
            sessionId: g.sessionId,
            score: `${g.totalScore}/${g.maxScore}`,
            percent: Math.round((g.totalScore / g.maxScore) * 100),
            timestamp: g.timestamp,
            flags: g.flags.length,
          }));
          cliOutput(
            { grades: summary, total: grades.length },
            { command: 'grade' },
          );
          return;
        }

        const result = await gradeSession(sessionId);
        const scorePercent = Math.round((result.totalScore / result.maxScore) * 100);
        const grade =
          scorePercent >= 90
            ? 'A'
            : scorePercent >= 75
              ? 'B'
              : scorePercent >= 60
                ? 'C'
                : scorePercent >= 45
                  ? 'D'
                  : 'F';

        cliOutput(
          {
            sessionId: result.sessionId,
            score: result.totalScore,
            maxScore: result.maxScore,
            percent: scorePercent,
            grade,
            dimensions: Object.entries(result.dimensions).map(([name, d]) => ({
              dimension: name,
              score: `${d.score}/${d.max}`,
              evidence: d.evidence,
            })),
            flags: result.flags,
            entryCount: result.entryCount,
            timestamp: result.timestamp,
          },
          {
            command: 'grade',
            message: `Session ${result.sessionId}: ${result.totalScore}/${result.maxScore} (${scorePercent}%) — Grade: ${grade}`,
          },
        );
      } catch (err) {
        cliOutput({ success: false, error: String(err) }, { command: 'grade' });
        process.exit(1);
      }
    });
}
