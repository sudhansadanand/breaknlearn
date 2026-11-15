import type { LearningRepo } from "./repo";
import { sqlLearningRepo } from "./sql-repo";

export type * from "./repo";

let override: LearningRepo | null = null;

/** Learning data access; SQL by default, an in-memory fake in route tests. */
export function learningRepo(): LearningRepo {
  return override ?? sqlLearningRepo;
}

/** Test seam. */
export function setLearningRepoForTesting(repo: LearningRepo | null): void {
  override = repo;
}
