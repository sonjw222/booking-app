/*
  Production QA 센터/회원 bootstrap(재사용 가능한 기반, 개별 시나리오와 분리).
  - service_role admin client로 fixture만 준비한다. 앱 동작 검증(예약/취소 등)은 시나리오가 로그인 세션으로 실행한다.
  - 실제 센터/회원은 절대 수정하지 않는다: QA 센터는 이름으로만 찾고, 그 센터의 오너가 QA 매니저가 아니면 중단한다.
  - 기존 계정이 다른 센터와 관계를 갖고 있어도 삭제하지 않고 경고만 한다.
*/
import type { SupabaseClient } from "@supabase/supabase-js";
import { QA_CENTER_NAME } from "../runContext";

export type QaFixtureState = {
  centerId: string;
  managerAccountId: string;
  memberAccountId: string;
  memberProfileId: string;
};

function describe(table: string, e: { message: string; code?: string } | null | undefined): string {
  return `${table}: ${e?.message ?? "unknown"}${e?.code ? ` (${e.code})` : ""}`;
}

const MISSING_FLAG_HINT =
  "centers.is_internal 컬럼이 없습니다. QA 센터를 일반 사용자에게 숨기려면 먼저 add_internal_qa_center_flag.sql을 Production에 적용해야 합니다(이 runner는 SQL을 실행하지 않습니다).";

export async function ensureQaCenter(admin: SupabaseClient, managerAccountId: string): Promise<string> {
  const found = await admin
    .from("centers").select("id, status, is_internal, created_at").eq("name", QA_CENTER_NAME).order("created_at", { ascending: true });
  if (found.error) {
    if (found.error.code === "42703") throw new Error(MISSING_FLAG_HINT);
    throw new Error(`QA 센터 조회 실패 — ${describe("centers", found.error)}`);
  }

  let centerId: string;
  if (found.data && found.data.length > 0) {
    centerId = found.data[0].id as string;
    // 안전 확인: 이 센터의 활성 오너가 QA 매니저인지(아니면 실제 센터와 이름이 겹친 것일 수 있으니 건드리지 않는다)
    const owners = await admin
      .from("manager_centers").select("account_id, center_roles(is_owner)").eq("center_id", centerId).eq("status", "active");
    if (owners.error) throw new Error(`QA 센터 관리자 조회 실패 — ${describe("manager_centers", owners.error)}`);
    const ownerIds = (owners.data ?? []).filter((r: any) => r.center_roles?.is_owner).map((r: any) => r.account_id as string);
    if (ownerIds.length > 0 && !ownerIds.includes(managerAccountId)) {
      throw new Error("이름이 같은 센터의 오너가 QA 매니저가 아닙니다. 실제 센터일 수 있어 QA를 중단합니다(수정하지 않음).");
    }
  } else {
    const created = await admin
      .from("centers").insert({ name: QA_CENTER_NAME, status: "approved", is_internal: true }).select("id").single();
    if (created.error || !created.data) {
      if (created.error?.code === "42703") throw new Error(MISSING_FLAG_HINT);
      throw new Error(`QA 센터 생성 실패 — ${describe("centers", created.error)}`);
    }
    centerId = created.data.id as string;
  }

  // 항상 approved + internal 상태로 맞춘다(reserve_class 계열이 approved를 요구, 일반 사용자 공개는 is_internal로 차단)
  const upd = await admin.from("centers").update({ status: "approved", is_internal: true }).eq("id", centerId);
  if (upd.error) {
    if (upd.error.code === "42703") throw new Error(MISSING_FLAG_HINT);
    throw new Error(`QA 센터 상태 설정 실패 — ${describe("centers", upd.error)}`);
  }

  // 기존 owner role(센터 생성 시 만들어짐)을 그대로 사용한다 — 중복 생성하지 않는다.
  const role = await admin.from("center_roles").select("id").eq("center_id", centerId).eq("is_owner", true).limit(1).maybeSingle();
  if (role.error || !role.data) throw new Error(`QA 센터의 owner 역할을 찾지 못했습니다 — ${describe("center_roles", role.error)}`);

  const link = await admin
    .from("manager_centers").select("id, status").eq("center_id", centerId).eq("account_id", managerAccountId).limit(1).maybeSingle();
  if (link.error) throw new Error(`manager_centers 조회 실패 — ${describe("manager_centers", link.error)}`);
  if (!link.data) {
    const ins = await admin
      .from("manager_centers").insert({ account_id: managerAccountId, center_id: centerId, role_id: role.data.id, status: "active" });
    if (ins.error) throw new Error(`manager_centers 생성 실패 — ${describe("manager_centers", ins.error)}`);
  } else if (link.data.status !== "active") {
    const re = await admin.from("manager_centers").update({ status: "active", role_id: role.data.id }).eq("id", link.data.id);
    if (re.error) throw new Error(`manager_centers 활성화 실패 — ${describe("manager_centers", re.error)}`);
  }

  // 예약 정책을 테스트 친화적으로(일일 제한 없음). QA 센터 자신의 설정만 건드린다.
  await admin.from("center_settings").upsert(
    { center_id: centerId, daily_book_limit_enabled: false, daily_book_limit: null }, { onConflict: "center_id" });
  return centerId;
}

export async function ensureQaMember(admin: SupabaseClient, centerId: string, profileId: string): Promise<void> {
  const found = await admin.from("center_members").select("id").eq("center_id", centerId).eq("profile_id", profileId).limit(1).maybeSingle();
  if (found.error) throw new Error(`center_members 조회 실패 — ${describe("center_members", found.error)}`);
  if (found.data) return;
  const ins = await admin.from("center_members").insert({ center_id: centerId, profile_id: profileId, status: "active" });
  if (ins.error) throw new Error(`QA 회원 등록 실패 — ${describe("center_members", ins.error)}`);
}

// QA 계정이 QA 센터 밖의 센터와 관계가 있으면 경고 문구(센터 id 기준, 이름/연락처 없음)를 돌려준다. 삭제/수정하지 않는다.
export async function auditQaAccountRelations(
  admin: SupabaseClient, qaCenterId: string, ids: { managerAccountId: string; memberProfileId: string }
): Promise<string[]> {
  const warnings: string[] = [];
  const mc = await admin.from("manager_centers").select("center_id").eq("account_id", ids.managerAccountId);
  for (const r of mc.data ?? []) {
    if ((r as any).center_id !== qaCenterId) warnings.push(`QA 매니저가 다른 센터(${(r as any).center_id})의 관리자로 연결돼 있어요(자동 변경 안 함)`);
  }
  const cm = await admin.from("center_members").select("center_id").eq("profile_id", ids.memberProfileId);
  for (const r of cm.data ?? []) {
    if ((r as any).center_id !== qaCenterId) warnings.push(`QA 회원이 다른 센터(${(r as any).center_id})의 회원으로 등록돼 있어요(자동 변경 안 함)`);
  }
  return warnings;
}
