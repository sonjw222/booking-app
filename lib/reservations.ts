/*
  예약 관련 데이터 함수 모음
  - 예약 캘린더 화면이 이 함수들만 호출하면 되게 정리
  - reservation_functions.sql 을 Supabase에 먼저 실행해야 reserve/cancel이 동작해요
*/

import { supabase } from "./supabaseClient";

// ---------------- 타입 ----------------

export type CenterInfo = {
  id: string;
  name: string;
  categories: string[];
  color: string; // member_center_colors에 설정이 있으면 그 색, 없으면 기본색
};

export type ClassInfo = {
  id: string;
  centerId: string;
  title: string;
  date: string; // "2026-07-14"
  start: string; // "07:10"
  end: string;
  place: string;
  reserved: number;
  capacity: number;
  allowGoods: boolean;
  classFormat: "group" | "private"; // CLASS-001 D-2: 회원 앱에 프라이빗 배지 표시용
  // 프로필별 내 예약 상태. key = profileId
  myByProfile: Record<string, { reservationId: string; status: "confirmed" | "waitlisted" }>;
};

export type CenterHoliday = { centerId: string; date: string; reason: string | null };

// 센터별 기본 색상 (센터 수가 늘면 순환)
const DEFAULT_COLORS = ["#E8543A", "#2B6CB0", "#1F6F63", "#B8842E", "#6B4C9A"];

// Supabase는 시간을 UTC로 돌려주므로 한국시간으로 변환해서 표시
const KST_FMT_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const KST_FMT_TIME = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

function toDateStr(iso: string) {
  return KST_FMT_DATE.format(new Date(iso)); // "2026-07-14"
}
function toTimeStr(iso: string) {
  return KST_FMT_TIME.format(new Date(iso)); // "20:00"
}

// 현재 로그인 계정의 accounts.id. 화면에서 fetchMonthData/fetchMyProfiles를 함께 호출할 때
// 이 함수로 한 번만 조회한 뒤 두 함수에 넘기면, 매번 중복으로 auth.getUser()+accounts 조회를
// 반복하지 않아도 됨 (예약 화면 성능 개선 — app/reservation/page.tsx의 load() 참고).
export async function getMyAccountId(): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data: account, error: accErr } = await supabase
    .from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (accErr || !account) throw new Error("계정 정보를 찾을 수 없어요");
  return account.id;
}

