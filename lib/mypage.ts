/*
  마이페이지 데이터 함수
  - 프로필, 수강권(잔여/유효기간), 예약내역, 출석기록 조회
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";
import { disableNativePush } from "./nativePush";

export type Profile = { name: string; phone: string | null; isMember: boolean; isManager: boolean; isPlatformAdmin: boolean };

export type Membership = {
  id: string;
  centerId: string;
  productId: string | null;
  kind: "pass" | "goods";
  unlimited: boolean;
  centerName: string;
  productName: string;
  totalCount: number;
  remainingCount: number;
  expiresAt: string | null; // "2026-10-31", null = 기간 무제한
  startsAt: string | null; // "2026-06-01" — DB는 NOT NULL(기본 구매일)이라 실제로 null은 안 오지만 방어적으로 nullable로 둠. rolling_month 상품이 다음 달로 넘어간 경우에만 미래 날짜(2026-09-10 QA로 starts_at이 기존 schema.sql 컬럼 재사용임을 확인, add_rolling_month_product_expiry.sql 참고)
  createdAt: string; // 구매 시각 (환불 24시간 판단용)
  profileName: string; // 어느 프로필 것인지 (대표면 "")
  // schema.sql: active(사용중)/expired(만료)/paused(정지)/refunded(환불)/transferred(양도).
  // 릴리스 폴리시 배치 6차(2026-09-15) — 마이페이지 정렬/CTA 정책(classifyMembershipDisplay)이
  // "정지중" 티어를 구분하려면 필요해서 새로 select에 추가(새 DB 값을 만든 게 아니라
  // 기존 컬럼을 처음으로 화면까지 가져온 것). refunded는 이 목록 쿼리 자체가 이미
  // .neq("status","refunded")로 제외하므로 여기 값으로는 절대 안 옴.
  status: string;
};

export type MembershipDisplayTier = 0 | 1 | 2 | 3; // 0=활성, 1=시작 예정, 2=정지중(사용 가능), 3=만료/소진(항상 마지막)

// 실기기 QA(2026-09-15) — 마이페이지 수강권 목록이 만료일 오름차순으로만 정렬돼(원래
// fetchMyPage()의 DB 쿼리가 order("expires_at", ascending:true)) 이미 만료된 수강권
// (오래된 expires_at = 정렬상 가장 앞)이 실제 예약에 쓸 수 있는 수강권보다 위에
// 뜨는 문제가 있었다. 활성 → 시작 예정 → 정지중(아직 사용 가능) → 만료/소진(항상
// 마지막) 순으로 재배치한다. 새 DB 상태값을 만들지 않고 schema.sql의 기존 enum만
// 쓴다. 정렬뿐 아니라 카드 CTA 판단(item 8)도 이 분류를 그대로 재사용해야 하므로
// display 전용이 아닌 데이터 계층(이 파일)의 순수 함수로 둔다.
export function classifyMembershipDisplay(
  m: Pick<Membership, "unlimited" | "remainingCount" | "expiresAt" | "startsAt" | "status">,
  todayStr: string = new Date().toISOString().slice(0, 10),
): { tier: MembershipDisplayTier; isExpired: boolean; isExhausted: boolean; isPending: boolean; isPaused: boolean } {
  const isExpired = !m.unlimited && m.expiresAt != null && m.expiresAt < todayStr;
  const isExhausted = !m.unlimited && m.remainingCount != null && m.remainingCount <= 0;
  const isPending = !!m.startsAt && m.startsAt > todayStr;
  const isPaused = m.status === "paused";

  let tier: MembershipDisplayTier;
  if (isExpired || isExhausted) tier = 3;
  else if (isPaused) tier = 2;
  else if (isPending) tier = 1;
  else tier = 0;

  return { tier, isExpired, isExhausted, isPending, isPaused };
}

// 같은 tier 안에서는 기존과 동일하게 만료 임박(expires_at 오름차순) 우선 순으로 유지 —
// unlimited(만료일 없음)는 비교할 날짜가 없으므로 같은 tier 안에서 맨 뒤로 보낸다.
export function sortMembershipsForDisplay<T extends Pick<Membership, "unlimited" | "remainingCount" | "expiresAt" | "startsAt" | "status">>(
  memberships: T[],
  todayStr?: string,
): T[] {
  return [...memberships].sort((a, b) => {
    const ta = classifyMembershipDisplay(a, todayStr).tier;
    const tb = classifyMembershipDisplay(b, todayStr).tier;
    if (ta !== tb) return ta - tb;
    if (a.expiresAt == null && b.expiresAt == null) return 0;
    if (a.expiresAt == null) return 1;
    if (b.expiresAt == null) return -1;
    return a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0;
  });
}

export type HistoryItem = {
  id: string;
  title: string;
  centerName: string;
  when: string; // "2026-07-14 20:00" (KST 표시용, 화면 렌더링 전용)
  startAt: string | null; // classes.start_time 원본 ISO(timestamptz) — 미래/과거 판정은 반드시 이 값으로 한다(when은 KST 포맷 문자열이라 비교에 부적합)
  status: "confirmed" | "waitlisted" | "cancelled" | "attended" | "no_show";
  profileName: string; // 어느 프로필 것인지 (대표면 "")
  // "MEMBER" | "ADMIN_ASSIGNMENT" | "ADMIN_FREE" — 회원 화면에는 lib/reservationTypes.ts의
  // memberFacingBadge()로만 노출 (무료배치 여부/사유/관리자명 등 내부 정보는 절대 포함하지 않음)
  reservationType: string;
  // NOTIF-001 E-5: 'HOLIDAY'면 "센터 휴무로 자동 취소" 배지 표시. cancel_source가 없는(구
  // 데이터/다른 취소 경로) 예약은 null.
  cancelSource: string | null;
};

const KST_DT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function fmtDateTime(iso: string) {
  // KST_DT 원본 출력은 "2026. 08. 07. 21:00"(점 3개) 형태라, 무조건 ". "을 전부 "-"로
  // 바꾸면 날짜-시간 구분자까지 "-"가 돼버려 "2026-08-07-21:00"이 나온다(공백이어야 함,
  // 이 파일의 when 타입 주석과 splitWhen()이 기대하는 형식이 깨짐). 날짜 3부분만 "-"로
  // 잇고 마지막 구분자는 공백으로 남긴다.
  return KST_DT.format(new Date(iso)).replace(/^(\d{4})\. (\d{2})\. (\d{2})\. (\d{2}:\d{2})$/, "$1-$2-$3 $4");
}

async function getMyContext(): Promise<{ accountId: string; profileId: string; name: string; phone: string | null; isMember: boolean; isManager: boolean; isPlatformAdmin: boolean }> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");
  const { data: acc, error: accErr } = await supabase
    .from("accounts").select("id, name, phone, is_member, is_platform_admin")
    .eq("id", accountId).single();
  if (accErr || !acc) throw new Error("계정 정보를 찾을 수 없어요");
  // ACL-005: "관리자 모드로 전환" 노출 조건은 /manager 진입 조건(lib/manager.ts의
  // getMyAccountId())과 반드시 같은 기준을 써야 한다 — accounts.is_manager 플래그가
  // 아니라 실제 active manager_centers 소속 존재 여부로 판단한다.
  const { count: managerCenterCount } = await supabase
    .from("manager_centers")
    .select("id", { count: "exact", head: true })
    .eq("account_id", acc.id)
    .eq("status", "active");
  const isManager = (managerCenterCount ?? 0) > 0;
  // 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 사용
  // (대표 프로필이 없거나 2개 이상이면 single() 이 실패하므로 방어)
  const { data: profs, error: profErr } = await supabase
    .from("profiles").select("id, is_primary, created_at")
    .eq("account_id", acc.id)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const prof = profs?.[0];
  if (profErr) throw new Error("프로필을 불러오지 못했어요: " + profErr.message);
  if (!prof) throw new Error("프로필이 없어요. 관리자에게 문의하거나 다시 가입해주세요.");
  return { accountId: acc.id, profileId: prof.id, name: acc.name, phone: acc.phone, isMember: acc.is_member, isManager, isPlatformAdmin: acc.is_platform_admin ?? false };
}

// "내 정보 관리"(app/mypage/info) 조회 전용 — getMyContext()는 manager_centers/profiles까지
// 같이 조회해 무겁다. 이름/휴대폰번호만 필요한 화면이라 계정 행 하나만 가볍게 가져온다.
export async function fetchMyAccountInfo(): Promise<{ name: string; phone: string | null; marketingConsent: boolean }> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");
  const { data: acc, error } = await supabase
    .from("accounts").select("name, phone, marketing_consent")
    .eq("id", accountId).single();
  if (error || !acc) throw new Error("계정 정보를 찾을 수 없어요");
  return { name: acc.name, phone: acc.phone, marketingConsent: !!(acc as any).marketing_consent };
}

// 마케팅 정보 수신 동의를 나중에 켜거나 끈다(철회 포함) — marketing_consent_at은
// 값이 바뀔 때마다 "지금"으로 갱신되므로, 동의 시각뿐 아니라 철회 시각도 이 한 컬럼으로
// 증빙된다(add_marketing_consent.sql 참고). RLS의 기존 "본인 계정 수정" 정책이 본인
// auth_id만 통과시키므로 다른 계정의 동의 상태는 이 함수로도 바꿀 수 없다.
export async function setMyMarketingConsent(consent: boolean): Promise<void> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");
  const { error } = await supabase
    .from("accounts")
    .update({ marketing_consent: consent, marketing_consent_at: new Date().toISOString() })
    .eq("id", accountId);
  if (error) throw new Error("마케팅 동의 설정을 저장하지 못했어요: " + error.message);
}

export async function fetchMyPage() {
  const me = await getMyContext();

  // 내 모든 프로필 (대표 + 자녀 등 추가 프로필)
  const { data: profRows } = await supabase
    .from("profiles")
    .select("id, name, nickname, label, is_primary")
    .eq("account_id", me.accountId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false });
  const profiles = profRows ?? [];
  const profileIds = profiles.map((p: any) => p.id);
  const hasMultiple = profiles.length > 1;
  // 프로필 id → 표시 이름. 프로필이 여러 개면 대표도 이름 표시(어느 프로필인지 구분 필요)
  const profileLabel: Record<string, string> = {};
  for (const p of profiles) {
    const nm = (p as any).nickname || (p as any).name;
    if (!hasMultiple) {
      profileLabel[(p as any).id] = "";   // 프로필 하나면 태그 불필요
    } else {
      profileLabel[(p as any).id] = (p as any).label ? `${nm} · ${(p as any).label}` : nm;
    }
  }

  // 수강권 + 상품 (모든 프로필)
  const { data: memRows, error: memErr } = await supabase
    .from("memberships")
    .select("id, profile_id, bound_profile_id, center_id, product_id, product_name, total_count, remaining_count, expires_at, starts_at, created_at, status, centers(name), products(product_kind, unlimited)")
    .in("profile_id", profileIds)
    .neq("status", "refunded")
    .order("expires_at", { ascending: true });
  if (memErr) throw new Error("수강권을 불러오지 못했어요: " + memErr.message);

  // 다 쓴 수강권은 "마지막 예약 수업이 끝난 뒤"에 숨김
  //   → 0회여도 앞으로 들을 수업이 남아 있으면 계속 보여야 함
  const memIds = (memRows ?? []).map((m: any) => m.id);
  const lastClassEnd: Record<string, string> = {};
  if (memIds.length > 0) {
    const { data: resvForMem } = await supabase
      .from("reservations")
      .select("membership_id, classes(end_time)")
      .in("membership_id", memIds)
      .in("status", ["confirmed", "waitlisted", "attended"]);
    for (const r of resvForMem ?? []) {
      const mid = (r as any).membership_id;
      const end = (r as any).classes?.end_time;
      if (!mid || !end) continue;
      if (!lastClassEnd[mid] || end > lastClassEnd[mid]) lastClassEnd[mid] = end;
    }
  }
  const nowIso = new Date().toISOString();

  const memberships: Membership[] = (memRows ?? [])
    .filter((m: any) => {
      const unlimited = m.products?.unlimited ?? false;
      if (unlimited) return true;
      const remain = m.remaining_count;
      if (remain == null || remain > 0) return true;   // 아직 횟수 남음 → 표시
      // 0회 소진: 마지막 예약 수업이 아직 안 지났으면 표시
      const last = lastClassEnd[m.id];
      if (last && last > nowIso) return true;
      return false;                                     // 다 쓰고 수업도 끝남 → 숨김
    })
    .map((m: any) => ({
      id: m.id,
      centerId: m.center_id,
      productId: m.product_id ?? null,
      kind: m.products?.product_kind === "goods" ? "goods" : "pass",
      unlimited: m.products?.unlimited ?? false,
      centerName: m.centers?.name ?? "",
      productName: m.product_name,
      totalCount: m.total_count,
      remainingCount: m.remaining_count,
      expiresAt: m.expires_at,
      startsAt: m.starts_at ?? null,
      createdAt: m.created_at,
      profileName: m.bound_profile_id ? (profileLabel[m.bound_profile_id] ?? "") : "",
      status: m.status,
    }));

  const profile: Profile = { name: me.name, phone: me.phone, isMember: me.isMember, isManager: me.isManager, isPlatformAdmin: me.isPlatformAdmin };

  // 예약내역(history)은 이 함수 반환값에서 제외 — app/mypage/page.tsx는 이 값을 화면에
  // 전혀 렌더링하지 않는데도(예약 내역은 /my-reservations 링크로만 안내) 매번 예약
  // 최근 50건 + classes/centers 2단 조인을 통째로 받아오고 있었다(egress 감사,
  // 2026-09-15). 예약 내역이 실제로 필요한 화면(app/my-reservations/page.tsx)은
  // fetchMyReservationHistory()를 대신 쓴다 — 계정당 두 화면을 오가도 이 무거운 조인이
  // 중복으로 두 번 불려나가지 않는다.
  return { profile, memberships: sortMembershipsForDisplay(memberships) };
}

export type RepurchaseAvailability = { centerActive: boolean; productPurchasable: boolean };

// 릴리스 폴리시 배치 6차(2026-09-15, item 8) — 만료/소진된 수강권 카드의 CTA 우선순위
// (1순위 "다시 구매하기" → 2순위 "센터 문의하기" → 3순위 CTA 없음)를 정하려면 그
// 수강권을 살 당시의 센터/상품이 "지금도" 유효한지 알아야 한다. fetchMyPage()가 매번
// 이걸 같이 조회하면 활성 수강권만 있는(=대다수) 사용자에게도 불필요한 조회가
// 붙으므로, 만료/소진된 pass만 화면에서 골라 별도로 호출한다(app/mypage/page.tsx).
export async function fetchRepurchaseAvailability(
  memberships: Pick<Membership, "id" | "centerId" | "productId">[],
): Promise<Record<string, RepurchaseAvailability>> {
  const result: Record<string, RepurchaseAvailability> = {};
  if (memberships.length === 0) return result;

  const centerIds = Array.from(new Set(memberships.map((m) => m.centerId)));
  const productIds = Array.from(new Set(memberships.map((m) => m.productId).filter((id): id is string => !!id)));

  const [{ data: centers, error: centerErr }, { data: products, error: productErr }] = await Promise.all([
    supabase.from("centers").select("id, status").in("id", centerIds),
    productIds.length > 0
      ? supabase.from("products").select("id, is_active, is_on_sale").in("id", productIds)
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);
  if (centerErr) throw new Error("센터 상태를 확인하지 못했어요: " + centerErr.message);
  if (productErr) throw new Error("상품 상태를 확인하지 못했어요: " + productErr.message);

  const centerActiveMap: Record<string, boolean> = {};
  for (const c of centers ?? []) centerActiveMap[(c as any).id] = (c as any).status === "approved";

  const productPurchasableMap: Record<string, boolean> = {};
  for (const p of products ?? []) productPurchasableMap[(p as any).id] = !!(p as any).is_active && !!(p as any).is_on_sale;

  for (const m of memberships) {
    result[m.id] = {
      centerActive: centerActiveMap[m.centerId] ?? false,
      productPurchasable: m.productId ? (productPurchasableMap[m.productId] ?? false) : false,
    };
  }
  return result;
}

// "내 예약"(app/my-reservations) 전용 — fetchMyPage()의 프로필/수강권 조회(accounts,
// manager_centers count, memberships+centers/products 조인)는 이 화면에서 안 쓰므로
// 예약내역에 필요한 프로필 id만 가볍게 조회한다.
export async function fetchMyReservationHistory(): Promise<HistoryItem[]> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");

  const { data: profRows, error: profErr } = await supabase
    .from("profiles")
    .select("id, name, nickname, label, is_primary")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false });
  if (profErr) throw new Error("프로필을 불러오지 못했어요: " + profErr.message);
  const profiles = profRows ?? [];
  const profileIds = profiles.map((p: any) => p.id);
  if (profileIds.length === 0) return [];
  const hasMultiple = profiles.length > 1;
  const profileLabel: Record<string, string> = {};
  for (const p of profiles) {
    const nm = (p as any).nickname || (p as any).name;
    profileLabel[(p as any).id] = !hasMultiple ? "" : ((p as any).label ? `${nm} · ${(p as any).label}` : nm);
  }

  const { data: resRows, error: resErr } = await supabase
    .from("reservations")
    .select("id, profile_id, status, reservation_type, cancel_source, created_at, classes(title, start_time, centers(name))")
    .in("profile_id", profileIds)
    .order("created_at", { ascending: false })
    .limit(50);
  if (resErr) throw new Error("예약내역을 불러오지 못했어요: " + resErr.message);

  return (resRows ?? []).map((r: any) => ({
    id: r.id,
    title: r.classes?.title ?? "",
    centerName: r.classes?.centers?.name ?? "",
    when: r.classes?.start_time ? fmtDateTime(r.classes.start_time) : "",
    startAt: r.classes?.start_time ?? null,
    status: r.status,
    profileName: profileLabel[r.profile_id] ?? "",
    reservationType: r.reservation_type ?? "MEMBER",
    cancelSource: r.cancel_source ?? null,
  }));
}

export async function logout() {
  // 로그아웃 전에 이 기기의 네이티브 푸시 토큰(FCM)을 계정에서 떼어낸다 — signOut() 이후엔
  // getMyAccountId()가 세션이 없어 동작하지 않으므로 반드시 signOut()보다 먼저 호출해야
  // 한다. 안 하면 같은 기기에서 다른 계정으로 재로그인할 때 native_push_tokens의 UPDATE
  // RLS 정책(계정 본인 소유 행만 수정 가능)에 막혀 토큰 upsert가 실패하고, 로그아웃 상태
  // 그대로 방치되면 이전 계정이 이 기기로 계속 푸시를 받는 문제도 있었다(lib/nativePush.ts
  // disableNativePush 참고). 웹에서는 isNativePlatform()이 false라 즉시 { ok: true }로
  // 넘어가 비용이 거의 없다.
  await disableNativePush().catch(() => {});
  await supabase.auth.signOut();
  window.location.href = "/login";
}

/* ============================================================
   전체 예약 내역 (수강권 구매 이후 과거 수업까지 날짜별)
   ============================================================ */

