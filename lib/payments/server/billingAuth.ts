/*
  /api/billing/confirm 호출자 인증 + 센터 오너 확인(2026-10-08 보안 감사 P2).

  예전에는 body의 centerId/customerKey만 믿었다 — 공개된 센터 UUID와 임의 customerKey("center-<uuid>")로 발급받은 authKey만 있으면 누구나
  남의 센터 구독에 자기 카드의 billingKey를 붙이고 첫 결제를 진행시킬 수 있었다. 이제 Bearer 토큰(로그인 세션)을 서버에서 검증하고,
  그 사용자가 해당 센터의 활성 오너인지 DB 함수(is_center_owner — 호출자 JWT 기준 my_account_id())로 확인한 뒤에만 진행한다.
  body의 centerId는 "어느 센터를 말하는지"일 뿐 권한 근거가 아니다. 결제 provider/금액/PG 플래그 로직은 건드리지 않는다.
*/
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type BillingAuthDeps = {
  verifyToken(token: string): Promise<string | null>;                     // 유효한 로그인 세션이면 auth uid, 아니면 null
  isCenterOwner(token: string, centerId: string): Promise<boolean>;       // 호출자(JWT) 기준 활성 오너 여부
};
export type BillingAuthResult =
  | { ok: true; uid: string }
  | { ok: false; status: 401 | 403; code: "unauthenticated" | "not_center_owner"; error: string };

export async function authorizeBillingConfirm(token: string | null, centerId: string, deps: BillingAuthDeps): Promise<BillingAuthResult> {
  if (!token) return { ok: false, status: 401, code: "unauthenticated", error: "로그인이 필요해요" };
  let uid: string | null = null;
  try { uid = await deps.verifyToken(token); } catch { uid = null; }
  if (!uid) return { ok: false, status: 401, code: "unauthenticated", error: "로그인이 필요해요" };
  let owner = false;
  try { owner = await deps.isCenterOwner(token, centerId); } catch { owner = false; }   // 확인 실패는 거부(fail closed)
  if (!owner) return { ok: false, status: 403, code: "not_center_owner", error: "이 센터의 오너만 카드를 등록할 수 있어요" };
  return { ok: true, uid };
}

export function buildBillingAuthDeps(admin: SupabaseClient, supabaseUrl: string, anonKey: string): BillingAuthDeps {
  return {
    async verifyToken(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data?.user ? null : data.user.id;
    },
    async isCenterOwner(token, centerId) {
      // 호출자 JWT로 실행해야 my_account_id()가 호출자 계정(병합 계정 포함)으로 풀린다 — service_role로 호출하면 항상 false.
      const asUser = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data, error } = await asUser.rpc("is_center_owner", { p_center_id: centerId });
      if (error) throw new Error(error.message);
      return data === true;
    },
  };
}