// ---------------- 월 단위 데이터 한 번에 가져오기 ----------------
// 반환: 이번 달의 수업 + 센터 + 휴무일 + 내 예약 정보
// accountId를 미리 조회해서 넘기면 내부에서 다시 조회하지 않음 (중복 쿼리 방지)
export async function fetchMonthData(year: number, month: number, accountId?: string) {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const accId = accountId ?? (await getMyAccountId());
  const account = { id: accId };

  // 내 모든 프로필 (대표 + 추가 프로필). 프로필별로 예약 상태를 따로 봐야 함
  const { data: myProfiles, error: meErr } = await supabase
    .from("profiles").select("id, is_primary").eq("account_id", account.id);
  if (meErr || !myProfiles || myProfiles.length === 0) throw new Error("프로필 정보를 찾을 수 없어요");
  const myProfileIds = myProfiles.map((p: any) => p.id);

  // 내가 수강권을 보유한 센터 목록 (활성 수강권 기준)
  const { data: myMems } = await supabase
    .from("memberships")
    .select("center_id, remaining_count, expires_at, status")
    .in("profile_id", myProfileIds);
  const myMembershipCenters = new Set<string>();
  for (const m of myMems ?? []) {
    const active = (m as any).status === "active"
      && ((m as any).remaining_count == null || (m as any).remaining_count > 0)
      && ((m as any).expires_at == null || (m as any).expires_at >= monthStart.slice(0, 10) || new Date((m as any).expires_at) >= new Date());
    if (active) myMembershipCenters.add((m as any).center_id);
  }

  // 이번 달 수업 (확정 예약 수 포함)
  const { data: classRows, error: clsErr } = await supabase
    .from("classes")
    .select("id, center_id, title, start_time, end_time, capacity, allow_goods, class_format, centers(id, name, categories)")
    .gte("start_time", monthStart)
    .lt("start_time", nextMonth)
    .order("start_time");
  if (clsErr) throw new Error("수업 목록을 불러오지 못했어요: " + clsErr.message);

  // 수강권 보유 센터의 수업만 남김 (수강권 없는 센터 수업은 숨김)
  const filteredClassRows = (classRows ?? []).filter((c: any) => myMembershipCenters.has(c.center_id));

  const classIds = filteredClassRows.map((c) => c.id);

  // 수업별 확정 인원수 (개인정보 없는 집계 뷰에서 조회)
  let reservedCount: Record<string, number> = {};
  // 내 예약 (프로필별로 구분). key = `${classId}:${profileId}`
  let myByClassProfile: Record<string, { id: string; status: "confirmed" | "waitlisted" }> = {};

  if (classIds.length > 0) {
    const [countRes, myRes] = await Promise.all([
      supabase.from("class_reservation_counts").select("class_id, confirmed_count").in("class_id", classIds),
      supabase
        .from("reservations")
        .select("id, class_id, profile_id, status")
        .in("profile_id", myProfileIds)
        .in("class_id", classIds)
        .in("status", ["confirmed", "waitlisted"]),
    ]);

    if (countRes.error) throw new Error("예약 인원을 불러오지 못했어요: " + countRes.error.message);
    if (myRes.error) throw new Error("내 예약을 불러오지 못했어요: " + myRes.error.message);

    for (const r of countRes.data ?? []) {
      reservedCount[r.class_id] = r.confirmed_count;
    }
    for (const r of myRes.data ?? []) {
      myByClassProfile[`${r.class_id}:${(r as any).profile_id}`] = {
        id: r.id, status: r.status as "confirmed" | "waitlisted",
      };
    }
  }

  // 센터 목록 (수업에서 등장한 센터만) + 내 색상 설정
  const centerMap = new Map<string, { id: string; name: string; categories: string[] }>();
  for (const c of filteredClassRows) {
    const center = (c as any).centers;
    if (center) centerMap.set(center.id, center);
  }

  // 통합 캘린더 색상: 센터별 색상은 계정 단위 설정 (프로필 단위 아님)
  const { data: colorRows } = await supabase
    .from("member_center_colors")
    .select("center_id, color")
    .eq("account_id", account.id);
  const colorByCenter: Record<string, string> = {};
  for (const r of colorRows ?? []) colorByCenter[r.center_id] = r.color;

  const centers: CenterInfo[] = Array.from(centerMap.values()).map((c, i) => ({
    id: c.id,
    name: c.name,
    categories: (c as any).categories ?? [],
    color: colorByCenter[c.id] ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
  }));

  // 휴무일
  const { data: holRows } = await supabase
    .from("center_holidays")
    .select("center_id, holiday_date, reason")
    .gte("holiday_date", monthStart)
    .lt("holiday_date", nextMonth);
  const holidays: CenterHoliday[] = (holRows ?? []).map((h) => ({
    centerId: h.center_id,
    date: h.holiday_date,
    reason: h.reason,
  }));

  // 휴무일 (센터+날짜) 집합 → 그 날 수업은 회원 화면에서 숨김
  const holidaySet = new Set<string>();
  for (const h of holidays) holidaySet.add(`${h.centerId}:${h.date}`);

  // 수업 정리 (휴무일 수업 제외)
  const classes: ClassInfo[] = filteredClassRows
    .filter((c) => !holidaySet.has(`${c.center_id}:${toDateStr(c.start_time)}`))
    .map((c) => ({
      id: c.id,
      centerId: c.center_id,
      title: c.title,
      date: toDateStr(c.start_time),
      start: toTimeStr(c.start_time),
      end: toTimeStr(c.end_time),
      place: centerMap.get(c.center_id)?.name ?? "",
      reserved: reservedCount[c.id] ?? 0,
      capacity: c.capacity,
      allowGoods: c.allow_goods ?? false,
      classFormat: (c.class_format ?? "group") as "group" | "private",
      myByProfile: myProfileIds.reduce((acc, pid) => {
        const r = myByClassProfile[`${c.id}:${pid}`];
        if (r) acc[pid] = { reservationId: r.id, status: r.status };
        return acc;
      }, {} as Record<string, { reservationId: string; status: "confirmed" | "waitlisted" }>),
    }));

  return { classes, centers, holidays };
}

// ---------------- 예약하기 ----------------
// DB 함수(reserve_class)를 호출 → 정원확인·수강권검증·차감이 서버에서 원자적으로 처리됨
// p_profile_id 를 넘기면 그 프로필로 예약(자녀 등), 없으면 대표 프로필로 예약
export async function reserveClass(
  classId: string,
  profileId?: string | null,
  goodsMembershipId?: string | null
): Promise<"confirmed" | "waitlisted"> {
  // 상품을 함께 선택했으면 goods 버전 RPC 사용
  if (goodsMembershipId) {
    const { data, error } = await supabase.rpc("reserve_class_with_goods", {
      p_class_id: classId,
      p_profile_id: profileId ?? null,
      p_goods_membership_id: goodsMembershipId,
    });
    if (error) throw new Error(error.message);
    return (data as any).status;
  }
  const { data, error } = await supabase.rpc("reserve_class", {
    p_class_id: classId,
    p_profile_id: profileId ?? null,
  });
  if (error) throw new Error(error.message);
  return (data as any).status;
}

