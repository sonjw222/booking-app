import { authorizeSubscriptionReview, prepareRegistration, registrationCredentials, REVIEW_CAPABILITIES, subscriptionReviewSettings } from "../../../../../lib/payments/server/nicepay/subscriptionReview";
import { subscriptionReviewAdmin, subscriptionReviewBearer, subscriptionReviewReadPort } from "../../../../../lib/payments/server/nicepay/subscriptionReviewRuntime";
import { readReviewBody, reviewJson } from "../../../../../lib/payments/server/nicepay/subscriptionReviewHttp";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const settings = subscriptionReviewSettings(process.env);
  if (!settings) return reviewJson({ allowed: false, code: "review_disabled" }, 404);
  if (request.headers.get("origin") !== settings.origin || new URL(request.url).origin !== settings.origin) return reviewJson({ allowed: false }, 403);
  const token = subscriptionReviewBearer(request);
  if (!token) return reviewJson({ allowed: false }, 401);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reviewJson({ allowed: false }, 415);
  const raw = await readReviewBody(request, 1024);
  if (raw === null) return reviewJson({ allowed: false }, 413);
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join() !== "action,centerId" || !["check", "open"].includes(String(body.action))) return reviewJson({ allowed: false }, 400);
    const admin = subscriptionReviewAdmin();
    if (!admin) return reviewJson({ allowed: false }, 503);
    if (!(await authorizeSubscriptionReview(token, body.centerId, subscriptionReviewReadPort(admin)))) return reviewJson({ allowed: false }, 403);
    const creds = settings.hostedEnabled ? registrationCredentials(process.env) : null;
    const hostedAvailable = settings.hostedEnabled && !!creds;
    if (body.action === "check") return reviewJson({ allowed: true, ...REVIEW_CAPABILITIES, hostedAvailable });
    if (!creds || !hostedAvailable) return reviewJson({ allowed: true, ...REVIEW_CAPABILITIES, hostedAvailable: false, code: "hosted_review_disabled" }, 423);
    return reviewJson({ allowed: true, ...REVIEW_CAPABILITIES, hostedAvailable, params: prepareRegistration(settings, creds) });
  } catch { return reviewJson({ allowed: false }, 400); }
}
