import { handle } from "../../../../../../server/http";
import { createDeletionRequestHandler, listDeletionRequestsHandler } from "../../../../../../server/privacy/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Owner/guardian: the household's deletion requests and their status. */
export const GET = (req: Request) => handle((c) => listDeletionRequestsHandler(req, c));
/** Owner only (CSRF, explicit confirmation): queue a deletion for the next nightly job run. */
export const POST = (req: Request) => handle((c) => createDeletionRequestHandler(req, c));