// 특정 프로필이 여러 센터에서 보유한 상품(goods) 목록을 한 번에 조회 (예약 확인창 선택용, N+1 방지)
// 반환: centerId -> 그 센터에서 사용 가능한 상품 목록
export type MyGoods = { id: string; name: string; remaining: number | null; unlimited: boolean };

export async function fetchMyGoodsByCenter(
  profileId: string, centerIds: string[]
): Promise<Record<string, MyGoods[]>> {
  if (centerIds.length === 0) return {};
  const { data, error } = await supabase
    .from("memberships")
    .select("id, center_id, product_name, remaining_count, expires_at, status, products(product_kind, unlimited)")
    .eq("profile_id", profileId)
    .in("center_id", centerIds)
    .eq("status", "active");
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
  const today = new Date().toISOString().slice(0, 10);
  const out: Record<string, MyGoods[]> = {};
  for (const m of (data ?? []) as any[]) {
    if (m.products?.product_kind !== "goods") continue;
    if (!(m.products?.unlimited || (m.remaining_count ?? 0) > 0)) continue;
    if (m.expires_at && m.expires_at < today) continue;
    (out[m.center_id] ??= []).push({
      id: m.id,
      name: m.product_name,
      remaining: m.products?.unlimited ? null : m.remaining_count,
      unlimited: m.products?.unlimited ?? false,
    });
  }
  return out;
}

// 내 프로필 목록 (예약 주체 선택용)
export type BookingProfile = { id: string; name: string; label: string | null; isPrimary: boolean };

export async function fetchMyProfiles(accountId?: string): Promise<BookingProfile[]> {
  let accId = accountId;
  if (!accId) {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) return [];
    const { data: acc } = await supabase
      .from("accounts")
      .select("id")
      .eq("auth_id", authData.user.id)
      .single();
    if (!acc) return [];
    accId = acc.id;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, label, is_primary")
    .eq("account_id", accId)
    .order("is_primary", { ascending: false });
  if (error) throw new Error("프로필을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((p: any) => ({
    id: p.id, name: p.name, label: p.label, isPrimary: p.is_primary,
  }));
}

// ---------------- 예약 취소 ----------------
export async function cancelReservation(reservationId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_reservation", {
    p_reservation_id: reservationId,
  });
  if (error) throw new Error(error.message);
}

/* ============================================================
   프로필 간 수강권 공유
   - 계정(아이디) 단위로 보유한 수강권을 어떤 프로필이든 사용
   - 예약 시 어떤 수강권을 쓸지 선택
   ============================================================ */

export type UsableMembership = {
  membershipId: string;
  productName: string;
  remainingCount: number;
  expiresAt: string;
  ownerProfile: string;   // 이 수강권이 지정된 프로필 이름
  isMine: boolean;        // 선택한 프로필 본인 것인지
};

// 여러 수업에 대해 이 프로필로 쓸 수 있는 수강권 목록을 한 번에 조회 (N+1 방지)
// 반환: classId -> 그 수업에 사용 가능한 수강권 목록
// ⚠ Supabase 함수 usable_memberships_for_classes()는 예약 시점에 실제로 쓰이는
//   usable_memberships()/reserve_with_membership()과 판정 조건이 동일해야 함
//   (fix_usable_memberships_shared.sql 참고) — 목록 표시와 실제 예약 가능 여부가 어긋나면 안 됨
export async function fetchUsableMembershipsByClass(
  classIds: string[], profileId: string
): Promise<Record<string, UsableMembership[]>> {
  if (classIds.length === 0) return {};
  const { data, error } = await supabase.rpc("usable_memberships_for_classes", {
    p_class_ids: classIds, p_profile_id: profileId,
  });
  if (error) throw new Error("수강권을 불러오지 못했어요: " + error.message);
  const out: Record<string, UsableMembership[]> = {};
  for (const r of (data ?? []) as any[]) {
    (out[r.class_id] ??= []).push({
      membershipId: r.membership_id,
      productName: r.product_name,
      remainingCount: r.remaining_count,
      expiresAt: r.expires_at,
      ownerProfile: r.owner_profile ?? "",
      isMine: r.is_mine ?? false,
    });
  }
  return out;
}

// 이 수업에 사용 가능하지만 아직 보유하지 않은, 구매 가능한 수강권
// (예약 모달에서 "사용 가능한 수강권 없음"일 때 무엇을 사면 되는지 안내하기 위함)
export type PurchasableProduct = {
  productId: string;
  productName: string;
  price: number;
  kind: "pass" | "goods";
};

