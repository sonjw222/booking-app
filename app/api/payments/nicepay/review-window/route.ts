import { prepareReviewWindow, REVIEW_ORIGIN, reviewWindowConfig } from "../../../../../lib/payments/server/nicepay/reviewWindow";
import { reviewAdminClient, reviewBearer, reviewReadPort } from "../../../../../lib/payments/server/nicepay/reviewWindowRuntime";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
export async function POST(request: Request) {
  const config = reviewWindowConfig(process.env);
  if (!config) return json({ allowed: false }, 404);
  // Token-bearing requests from the existing app origin only; no cookie-based authorization.
  if (request.headers.get("origin") !== REVIEW_ORIGIN) return json({ allowed: false }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ allowed: false }, 413);
  const admin = reviewAdminClient();
  if (!admin) return json({ allowed: false }, 503);
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ allowed: false }, 413);
    const body = JSON.parse(raw) as { productId?: unknown; action?: unknown };
    if (!body || (body.action !== "check" && body.action !== "open")) return json({ allowed: false }, 400);
    const result = await prepareReviewWindow({ token: reviewBearer(request), productId: body.productId, open: body.action === "open" }, config, reviewReadPort(admin));
    return result ? json(result) : json({ allowed: false }, 403);
  } catch { return json({ allowed: false }, 400); }
}