const KST_DATE_ONLY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });
const KST_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
});

/* ============================================================
   포인트 내역 (P1-1) — point_transactions가 통합 원장(add_point_ledger_unification.sql)
   ============================================================ */

export type PointHistoryItem = {
  id: string;
  centerName: string;
  amount: number;      // 적립 +, 사용 -
  reason: string | null;
  date: string;         // "2026-08-18"
  timeText: string;      // "19:30"
  profileName: string;
};

export async function fetchMyPointHistory(): Promise<PointHistoryItem[]> {
  const accountId = await getMyAccountId();
  if (!accountId) return [];

  const { data: profRows } = await supabase
    .from("profiles").select("id, name, label, is_primary").eq("account_id", accountId);
  const profiles = profRows ?? [];
  const profileIds = profiles.map((p: any) => p.id);
  const profileLabel: Record<string, string> = {};
  for (const p of profiles) {
    profileLabel[(p as any).id] = (p as any).is_primary
      ? ""
      : ((p as any).label ? `${(p as any).name} · ${(p as any).label}` : (p as any).name);
  }
  if (profileIds.length === 0) return [];

  const { data, error } = await supabase
    .from("point_transactions")
    .select("id, profile_id, center_id, amount, reason, created_at, centers(name)")
    .in("profile_id", profileIds)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error("포인트 내역을 불러오지 못했어요: " + error.message);
  const rows = data ?? [];

  // 운영설정 "회원앱 포인트 내역 조회" — 센터마다 다를 수 있어 등장한 센터들만 조회하고,
  // false인 센터의 내역은 화면에서 제외한다(값이 없으면 기본 true와 동일하게 표시).
  const centerIds = Array.from(new Set(rows.map((r: any) => r.center_id)));
  const showHistoryByCenter: Record<string, boolean> = {};
  if (centerIds.length > 0) {
    const { data: settingsRows } = await supabase
      .from("center_settings")
      .select("center_id, show_point_history")
      .in("center_id", centerIds);
    for (const s of settingsRows ?? []) {
      showHistoryByCenter[(s as any).center_id] = (s as any).show_point_history ?? true;
    }
  }

  return rows
    .filter((r: any) => showHistoryByCenter[r.center_id] ?? true)
    .map((r: any) => {
      const dt = new Date(r.created_at);
      return {
        id: r.id,
        centerName: r.centers?.name ?? "",
        amount: r.amount,
        reason: r.reason,
        date: KST_DATE_ONLY.format(dt),
        timeText: KST_TIME.format(dt),
        profileName: profileLabel[r.profile_id] ?? "",
      };
    });
}

