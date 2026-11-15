import { consentHandler, getConsentHandler } from "../../../../../server/handlers/admin";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Owner/guardian: consent per scope for the household and the current notice version. */
export const GET = (req: Request) => handle((c) => getConsentHandler(req, c));
/** Owner/guardian: grant or withdraw consent (CSRF, audited). */
export const POST = (req: Request) => handle((c) => consentHandler(req, c));
