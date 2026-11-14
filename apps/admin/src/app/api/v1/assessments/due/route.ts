import { dueReviewsHandler } from "../../../../../server/assessment/handlers";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PAIRED_DEVICE: gentle, optional delayed reviews due for one learner of the household. */
export const GET = (req: Request) => handle((c) => dueReviewsHandler(req, c));