/* ============================================================
   예약 캘린더용 데이터 + 개인 메모
   ============================================================ */

export type CalReservation = {
  id: string;
  date: string;        // "2026-07-14"
  time: string;        // "20:00"
  startIso: string;    // 시작 시각 (ICS용)
  endIso: string;      // 종료 시각 (ICS용)
  title: string;
  centerName: string;
  status: string;
  profileName: string;
  memo: string | null;
};

const KST_DATE_C = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const KST_TIME_C = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

export async function fetchMyReservationsForCalendar(): Promise<CalReservation[]> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");

  const { data: profiles } = await supabase
    .from("profiles").select("id, name, nickname, label, is_primary").eq("account_id", accountId);
  const profs = profiles ?? [];
  const ids = profs.map((p: any) => p.id);
  const hasMultiple = profs.length > 1;
  const label: Record<string, string> = {};
  for (const p of profs) {
    const nm = (p as any).nickname || (p as any).name;
    label[(p as any).id] = hasMultiple ? ((p as any).label ? `${nm} · ${(p as any).label}` : nm) : "";
  }

  const { data, error } = await supabase
    .from("reservations")
    .select("id, profile_id, status, member_memo, classes(title, start_time, end_time, centers(name))")
    .in("profile_id", ids)
    .in("status", ["confirmed", "waitlisted", "attended", "no_show"])
    .order("created_at", { ascending: false });
  if (error) throw new Error("예약을 불러오지 못했어요: " + error.message);

  return (data ?? []).filter((r: any) => r.classes).map((r: any) => ({
    id: r.id,
    date: KST_DATE_C.format(new Date(r.classes.start_time)),
    time: KST_TIME_C.format(new Date(r.classes.start_time)),
    startIso: r.classes.start_time,
    endIso: r.classes.end_time ?? r.classes.start_time,
    title: r.classes.title,
    centerName: r.classes.centers?.name ?? "",
    status: r.status,
    profileName: label[r.profile_id] ?? "",
    memo: r.member_memo ?? null,
  }));
}