// 여러 수업(각자의 센터)에 대해 "구매하면 이 수업에 쓸 수 있는 상품" 목록을 한 번에 조회
// - class_allowed_products에 지정이 있으면 그 상품들만, 없으면 그 센터의 모든 판매중 상품
//   (usable_memberships()의 "지정 없으면 전체 허용" 판정과 동일한 기준)
// - 판매중지/비활성화/삭제 상품 제외, 다른 센터 상품 제외
// - profileIds가 이미 보유(active) 중인 상품은 목록에서 제외 (schedule_rules로 이 수업엔 못 써도 "보유"로 간주)
export async function fetchPurchasableProductsByClass(
  classCenterPairs: { classId: string; centerId: string }[],
  profileIds: string[]
): Promise<Record<string, PurchasableProduct[]>> {
  if (classCenterPairs.length === 0) return {};
  const classIds = classCenterPairs.map((p) => p.classId);
  const centerIdByClass: Record<string, string> = {};
  for (const p of classCenterPairs) centerIdByClass[p.classId] = p.centerId;
  const centerIds = Array.from(new Set(classCenterPairs.map((p) => p.centerId)));

  const [linksRes, allProductsRes, ownedRes] = await Promise.all([
    supabase
      .from("class_allowed_products")
      .select("class_id, products(id, name, price, product_kind, center_id, is_active, is_on_sale)")
      .in("class_id", classIds),
    supabase
      .from("products")
      .select("id, name, price, product_kind, center_id, is_active, is_on_sale")
      .in("center_id", centerIds)
      .eq("is_active", true)
      .eq("is_on_sale", true),
    profileIds.length > 0
      ? supabase
          .from("memberships")
          .select("product_id, center_id, status, remaining_count, expires_at")
          .in("profile_id", profileIds)
          .in("center_id", centerIds)
          .eq("status", "active")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (linksRes.error) throw new Error("구매 가능한 수강권을 불러오지 못했어요: " + linksRes.error.message);
  if (allProductsRes.error) throw new Error("구매 가능한 수강권을 불러오지 못했어요: " + allProductsRes.error.message);
  if (ownedRes.error) throw new Error("보유 수강권을 확인하지 못했어요: " + ownedRes.error.message);

  const today = new Date().toISOString().slice(0, 10);
  const ownedProductIds = new Set<string>();
  for (const m of (ownedRes.data ?? []) as any[]) {
    if (!m.product_id) continue;
    const active = (m.remaining_count == null || m.remaining_count > 0) && (!m.expires_at || m.expires_at >= today);
    if (active) ownedProductIds.add(m.product_id);
  }

  const toProduct = (p: any): PurchasableProduct => ({
    productId: p.id,
    productName: p.name,
    price: p.price,
    kind: p.product_kind === "goods" ? "goods" : "pass",
  });

  // 수업별 "지정된 상품" 목록 (없으면 미지정 = 전체 허용으로 아래에서 처리)
  const restrictedByClass: Record<string, PurchasableProduct[]> = {};
  const hasRestriction = new Set<string>();
  for (const l of (linksRes.data ?? []) as any[]) {
    hasRestriction.add(l.class_id);
    const p = l.products;
    if (!p) continue;
    if (!p.is_active || !p.is_on_sale) continue;
    if (p.center_id !== centerIdByClass[l.class_id]) continue;
    if (ownedProductIds.has(p.id)) continue;
    (restrictedByClass[l.class_id] ??= []).push(toProduct(p));
  }

  // 센터별 "판매중인 전체 상품" 목록 (지정 없는 수업에 사용)
  const allByCenter: Record<string, PurchasableProduct[]> = {};
  for (const p of (allProductsRes.data ?? []) as any[]) {
    if (ownedProductIds.has(p.id)) continue;
    (allByCenter[p.center_id] ??= []).push(toProduct(p));
  }

  const out: Record<string, PurchasableProduct[]> = {};
  for (const { classId, centerId } of classCenterPairs) {
    out[classId] = hasRestriction.has(classId)
      ? (restrictedByClass[classId] ?? [])
      : (allByCenter[centerId] ?? []);
  }
  return out;
}

// 수강권을 지정해서 예약
export async function reserveWithMembership(
  classId: string, profileId: string, membershipId: string
): Promise<"confirmed" | "waitlisted"> {
  const { data, error } = await supabase.rpc("reserve_with_membership", {
    p_class_id: classId, p_profile_id: profileId, p_membership_id: membershipId,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return ((data as any)?.status ?? "confirmed") as "confirmed" | "waitlisted";
}
