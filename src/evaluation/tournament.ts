export interface TournamentModel {
  id: string;
  name: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
}

export interface MatchResult {
  winner: string | null;
  loser: string | null;
  isDraw: boolean;
  modelA: string;
  modelB: string;
  scoreA: number;
  scoreB: number;
}

const K_FACTOR = 32;
const DRAW_MARGIN = 5;

/**
 * Calculate new Elo ratings after a match between two models.
 * Uses standard Elo formula with K=32 and a draw margin of 5 points.
 */
export function calculateElo(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  scoreB: number,
): { newRatingA: number; newRatingB: number } {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;

  const diff = Math.abs(scoreA - scoreB);
  let actualA: number;
  let actualB: number;

  if (diff <= DRAW_MARGIN) {
    actualA = 0.5;
    actualB = 0.5;
  } else if (scoreA > scoreB) {
    actualA = 1;
    actualB = 0;
  } else {
    actualA = 0;
    actualB = 1;
  }

  return {
    newRatingA: Math.round(ratingA + K_FACTOR * (actualA - expectedA)),
    newRatingB: Math.round(ratingB + K_FACTOR * (actualB - expectedB)),
  };
}

/**
 * Run a round-robin tournament across a set of models.
 * Each pair plays one match. Returns updated model ratings.
 */
export function runTournament(
  models: TournamentModel[],
  results: MatchResult[],
): TournamentModel[] {
  const ratings = new Map<string, number>();
  for (const m of models) ratings.set(m.id, m.elo);

  for (const r of results) {
    const eloA = ratings.get(r.modelA) ?? 1200;
    const eloB = ratings.get(r.modelB) ?? 1200;
    const { newRatingA, newRatingB } = calculateElo(eloA, eloB, r.scoreA, r.scoreB);
    ratings.set(r.modelA, newRatingA);
    ratings.set(r.modelB, newRatingB);
  }

  return models.map((m) => {
    const modelResults = results.filter((r) => r.modelA === m.id || r.modelB === m.id);
    const wins = modelResults.filter((r) =>
      (r.modelA === m.id && r.winner === m.id) || (r.modelB === m.id && r.winner === m.id),
    ).length;
    const losses = modelResults.filter((r) =>
      (r.modelA === m.id && r.winner && r.winner !== m.id) || (r.modelB === m.id && r.winner && r.winner !== m.id),
    ).length;
    const draws = modelResults.filter((r) => r.isDraw).length;

    return {
      ...m,
      elo: ratings.get(m.id) ?? m.elo,
      wins,
      losses,
      draws,
      matches: modelResults.length,
    };
  });
}
