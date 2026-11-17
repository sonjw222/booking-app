import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUBSCRIPTION_MONTHLY_PRICE, SUBSCRIPTION_REVIEW_CENTER } from "../../nicepaySubscriptionReviewProtocol";
import { SUBSCRIPTION_REVIEW_EMAIL, SUBSCRIPTION_REVIEW_UID, type SubscriptionReviewPort } from "./subscriptionReview";

export function subscriptionReviewAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
}
export function subscriptionReviewBearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.length < 8192 ? /^Bearer ([^\s]+)$/.exec(value)?.[1] ?? null : null;
}
// Select-only port. No RPC, mutation, PG transport, or real-payment runtime is imported.
export function subscriptionReviewReadPort(admin: SupabaseClient): SubscriptionReviewPort {
  return {
    async authenticatedUid(token) {
      const { data, error } = await admin.auth.getUser(token);
      const u = data?.user;
      return !error && u?.id === SUBSCRIPTION_REVIEW_UID && u.email?.toLowerCase() === SUBSCRIPTION_REVIEW_EMAIL && u.email_confirmed_at ? u.id : null;
    },
    async eligibleOwner(uid) {
      if (uid !== SUBSCRIPTION_REVIEW_UID) return false;
      try {
        const { data, error } = await admin.auth.admin.getUserById(uid);
        const u = data?.user;
        if (error || u?.id !== uid || u.email?.toLowerCase() !== SUBSCRIPTION_REVIEW_EMAIL || !u.email_confirmed_at || (u.banned_until && Date.parse(u.banned_until) > Date.now())) return false;
        const { data: account, error: ae } = await admin.from("accounts")
          .select("id,nicepay_review_access,deactivated_at,merged_into").eq("auth_id", uid).maybeSingle();
        if (ae || !account || account.nicepay_review_access !== true || account.deactivated_at || account.merged_into) return false;
        const [{ data: membership, error: me }, { data: center, error: ce }, { data: sub, error: se }] = await Promise.all([
          admin.from("manager_centers").select("role_id").eq("account_id", account.id).eq("center_id", SUBSCRIPTION_REVIEW_CENTER).eq("status", "active").maybeSingle(),
          admin.from("centers").select("id,is_internal,status").eq("id", SUBSCRIPTION_REVIEW_CENTER).maybeSingle(),
          admin.from("center_subscriptions").select("plan_id,status,billing_review_override,billing_key,billing_customer_key,next_billing_date").eq("center_id", SUBSCRIPTION_REVIEW_CENTER).maybeSingle(),
        ]);
        if (me || ce || se || !membership?.role_id || center?.id !== SUBSCRIPTION_REVIEW_CENTER || center.is_internal !== true || !["pending", "approved"].includes(center.status)) return false;
        // The legacy Toss exception must remain explicitly OFF, even for this reviewer.
        if (!sub || sub.status !== "pending_billing_setup" || sub.billing_review_override !== false || sub.billing_key !== null || sub.billing_customer_key !== null || sub.next_billing_date !== null) return false;
        const [{ data: role, error: re }, { data: plan, error: pe }] = await Promise.all([
          admin.from("center_roles").select("is_owner,center_id").eq("id", membership.role_id).maybeSingle(),
          admin.from("subscription_plans").select("monthly_price,is_active").eq("id", sub.plan_id).maybeSingle(),
        ]);
        return !re && !pe && role?.is_owner === true && role.center_id === SUBSCRIPTION_REVIEW_CENTER && plan?.is_active === true && Number(plan.monthly_price) === SUBSCRIPTION_MONTHLY_PRICE;
      } catch { return false; }
    },
  };
}
