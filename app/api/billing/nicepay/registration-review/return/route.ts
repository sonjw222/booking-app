import { AUTH_RESPONSE_FIELDS } from "../../../../../../lib/payments/nicepaySubscriptionReviewProtocol";
import { registrationCredentials, subscriptionReviewSettings, verifyRegistrationReturn } from "../../../../../../lib/payments/server/nicepay/subscriptionReview";
import { subscriptionReviewAdmin, subscriptionReviewReadPort } from "../../../../../../lib/payments/server/nicepay/subscriptionReviewRuntime";
import { readReviewBody, registrationResult } from "../../../../../../lib/payments/server/nicepay/subscriptionReviewHttp";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const settings = subscriptionReviewSettings(process.env);
  if (!settings?.hostedEnabled) return registrationResult("disabled");
  // PG posts across origins, so do not require browser cookies/Origin. Verify signed state instead.
  const url = new URL(request.url), creds = registrationCredentials(process.env);
  if (url.origin !== settings.origin || !creds || [...url.searchParams.keys()].join() !== "rt") return registrationResult("invalid");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return registrationResult("invalid");
  const raw = await readReviewBody(request, 8192);
  if (raw === null) return registrationResult("invalid");
  try {
    const params = new URLSearchParams(raw), form: Record<string, string> = {};
    // Never copy CardNo, passwords, personal data, provider messages or arbitrary URLs.
    for (const key of AUTH_RESPONSE_FIELDS) {
      const values = params.getAll(key);
      if (values.length > 1 || values.some(v => v.length > 500)) return registrationResult("invalid");
      if (values.length === 1) form[key] = values[0];
    }
    const admin = subscriptionReviewAdmin();
    if (!admin) return registrationResult("invalid");
    return registrationResult(await verifyRegistrationReturn(form, url.searchParams.get("rt"), creds, subscriptionReviewReadPort(admin)));
  } catch { return registrationResult("invalid"); }
}
