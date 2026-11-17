import { readNicepayForm } from "../../../../../../lib/payments/server/nicepay/formBody";
import { finishReviewWindow, REVIEW_ORIGIN, reviewWindowConfig } from "../../../../../../lib/payments/server/nicepay/reviewWindow";
import { reviewAdminClient, reviewReadPort } from "../../../../../../lib/payments/server/nicepay/reviewWindowRuntime";

export async function POST(request: Request) {
  let location = `${REVIEW_ORIGIN}/api/payments/nicepay/review-window/result`;
  const c = reviewWindowConfig(process.env);
  const admin = c ? reviewAdminClient() : null;
  if (c && admin) {
    try { location = await finishReviewWindow(await readNicepayForm(request), new URL(request.url).searchParams.get("rt"), c, reviewReadPort(admin)); } catch { /* Never fall back to the approval handler. */ }
  }
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
