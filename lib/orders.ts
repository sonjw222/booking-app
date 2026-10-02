/*
  주문/결제
  - 회원이 수강권·상품 구매 시 주문 생성 (pending)
  - 결제 수단은 나중에 연동 (지금은 주문서 → 매니저 확인)
  - 매니저가 주문 확인/완료 처리
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

export type Order = {
  id: string;
  centerId: string;
  profileId: string;
  productId: string | null;
  productName: string;
  amount: number;
  payMethod: string | null;
  status: "pending" | "paid" | "cancelled" | "done";
  createdAt: string;
  paidAt: string | null;
  // 2026-10-01 — 구매 횟수 선택형 상품의 주문 snapshot / 선택 사이즈(관리자 주문 확인·구매내역 표시용)
  selectedCount: number | null;
  selectedSize: string | null;
};

// 회원: 주문 생성 (결제 화면에서 "결제하기" 시)
// provider: Payment Adapter가 이 주문을 처리할 provider("mock"/"toss"/"portone"). 생략 시 null
//   (레거시 경로 — 매니저가 /manager/orders에서 수동 확인). 기존 호출부(app/cart/page.tsx 등)는
//   그대로 두어도 동작에 영향 없는 선택적 필드라 하위 호환됨.
export async function createOrder(input: {
  centerId: string; productId: string; productName: string; amount: number; payMethod?: string;
  selectedSize?: string; couponCode?: string; discountAmount?: number; autoBook?: boolean;
  provider?: "mock" | "toss" | "portone"; pointsUsed?: number;
  // 가족(다중 프로필) 계정에서 "이 구매는 누구 앞으로"를 고를 수 있게 함(2026-09-06,
  // 스튜디오 오너/회원 UX 감사) — 생략하면 기존처럼 대표 프로필로 자동 배정(하위 호환).
  profileId?: string;
  // MWHABIT Membership Visibility + Coupon Batch(2026-09-18) — 기존 couponCode(공개
  // 프로모션 코드, WELCOME/FIGURE10 하드코딩)와는 별개의 새 경로. 실제 할인 계산은
  // 여기서 하지 않는다(클라이언트가 보낸 amount/discountAmount는 결제 확정 시
  // _issue_membership_and_record_payment()가 항상 다시 계산해서 검증함) — 여기서는
  // "이 주문에 이 쿠폰을 쓰겠다"는 의사만 싣는다. orders INSERT RLS
  // (member_can_purchase_product)가 상품 자체의 구매자격은 이미 주문 생성 시점에
  // 막아주지만, 쿠폰 자격(소유자/센터/유효기간/최소금액 등)은 확정 시점에만 검증된다.
  memberCouponId?: string;
  // 2026-10-01(Batch C, C-9) — weekdaySelectable 상품 구매 시 고른 요일/시간. fulfill_order()/
  // _issue_membership_and_record_payment()(add_weekday_time_fixed_memberships.sql)가 이
  // 값을 그대로 새 memberships 행의 bound_day_of_week/bound_start_time으로 복사한다.
  selectedDayOfWeek?: number | null;
  selectedStartTime?: string | null;
  // 2026-10-01 — 구매 횟수 선택형 상품에서 구매자가 고른 횟수. orders.selected_count에 저장되고, 서버(orders BEFORE INSERT
  // 트리거)가 가격표(product_count_prices)에 있는 회차인지 검증한 뒤 그 회차 가격으로 product_amount_snapshot을 확정한다. 아래 amount는 클라이언트가 계산한
  // 표시 금액일 뿐이라 발급 시점에 서버가 snapshot - 쿠폰 - 포인트로 다시 계산해 다르면 거부한다(클라이언트 금액 불신).
  selectedCount?: number | null;
}): Promise<string> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");

  let profileId = input.profileId;
  if (!profileId) {
    // 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 사용 (single() 실패 방지)
    const { data: profs } = await supabase
      .from("profiles").select("id, is_primary, created_at")
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1);
    const prof = profs?.[0];
    if (!prof) throw new Error("프로필을 찾을 수 없어요. 프로필 관리에서 프로필을 만들어주세요.");
    profileId = prof.id;
  }

  const row: Record<string, unknown> = {
    center_id: input.centerId,
    profile_id: profileId,
    product_id: input.productId,
    product_name: input.productName,
    amount: input.amount,
    pay_method: input.payMethod ?? null,
    selected_size: input.selectedSize ?? null,
    coupon_code: input.couponCode ?? null,
    discount_amount: input.discountAmount ?? 0,
    auto_book: input.autoBook ?? false,
    payment_provider: input.provider ?? null,
    points_used: input.pointsUsed ?? 0,
    member_coupon_id: input.memberCouponId ?? null,
    status: "pending",
    selected_day_of_week: input.selectedDayOfWeek ?? null,
    selected_start_time: input.selectedStartTime ?? null,
    selected_count: input.selectedCount ?? null,
  };
  let { data, error } = await supabase.from("orders").insert(row).select("id").single();
  if (error?.code === "42703" && input.selectedCount != null) {
    // add_selectable_count_pricing.sql 미적용 환경에서 선택형 주문을 selected_count 없이 만들면 최저 회차 금액으로
    // 오해될 수 있으므로 조용히 제외하지 않고 명확히 실패시킨다.
    throw new Error("횟수 선택 상품 구매는 아직 준비 중이에요. 잠시 후 다시 시도해주세요.");
  }
  if (error?.code === "42703") {
    // 2026-10-01(Batch C) — add_weekday_time_fixed_memberships.sql 미실행 환경 방어
    // (lib/rooms.ts/lib/passes.ts와 동일 패턴). 이 경우 요일/시간 선택 자체는 화면에서
    // 막히지 않지만(체크아웃 UI가 여전히 선택을 받음) 그 선택값은 저장되지 않는다 —
    // 주문 생성 자체가 막히는 것보다 훨씬 안전한 실패 방향.
    const { selected_day_of_week, selected_start_time, selected_count, ...withoutWeekday } = row;
    ({ data, error } = await supabase.from("orders").insert(withoutWeekday).select("id").single());
  }
  if (error || !data) throw new Error("주문 생성에 실패했어요: " + (error?.message ?? "no data"));
  return data.id;
}

// 회원: 내 주문 내역
export async function fetchMyOrders(): Promise<Order[]> {
  const myCols = "id, center_id, profile_id, product_id, product_name, amount, pay_method, status, created_at, paid_at, centers(name)";
  const runMy = (cols: string) => supabase.from("orders").select(cols).order("created_at", { ascending: false });
  let { data, error } = (await runMy(`${myCols}, selected_count, selected_size`)) as any;
  if (error?.code === "42703") ({ data, error } = (await runMy(myCols)) as any);
  if (error) throw new Error("주문 내역을 불러오지 못했어요: " + error.message);
  return (data ?? []).map(mapOrder);
}

// 매니저: 자기 센터 주문 목록
export async function fetchCenterOrders(centerId: string, status?: string): Promise<(Order & { memberName: string; memberPhone: string | null })[]> {
  const centerCols = "id, center_id, profile_id, product_id, product_name, amount, pay_method, status, created_at, paid_at, profiles(name, accounts(phone))";
  const build = (cols: string) => {
    let q = supabase.from("orders").select(cols).eq("center_id", centerId).order("created_at", { ascending: false });
    if (status) q = q.eq("status", status);
    // egress 감사(2026-09-15) — status 필터 없이 부르면(기본 화면 진입 시) 센터가 생긴
  // 이후의 모든 주문을 상한 없이 통째로 가져왔다. 최신순 정렬은 이미 있었으니 안전판만
  // 추가 — 지금까지 이 상한에 걸릴 만큼 주문이 쌓인 센터는 없어 동작은 그대로다.
    return q.limit(1000);
  };
  // 구매 횟수/사이즈(2026-10-01) 컬럼이 없는 환경(42703)은 기존 컬럼만으로 다시 조회
  let { data, error } = (await build(`${centerCols}, selected_count, selected_size`)) as any;
  if (error?.code === "42703") ({ data, error } = (await build(centerCols)) as any);
  if (error) throw new Error("주문을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((o: any) => ({
    ...mapOrder(o),
    memberName: o.profiles?.name ?? "회원",
    memberPhone: o.profiles?.accounts?.phone ?? null,
  }));
}

// fulfill_order()가 돌려주는 발급/자동예약 결과(fix_order_issuance_and_auto_booking.sql 이후).
// 이전 DB(미적용)에서는 자동예약 필드가 없으므로 모두 optional.
export type FulfillOrderResult = {
  alreadyDone: boolean;
  membershipId: string | null;
  autoBookRequested: boolean;
  autoBookedCount: number;
  unplacedCount: number | null;
  autoBookReason: string | null;   // ok | not_requested | outside_membership_period | capacity_full | ... | error
  autoBookError: string | null;
};

const AUTO_BOOK_REASON_TEXT: Record<string, string> = {
  outside_membership_period: "수강권 만료일 이후 수업만 남아서",
  no_class_in_period: "만료일 안에 일치하는 수업이 없어서",
  capacity_full: "정원이 가득 차서",
  condition_mismatch: "예약 조건(요일·시간)이 맞는 수업이 없어서",
  already_reserved: "이미 예약된 날짜라서",
  booking_window: "휴무일/예약 가능 기간 때문에",
  not_weekday_pass: "요일 정보가 없어서",
  no_remaining: "남은 횟수가 없어서",
};

// 관리자 토스트용 문구(순수 함수 — 테스트 대상). 자동예약 실패 이유가 반드시 보이게 한다.
export function fulfillResultMessage(r: FulfillOrderResult | undefined): string {
  const base = "수강권을 발급하고 매출에 반영했어요";
  if (!r || !r.autoBookRequested) return base;
  if (r.autoBookReason === "error") {
    return `${base}. 다만 자동예약 중 오류가 나서 예약하지 못했어요(${r.autoBookError ?? "원인 미상"}) — 미배치 목록에서 다시 배치해주세요.`;
  }
  const booked = `${r.autoBookedCount}회 자동예약`;
  if ((r.unplacedCount ?? 0) > 0) {
    const why = AUTO_BOOK_REASON_TEXT[r.autoBookReason ?? ""] ?? "조건에 맞는 수업이 부족해서";
    return `${base}. ${booked}했고, ${why} ${r.unplacedCount}회는 미배치예요(미배치 목록에서 확인).`;
  }
  return `${base}. ${booked}했어요.`;
}

function mapFulfillResult(d: any): FulfillOrderResult {
  return {
    alreadyDone: !!d?.already_done,
    membershipId: d?.membership_id ?? null,
    autoBookRequested: !!d?.auto_book_requested,
    autoBookedCount: d?.auto_booked_count ?? 0,
    unplacedCount: d?.unplaced_count ?? null,
    autoBookReason: d?.auto_book_reason ?? null,
    autoBookError: d?.auto_book_error ?? null,
  };
}

// 매니저: 주문 처리 완료 (수강권 발급 + 매출 연동 + 요일반 자동예약) 또는 취소.
// 'done'이면 발급/자동예약 결과를 돌려준다(관리자에게 실패 이유를 보여주기 위함).
export async function updateOrderStatus(
  orderId: string, status: "done" | "cancelled"
): Promise<FulfillOrderResult | undefined> {
  if (status === "done") {
    const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: orderId });
    if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
    return mapFulfillResult(data);
  }
  // .select()로 실제 바뀐 행을 받아온다 — RLS의 using() 조건(예: 회원 자가 취소는
  // status가 pending/paid일 때만 허용, add_order_self_cancel.sql)에 더 이상 안 맞는
  // 주문(예: 그 사이 매니저가 먼저 처리함)이면 UPDATE 자체는 에러 없이 "0행 매칭"으로
  // 조용히 끝나 버려서, 이 확인이 없으면 아무것도 안 바뀌었는데 성공 토스트가 뜬다.
  const { data, error } = await supabase
    .from("orders").update({ status }).eq("id", orderId).select("id");
  if (error) throw new Error("주문 상태 변경에 실패했어요: " + error.message);
  if (!data || data.length === 0) {
    throw new Error("이미 처리됐거나 취소할 수 없는 상태의 주문이에요. 새로고침 후 다시 확인해주세요.");
  }
}

// 결제가 승인되기 "전에" 끝난 흐름(토스 failUrl 복귀, 결제창 즉시 닫힘, 직접결제 포인트 차감 실패 등)에서 방금 만든
// 내 pending 주문을 정리한다. 주문이 cancelled가 되는 순간 DB 트리거가 같은 트랜잭션에서 사용한 포인트를 복원하므로
// 여기서 포인트를 따로 되돌리지 않는다. 이미 처리/취소된 주문(RLS 0행, 상태 전이 가드)은 조용히 무시한다 — 정리 실패가
// 원래 오류 화면을 가리면 안 된다.
export async function cancelMyPendingOrderQuietly(orderId: string | null | undefined): Promise<boolean> {
  if (!orderId) return false;
  try {
    const { data, error } = await supabase
      .from("orders").update({ status: "cancelled" }).eq("id", orderId).eq("status", "pending").select("id");
    return !error && !!data && data.length > 0;
  } catch {
    return false;
  }
}

// 구매내역 "주문 취소하기" 버튼 전용 — 서버 RPC가 취소와 관리자 알림(order_cancelled)을 같은 트랜잭션에서 처리한다.
// checkout 자동 정리/결제창 닫힘/보상 취소는 이 함수를 쓰지 않으므로(조용히 취소) 관리자에게 불필요한 알림이 가지 않는다.
// RPC가 아직 없는 환경(SQL 미적용: PGRST202/42883)은 기존 직접 취소로 대체한다(알림만 없음).
export async function cancelMyOrderFromPurchases(orderId: string): Promise<void> {
  const { error } = await supabase.rpc("member_cancel_pending_order", { p_order_id: orderId });
  if (!error) return;
  if (error.code === "PGRST202" || error.code === "42883") { await updateOrderStatus(orderId, "cancelled"); return; }
  throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

function mapOrder(o: any): Order & { centerName?: string } {
  return {
    id: o.id, centerId: o.center_id, profileId: o.profile_id,
    productId: o.product_id, productName: o.product_name, amount: o.amount,
    payMethod: o.pay_method, status: o.status, createdAt: o.created_at, paidAt: o.paid_at,
    selectedCount: o.selected_count ?? null, selectedSize: o.selected_size ?? null,
    centerName: o.centers?.name,
  };
}

/* ============================================================
   내 구매내역 (마이페이지)
   - 주문 + 발급된 수강권을 함께 조회
   - 환불 가능 여부 판단 포함
   ============================================================ */

