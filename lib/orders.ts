/*
  주문/결제
  - 회원이 수강권·상품 구매 시 주문 생성 (pending)
  - 결제 수단은 나중에 연동 (지금은 주문서 → 매니저 확인)
  - 매니저가 주문 확인/완료 처리
*/

import { supabase } from "./supabaseClient";

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
};

// 회원: 주문 생성 (결제 화면에서 "결제하기" 시)
// [SEC-118] amount는 더 이상 클라이언트가 넘기지 않는다 — create_order_secure() RPC가
// products.price를 서버에서 직접 조회해 계산한다(포인트 사용도 RPC 내부에서 use_points()로
// 원자적으로 처리 — 호출부에서 미리 usePoints()를 호출해두지 않아도 됨, pointUsed만 전달).
// 쿠폰(coupon_code/discount_amount)은 서버 검증이 없는 데모 기능이라 이 경로에서는 반영하지
// 않는다(docs/25_SEC118_Orders_Amount_Design.md 참고) — 실제 쿠폰 시스템이 생기면 별도 확장.
// provider: Payment Adapter가 이 주문을 처리할 provider("mock"/"toss"/"portone"). 생략 시 null
//   (레거시 경로 — 매니저가 /manager/orders에서 수동 확인).
export async function createOrder(input: {
  productId: string; payMethod?: string; selectedSize?: string;
  pointUsed?: number; autoBook?: boolean;
  provider?: "mock" | "toss" | "portone";
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_order_secure", {
    p_product_id: input.productId,
    p_pay_method: input.payMethod ?? null,
    p_selected_size: input.selectedSize ?? null,
    p_point_used: input.pointUsed ?? 0,
    p_auto_book: input.autoBook ?? false,
    p_provider: input.provider ?? null,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return data as string;
}

// 회원: 내 주문 내역
export async function fetchMyOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, center_id, profile_id, product_id, product_name, amount, pay_method, status, created_at, paid_at, centers(name)")
    .order("created_at", { ascending: false });
  if (error) throw new Error("주문 내역을 불러오지 못했어요: " + error.message);
  return (data ?? []).map(mapOrder);
}

// 매니저: 자기 센터 주문 목록
export async function fetchCenterOrders(centerId: string, status?: string): Promise<(Order & { memberName: string; memberPhone: string | null })[]> {
  let q = supabase
    .from("orders")
    .select("id, center_id, profile_id, product_id, product_name, amount, pay_method, status, created_at, paid_at, profiles(name, accounts(phone))")
    .eq("center_id", centerId)
    .order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error("주문을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((o: any) => ({
    ...mapOrder(o),
    memberName: o.profiles?.name ?? "회원",
    memberPhone: o.profiles?.accounts?.phone ?? null,
  }));
}

// 매니저: 주문 처리 완료 (수강권 발급 + 매출 연동) 또는 취소
export async function updateOrderStatus(
  orderId: string, status: "done" | "cancelled"
): Promise<void> {
  if (status === "done") {
    // 수강권 자동 발급 + 매출 자동 기록 (+ 요일반이면 자동예약).
    // fulfill_order()는 { already_done, membership_id, amount }만 반환하고 자동예약 결과(개수/
    // 미배치 여부)는 반환하지 않는다 — 그 값을 기대하는 코드를 여기 두지 않는다(Track B에서
    // 발견: 이전에는 존재하지 않는 auto_booked/remaining 필드를 읽어 항상 무시되는 죽은 분기가
    // 있었다). RPC 반환값을 바꾸려면 SQL 변경이 필요해 이번 배치 범위 밖이다.
    const { error } = await supabase.rpc("fulfill_order", { p_order_id: orderId });
    if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
    return;
  }
  const { error } = await supabase.from("orders").update({ status }).eq("id", orderId);
  if (error) throw new Error("주문 상태 변경에 실패했어요: " + error.message);
}

function mapOrder(o: any): Order & { centerName?: string } {
  return {
    id: o.id, centerId: o.center_id, profileId: o.profile_id,
    productId: o.product_id, productName: o.product_name, amount: o.amount,
    payMethod: o.pay_method, status: o.status, createdAt: o.created_at, paidAt: o.paid_at,
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
  refundable: boolean;
  refundReason: string;
  kind: "pass" | "goods";
};

const KST_DT_FULL = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export async function fetchMyPurchases(): Promise<PurchaseItem[]> {
  // 발급된 수강권 (환불 가능 판단 대상)
  const { data: mems } = await supabase
    .from("memberships")
    .select("id, center_id, product_id, product_name, total_count, remaining_count, status, created_at, centers(name), products(product_kind)")
    .order("created_at", { ascending: false })
    .limit(100);

  // 주문 (아직 발급 안 된 것 포함)
  const { data: ords } = await supabase
    .from("orders")
    .select("id, center_id, product_name, amount, status, created_at, centers(name)")
    .order("created_at", { ascending: false })
    .limit(100);

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
      refundable, refundReason: reason,
      kind: ((m as any).products?.product_kind === "goods" ? "goods" : "pass"),
    });
  }

  // 아직 발급 안 된 주문(대기중)도 표시
  for (const o of ords ?? []) {
    if ((o as any).status === "done") continue;   // 발급된 건 위에서 처리
    out.push({
      id: (o as any).id,
      orderId: (o as any).id,
      membershipId: null,
      centerId: (o as any).center_id,
      centerName: (o as any).centers?.name ?? "센터",
      productName: (o as any).product_name,
      amount: (o as any).amount,
      status: (o as any).status,
      purchasedAt: KST_DT_FULL.format(new Date((o as any).created_at)),
      createdAtIso: (o as any).created_at,
      totalCount: null, remainingCount: null,
      refundable: false,
      refundReason: "센터 확인 대기 중이에요",
      kind: "pass",
    });
  }

  return out.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
}
