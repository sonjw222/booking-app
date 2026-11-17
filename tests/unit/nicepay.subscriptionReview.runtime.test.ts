import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subscriptionReviewReadPort } from "../../lib/payments/server/nicepay/subscriptionReviewRuntime";
import { SUBSCRIPTION_REVIEW_EMAIL, SUBSCRIPTION_REVIEW_UID } from "../../lib/payments/server/nicepay/subscriptionReview";
import { SUBSCRIPTION_REVIEW_CENTER } from "../../lib/payments/nicepaySubscriptionReviewProtocol";

let rows: Record<string, Record<string, unknown>>, user: Record<string, unknown>;
const reads: { table: string; filters: [string, unknown][] }[] = [];
const admin = {
  auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })), admin: { getUserById: vi.fn(async () => ({ data: { user }, error: null })) } },
  from(table: string) {
    const read = { table, filters: [] as [string, unknown][] }; reads.push(read);
    const query = { select: () => query, eq: (key: string, value: unknown) => { read.filters.push([key, value]); return query; }, maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) };
    return query;
  },
};
beforeEach(() => {
  vi.clearAllMocks(); reads.length = 0;
  user = { id: SUBSCRIPTION_REVIEW_UID, email: SUBSCRIPTION_REVIEW_EMAIL, email_confirmed_at: "2026-11-01" };
  rows = {
    accounts: { id: "review-account", nicepay_review_access: true, deactivated_at: null, merged_into: null },
    manager_centers: { role_id: "owner-role" }, centers: { id: SUBSCRIPTION_REVIEW_CENTER, is_internal: true, status: "pending" },
    center_subscriptions: { plan_id: "review-plan", status: "pending_billing_setup", billing_review_override: false, billing_key: null, billing_customer_key: null, next_billing_date: null },
    center_roles: { center_id: SUBSCRIPTION_REVIEW_CENTER, is_owner: true }, subscription_plans: { is_active: true, monthly_price: 39000 },
  };
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
const port = () => subscriptionReviewReadPort(admin as unknown as SupabaseClient);
describe("read-only reviewer/owner eligibility adapter", () => {
  it("requires Auth server verification and rechecks all scoped rows", async () => {
    expect(await port().authenticatedUid("fixture-jwt")).toBe(SUBSCRIPTION_REVIEW_UID);
    expect(admin.auth.getUser).toHaveBeenCalledWith("fixture-jwt");
    expect(await port().eligibleOwner(SUBSCRIPTION_REVIEW_UID)).toBe(true);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledWith(SUBSCRIPTION_REVIEW_UID);
    for (const table of ["manager_centers", "center_subscriptions"]) expect(reads.find(r => r.table === table)?.filters).toContainEqual(["center_id", SUBSCRIPTION_REVIEW_CENTER]);
    expect(reads.find(r => r.table === "manager_centers")?.filters).toContainEqual(["status", "active"]);
    expect(reads.find(r => r.table === "center_roles")?.filters).toContainEqual(["id", "owner-role"]);
  });
  it.each([
    ["accounts", "nicepay_review_access", false], ["accounts", "deactivated_at", "2026-11-09"], ["accounts", "merged_into", "other"],
    ["centers", "is_internal", false], ["centers", "id", "other"], ["centers", "status", "rejected"], ["manager_centers", "role_id", null],
    ["center_roles", "is_owner", false], ["center_roles", "center_id", "other"], ["subscription_plans", "monthly_price", 1000], ["subscription_plans", "is_active", false],
    ["center_subscriptions", "status", "active"], ["center_subscriptions", "billing_review_override", true], ["center_subscriptions", "billing_review_override", null],
    ["center_subscriptions", "billing_key", "legacy-toss-key"], ["center_subscriptions", "billing_customer_key", "legacy-customer"], ["center_subscriptions", "next_billing_date", "2026-12-09"],
  ])("denies unsafe %s.%s", async (table, key, value) => { rows[table as string][key as string] = value; expect(await port().eligibleOwner(SUBSCRIPTION_REVIEW_UID)).toBe(false); });
  it("denies anonymous, foreign/unconfirmed/banned users and missing rows", async () => {
    expect(await port().eligibleOwner("other")).toBe(false); expect(reads).toHaveLength(0);
    user.email = "other@example.test"; expect(await port().authenticatedUid("jwt")).toBeNull(); expect(await port().eligibleOwner(SUBSCRIPTION_REVIEW_UID)).toBe(false);
    user.email = SUBSCRIPTION_REVIEW_EMAIL; user.email_confirmed_at = null; expect(await port().authenticatedUid("jwt")).toBeNull();
    user.email_confirmed_at = "2026-11-01"; user.banned_until = "2999-01-01"; expect(await port().eligibleOwner(SUBSCRIPTION_REVIEW_UID)).toBe(false);
    delete user.banned_until; delete rows.center_subscriptions; expect(await port().eligibleOwner(SUBSCRIPTION_REVIEW_UID)).toBe(false);
  });
  it("fails closed when a database read throws", async () => {
    const broken = { ...admin, from: () => { throw new Error("read unavailable"); } };
    expect(await subscriptionReviewReadPort(broken as unknown as SupabaseClient).eligibleOwner(SUBSCRIPTION_REVIEW_UID)).toBe(false);
  });
});