export type PurchaseItem = {
  id: string;                 // membership id (없으면 order id)
  orderId: string | null;
  membershipId: string | null;
  centerId: string;
  centerName: string;
  productName: string;
  amount: number;
  status: string;             // 주문 상태 또는 수강권 상태
  purchasedAt: string;        // 표시용
  createdAtIso: string;       // 환불 24시간 판단용
  totalCount: number | null;
  remainingCount: number | null;
  selectedSize: string | null;   // 2026-10-01 — 구매 시 고른 사이즈(대여화 등). 선택형 상품의 구매 횟수는 totalCount.
  refundable: boolean;
  refundReason: string;
  cancellable: boolean;       // P1-2: 아직 미발급 주문을 회원이 직접 취소할 수 있는지
  kind: "pass" | "goods";
};

const KST_DT_FULL = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export async function fetchMyPurchases(): Promise<PurchaseItem[]> {
  // memberships RLS는 매니저에게도 조회를 허용해서(customer.member.view), profile_id 필터
  // 없이 조회하면 매니저 겸 회원인 계정에 다른 회원의 수강권이 "내 구매내역"에 섞여
  // 나온다 — 명시적으로 내 프로필로 좁힌다(QA에서 발견된 버그, 2026-09-09).
  const accountId = await getMyAccountId();
  if (!accountId) return [];
  const { data: profs } = await supabase.from("profiles").select("id").eq("account_id", accountId).is("deleted_at", null);
  const profileIds = (profs ?? []).map((p: any) => p.id);
  if (profileIds.length === 0) return [];

  // 발급된 수강권 (환불 가능 판단 대상)
  const memCols = "id, center_id, product_id, product_name, total_count, remaining_count, status, created_at, centers(name), products(product_kind)";
  const runMem = (cols: string) => supabase.from("memberships").select(cols)
    .in("profile_id", profileIds).order("created_at", { ascending: false }).limit(100);
  let { data: mems, error: memsErr } = (await runMem(`${memCols}, selected_size`)) as any;
  if (memsErr?.code === "42703") ({ data: mems } = (await runMem(memCols)) as any);

  // 주문 (아직 발급 안 된 것 포함)
  const ordCols = "id, center_id, product_name, amount, status, created_at, centers(name)";
  const runOrd = (cols: string) => supabase.from("orders").select(cols)
    .in("profile_id", profileIds).order("created_at", { ascending: false }).limit(100);
  let { data: ords, error: ordsErr } = (await runOrd(`${ordCols}, selected_count, selected_size`)) as any;
  if (ordsErr?.code === "42703") ({ data: ords } = (await runOrd(ordCols)) as any);

  const out: PurchaseItem[] = [];

  for (const m of mems ?? []) {
    const created = (m as any).created_at;
    const hours = (Date.now() - new Date(created).getTime()) / 3600000;
    const total = (m as any).total_count;
    const remain = (m as any).remaining_count;
    const used = total != null && remain != null && remain !== total;
    const st = (m as any).status;

    let refundable = false;
    let reason = "";
    if (st === "refunded") reason = "환불 완료";
    else if (hours > 24) reason = "환불은 결제 후 24시간이 지나 센터에 직접 문의해주세요.";
    else if (used) reason = "이미 사용한 수강권은 센터에 직접 문의해주세요.";
    else { refundable = true; reason = ""; }

    // 같은 주문에서 온 금액 찾기 (없으면 0)
    const matched = (ords ?? []).find(
      (o: any) => o.center_id === (m as any).center_id && o.product_name === (m as any).product_name && o.status === "done"
    );

    out.push({
      id: (m as any).id,
      orderId: matched ? (matched as any).id : null,
      membershipId: (m as any).id,
      centerId: (m as any).center_id,
      centerName: (m as any).centers?.name ?? "센터",
      productName: (m as any).product_name,
      amount: matched ? (matched as any).amount : 0,
      status: st,
      purchasedAt: KST_DT_FULL.format(new Date(created)),
      createdAtIso: created,
      totalCount: total, remainingCount: remain,
      selectedSize: (m as any).selected_size ?? null,
      refundable, refundReason: reason,
      cancellable: false, // 이미 발급됨 — 취소가 아니라 환불(refundable) 경로
      kind: ((m as any).products?.product_kind === "goods" ? "goods" : "pass"),
    });
  }

  // 아직 발급 안 된 주문(대기중)도 표시
  for (const o of ords ?? []) {
    if ((o as any).status === "done") continue;   // 발급된 건 위에서 처리
    // P1-2: pending/paid(= 아직 매니저가 처리 전)는 회원이 직접 취소할 수 있다
    // (add_order_self_cancel.sql의 "주문 본인 취소" RLS 정책). cancelled는 이미 취소된
    // 것이라 다시 취소 버튼을 보여줄 필요 없음.
    const st = (o as any).status;
    const cancellable = st === "pending" || st === "paid";
    out.push({
      id: (o as any).id,
      orderId: (o as any).id,
      membershipId: null,
      centerId: (o as any).center_id,
      centerName: (o as any).centers?.name ?? "센터",
      productName: (o as any).product_name,
      amount: (o as any).amount,
      status: st,
      purchasedAt: KST_DT_FULL.format(new Date((o as any).created_at)),
      createdAtIso: (o as any).created_at,
      // 미발급 주문: 구매 횟수 선택형이면 고른 횟수/사이즈를 보여준다("5회 · 240mm").
      totalCount: (o as any).selected_count ?? null, remainingCount: null,
      selectedSize: (o as any).selected_size ?? null,
      refundable: false,
      refundReason: cancellable ? "" : "취소된 주문이에요",
      cancellable,
      kind: "pass",
    });
  }

  return out.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
}