export async function updateReservationMemo(reservationId: string, memo: string): Promise<void> {
  const { error } = await supabase
    .from("reservations")
    .update({ member_memo: memo || null })
    .eq("id", reservationId);
  if (error) throw new Error("메모 저장에 실패했어요: " + error.message);
}

/* ============================================================
   예약을 .ics (iCalendar) 로 변환 → 아이폰/구글 캘린더에 추가
   ============================================================ */

function toIcsDate(iso: string): string {
  // UTC 기준 YYYYMMDDTHHMMSSZ
  const d = new Date(iso);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeIcs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// 예약 여러 개 → ICS 문자열
export function reservationsToIcs(items: CalReservation[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//모하빗//예약//KR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const now = toIcsDate(new Date().toISOString());
  for (const r of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.id}@woori-class`,
      `DTSTAMP:${now}`,
      `DTSTART:${toIcsDate(r.startIso)}`,
      `DTEND:${toIcsDate(r.endIso)}`,
      `SUMMARY:${escapeIcs(r.title + (r.centerName ? ` · ${r.centerName}` : ""))}`,
      `DESCRIPTION:${escapeIcs((r.profileName ? r.profileName + " " : "") + (r.memo ? "메모: " + r.memo : ""))}`,
      r.centerName ? `LOCATION:${escapeIcs(r.centerName)}` : "",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n");
}

// ICS 파일 다운로드 트리거
export function downloadIcs(items: CalReservation[], filename = "내예약.ics") {
  const ics = reservationsToIcs(items);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   수강권/상품 환불
   - 회원 셀프 환불 조건: 결제 24시간 이내 + 미차감(횟수 안 줄어듦)
   - 그 외에는 센터에 직접 연락 (여기선 막고 안내)
   ============================================================ */

export function refundEligibility(m: { createdAt: string; totalCount: number; remainingCount: number; unlimited: boolean }): { ok: boolean; reason: string } {
  const hours = (Date.now() - new Date(m.createdAt).getTime()) / 3600000;
  if (hours > 24) return { ok: false, reason: "결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요." };
  // 미차감 판단: 횟수권이면 remaining === total, 무제한/기간권은 사용 이력 확인 어려워 24시간 내만 허용
  if (!m.unlimited && m.totalCount != null && m.remainingCount !== m.totalCount) {
    return { ok: false, reason: "이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요." };
  }
  return { ok: true, reason: "결제 24시간 이내, 미사용 상태로 환불할 수 있어요." };
}

export async function requestRefund(membershipId: string): Promise<void> {
  // 서버에서 조건 검증 + 수강권 환불 + 매출 반영 + 회원상태 갱신
  const { error } = await supabase.rpc("refund_membership", { p_membership_id: membershipId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}
