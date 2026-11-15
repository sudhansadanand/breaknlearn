import type { AssessmentRepo } from "./repo";
import { sqlAssessmentRepo } from "./sql-repo";

export type * from "./repo";

let override: AssessmentRepo | null = null;

/** Assessment data access; SQL by default, an in-memory fake in route tests. */
export function assessmentRepo(): AssessmentRepo {
  return override ?? sqlAssessmentRepo;
}

/** Test seam. */
export function setAssessmentRepoForTesting(repo: AssessmentRepo | null): void {
  override = repo;
}
