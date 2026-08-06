import { eq } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { judge_scores } from '../schema.js';
import type { DbJudgeScore } from '../schema.js';

// ── Judge Scores ───────────────────────────────────────────────────────────

export async function insertJudgeScore(data: {
  runId: string; model: string; judgeModel: string;
  averageScore: number; summary: string; scoresJson: string; judgedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(judge_scores).values({
    run_id: data.runId, model: data.model, judge_model: data.judgeModel,
    average_score: data.averageScore, summary: data.summary,
    scores_json: data.scoresJson, judged_at: data.judgedAt,
  }).onConflictDoUpdate({
    target: [judge_scores.run_id, judge_scores.model],
    set: {
      judge_model: data.judgeModel,
      average_score: data.averageScore,
      summary: data.summary,
      scores_json: data.scoresJson,
      judged_at: data.judgedAt,
    },
  });
}

export async function listJudgeScores(runId?: string): Promise<DbJudgeScore[]> {
  const db = getDrizzleDb();
  const rows = runId
    ? await db.select().from(judge_scores).where(eq(judge_scores.run_id, runId))
    : await db.select().from(judge_scores);
  return rows as DbJudgeScore[];
}
