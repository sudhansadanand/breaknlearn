import { catalogManifestHandler } from "../../../../../server/content/catalog";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PUBLIC_PUBLISHED: no auth, cacheable (ETag + public Cache-Control). */
export const GET = (req: Request) => handle((c) => catalogManifestHandler(req, c));
