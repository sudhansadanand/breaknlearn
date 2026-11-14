import { sqlContentRepo } from "./sql-repo";
import type { ContentRepo } from "./types";

let override: ContentRepo | null = null;

/** The content repository (SQL by default). */
export function contentRepo(): ContentRepo {
  return override ?? sqlContentRepo;
}

/** Test seam for route tests with in-memory fakes. */
export function setContentRepoForTesting(repo: ContentRepo | null): void {
  override = repo;
}
