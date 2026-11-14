import * as answers from "../../src/app/api/v1/assessments/[attemptId]/answers/route";
import * as finish from "../../src/app/api/v1/assessments/[attemptId]/finish/route";
import * as due from "../../src/app/api/v1/assessments/due/route";
import * as start from "../../src/app/api/v1/assessments/start/route";

export const assessmentRoutes = { start, answers, finish, due };

export const attemptParams = (attemptId: string) => ({ params: Promise.resolve({ attemptId }) });
