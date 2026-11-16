import { registrationResult } from "../../../../../../lib/payments/server/nicepay/subscriptionReviewHttp";

// Desktop SDK close destination. Query strings cannot claim success or select a redirect.
export async function GET() { return registrationResult("closed"); }
