/*
  매니저 - 매출 관리
  - 결제 등록 (분할결제: 카드/현금/이체/포인트, 매출구분, 미수금)
  - 매출 조회 (기간별 합계, 구분별·수단별 집계, 목록)
*/

import { supabase } from "./supabaseClient";

export const SALE_TYPE_LABEL: Record<string, string> = {
  new: "신규결제",
  renew: "재결제",
  trial: "체험",
  upgrade: "업그레이드",
  refund: "환불",
  unpaid_pay: "미수금 결제",
  transfer_fee: "양도수수료",
};

export const METHOD_LABEL: Record<string, string> = {
  card: "카드",
  cash: "현금",
  transfer: "계좌이체",
  point: "포인트",
  direct: "직접결제",
};

export type PaymentInput = {
  centerId: string;
  profileId: string;
  membershipId?: string | null;
  // 상품을 선택하면 그 상품으로 수강권(memberships)을 새로 발급하고 결제에 연결
  productId?: string | null;
  productName?: string | null;
  productCount?: number | null;
  validDays?: number | null;
  // 추가 상품(대여·물품 등)도 함께 발급 (선택)
  extraProducts?: { id: string; name: string; count: number | null; unlimited: boolean }[];
  saleType: string;
  cardAmount: number;
  cashAmount: number;
  transferAmount: number;
  pointAmount: number;
  unpaidAmount: number;
  trainerAccountId?: string | null;
  paidAt: string;      // "2026-07-18"
  memo?: string;
};

export type PaymentRow = {
  id: string;
  profileName: string;
  saleType: string;
  productName: string | null;
  cardAmount: number;
  cashAmount: number;
  transferAmount: number;
  pointAmount: number;
  directAmount: number;
  totalAmount: number;
  unpaidAmount: number;
  trainerName: string | null;
  paidAt: string;
  paidAtFull: string;   // 시·분 포함 (상세 표시용)
  memo: string | null;
};

export type RevenueSummary = {
  totalSales: number;        // 순매출 (환불 반영)
  totalUnpaid: number;       // 미수금 합계
  byMethod: Record<string, number>;   // 결제수단별
  bySaleType: Record<string, number>; // 매출구분별
  count: number;
};

const KST_DATE = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
});
// 결제 상세용 (시·분까지)
const KST_DATETIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

// 결제 등록
export async function registerPayment(p: PaymentInput): Promise<void> {
  const total =
    p.cardAmount + p.cashAmount + p.transferAmount + p.pointAmount;
  // 환불이면 합계를 음수로 저장 (매출 집계에서 자동 차감됨)
  const signedTotal = p.saleType === "refund" ? -Math.abs(total) : total;

  // 상품이 선택됐고 환불이 아니면 → 수강권(memberships) 새로 발급
  let membershipId = p.membershipId ?? null;
  if (p.productId && p.saleType !== "refund") {
    const days = p.validDays && p.validDays > 0 ? p.validDays : 60;
    const expires = new Date();
    expires.setDate(expires.getDate() + days);
    const { data: mem, error: memErr } = await supabase
      .from("memberships")
      .insert({
        profile_id: p.profileId,
        center_id: p.centerId,
        product_id: p.productId,
        product_name: p.productName ?? "수강권",
        pass_type: "count",
        total_count: p.productCount ?? null,
        remaining_count: p.productCount ?? null,
        expires_at: expires.toISOString().slice(0, 10),
        status: "active",
      })
      .select("id")
      .single();
    if (memErr) throw new Error("수강권 발급에 실패했어요: " + memErr.message);
    membershipId = mem.id;
  }

  // 추가 상품(대여·물품 등)도 발급 (환불 아닐 때)
  if (p.extraProducts && p.extraProducts.length > 0 && p.saleType !== "refund") {
    const expires = new Date();
    expires.setDate(expires.getDate() + (p.validDays && p.validDays > 0 ? p.validDays : 60));
    const rows = p.extraProducts.map((g) => ({
      profile_id: p.profileId,
      center_id: p.centerId,
      product_id: g.id,
      product_name: g.name,
      pass_type: "count",
      total_count: g.unlimited ? null : g.count,
      remaining_count: g.unlimited ? null : g.count,
      expires_at: expires.toISOString().slice(0, 10),
      status: "active",
    }));
    const { error: gErr } = await supabase.from("memberships").insert(rows);
    if (gErr) throw new Error("상품 발급에 실패했어요: " + gErr.message);
  }

  const { error } = await supabase.from("payments").insert({
    center_id: p.centerId,
    profile_id: p.profileId,
    membership_id: membershipId,
    sale_type: p.saleType,
    revenue_category: "membership",
    card_amount: p.cardAmount,
    cash_amount: p.cashAmount,
    transfer_amount: p.transferAmount,
    point_amount: p.pointAmount,
    total_amount: signedTotal,
    unpaid_amount: p.unpaidAmount,
    trainer_account_id: p.trainerAccountId ?? null,
    paid_at: p.paidAt,
    memo: p.memo ?? null,
    status: "paid",
  });
  if (error) throw new Error("결제 등록에 실패했어요: " + error.message);
}

// 기간별 결제 목록
export async function fetchPayments(
  centerId: string,
  fromDate: string,
  toDate: string
): Promise<PaymentRow[]> {
  const { data, error } = await supabase
    .from("payments")
    .select(`
      id, sale_type, card_amount, cash_amount, transfer_amount, point_amount, direct_amount,
      total_amount, unpaid_amount, paid_at, memo,
      profiles(name),
      accounts(name),
      memberships(product_name)
    `)
    .eq("center_id", centerId)
    .gte("paid_at", fromDate)
    .lte("paid_at", toDate + "T23:59:59+09:00")
    .order("paid_at", { ascending: false });
  if (error) throw new Error("매출 내역을 불러오지 못했어요: " + error.message);

  return (data ?? []).map((r: any) => ({
    id: r.id,
    profileName: r.profiles?.name ?? "(회원)",
    saleType: r.sale_type,
    productName: r.memberships?.product_name ?? null,
    cardAmount: r.card_amount,
    cashAmount: r.cash_amount,
    transferAmount: r.transfer_amount,
    pointAmount: r.point_amount,
    directAmount: r.direct_amount ?? 0,
    totalAmount: r.total_amount,
    unpaidAmount: r.unpaid_amount,
    trainerName: r.accounts?.name ?? null,
    paidAt: KST_DATE.format(new Date(r.paid_at)),
    paidAtFull: KST_DATETIME.format(new Date(r.paid_at)),
    memo: r.memo,
  }));
}

// 집계 (목록에서 계산 — 별도 쿼리 없이)
export function summarize(rows: PaymentRow[]): RevenueSummary {
  const s: RevenueSummary = {
    totalSales: 0, totalUnpaid: 0, byMethod: {}, bySaleType: {}, count: rows.length,
  };
  for (const r of rows) {
    s.totalSales += r.totalAmount;
    s.totalUnpaid += r.unpaidAmount;
    s.byMethod.card = (s.byMethod.card ?? 0) + r.cardAmount;
    s.byMethod.cash = (s.byMethod.cash ?? 0) + r.cashAmount;
    s.byMethod.transfer = (s.byMethod.transfer ?? 0) + r.transferAmount;
    s.byMethod.point = (s.byMethod.point ?? 0) + r.pointAmount;
    s.byMethod.direct = (s.byMethod.direct ?? 0) + (r.directAmount ?? 0);
    s.bySaleType[r.saleType] = (s.bySaleType[r.saleType] ?? 0) + r.totalAmount;
  }
  return s;
}

// 결제 등록 화면용: 센터 회원 목록 (이름/프로필)
export async function fetchCenterMembersForPayment(
  centerId: string
): Promise<{ profileId: string; name: string }[]> {
  const { data, error } = await supabase
    .from("center_members")
    .select("profile_id, profiles(name)")
    .eq("center_id", centerId);
  if (error) throw new Error("회원 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    profileId: r.profile_id,
    name: r.profiles?.name ?? "(이름 없음)",
  }));
}

// 담당 강사 선택용: 센터 스태프 목록
export async function fetchCenterStaffForPayment(
  centerId: string
): Promise<{ accountId: string; name: string }[]> {
  const { data, error } = await supabase
    .from("manager_centers")
    .select("account_id, accounts(name)")
    .eq("center_id", centerId)
    .eq("status", "active");
  if (error) throw new Error("강사 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    accountId: r.account_id,
    name: r.accounts?.name ?? "(이름 없음)",
  }));
}

export function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}

/* ============================================================
   지출 (expenses)
   ============================================================ */

export const EXPENSE_CATEGORIES = ["임대료", "강사료", "인건비", "비품", "마케팅", "공과금", "기타"];

export type ExpenseInput = {
  centerId: string;
  category: string;
  amount: number;
  spentAt: string;   // "2026-07-18"
  memo?: string;
};

export type ExpenseRow = {
  id: string;
  category: string;
  amount: number;
  spentAt: string;
  memo: string | null;
};

export async function registerExpense(e: ExpenseInput): Promise<void> {
  const { error } = await supabase.from("expenses").insert({
    center_id: e.centerId,
    category: e.category,
    amount: e.amount,
    spent_at: e.spentAt,
    memo: e.memo ?? null,
  });
  if (error) throw new Error("지출 등록에 실패했어요: " + error.message);
}

export async function fetchExpenses(centerId: string, fromDate: string, toDate: string): Promise<ExpenseRow[]> {
  const { data, error } = await supabase
    .from("expenses")
    .select("id, category, amount, spent_at, memo")
    .eq("center_id", centerId)
    .gte("spent_at", fromDate)
    .lte("spent_at", toDate)
    .order("spent_at", { ascending: false });
  if (error) throw new Error("지출 내역을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id, category: r.category, amount: r.amount,
    spentAt: r.spent_at, memo: r.memo,
  }));
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw new Error("지출 삭제에 실패했어요: " + error.message);
}

// 지출 합계 + 카테고리별
export function summarizeExpenses(rows: ExpenseRow[]): { total: number; byCategory: Record<string, number> } {
  const r = { total: 0, byCategory: {} as Record<string, number> };
  for (const e of rows) {
    r.total += e.amount;
    r.byCategory[e.category] = (r.byCategory[e.category] ?? 0) + e.amount;
  }
  return r;
}

/* ============================================================
   포인트 (point_transactions)
   ============================================================ */

export type PointInput = {
  centerId: string;
  profileId: string;
  amount: number;    // 적립 +, 사용 -
  reason?: string;
};

export type PointRow = {
  id: string;
  profileId: string;
  profileName: string;
  amount: number;
  balanceAfter: number;   // 이 거래 직후 그 회원의 잔여 포인트
  reason: string | null;
  createdAt: string;
};

export async function registerPoint(p: PointInput): Promise<void> {
  const { error } = await supabase.from("point_transactions").insert({
    center_id: p.centerId,
    profile_id: p.profileId,
    amount: p.amount,
    reason: p.reason ?? null,
  });
  if (error) throw new Error("포인트 등록에 실패했어요: " + error.message);
}

export async function fetchPoints(centerId: string): Promise<PointRow[]> {
  const { data, error } = await supabase
    .from("point_transactions")
    .select("id, profile_id, amount, reason, created_at, profiles(name)")
    .eq("center_id", centerId)
    .order("created_at", { ascending: true })   // 오래된 것부터 → 누적 잔액 계산
    .limit(300);
  if (error) throw new Error("포인트 내역을 불러오지 못했어요: " + error.message);

  // 회원별로 누적 잔액을 계산하면서 각 거래 직후 잔액을 기록
  const running: Record<string, number> = {};
  const asc: PointRow[] = (data ?? []).map((r: any) => {
    const pid = r.profile_id;
    running[pid] = (running[pid] ?? 0) + r.amount;
    return {
      id: r.id,
      profileId: pid,
      profileName: r.profiles?.name ?? "(회원)",
      amount: r.amount,
      balanceAfter: running[pid],
      reason: r.reason,
      createdAt: KST_DATE.format(new Date(r.created_at)),
    };
  });
  // 화면에는 최근 거래부터 보여줌
  return asc.reverse();
}

// 회원별 포인트 잔액 (센터 내)
export async function fetchPointBalances(centerId: string): Promise<{ profileId: string; name: string; balance: number }[]> {
  const { data, error } = await supabase
    .from("point_transactions")
    .select("profile_id, amount, profiles(name)")
    .eq("center_id", centerId);
  if (error) throw new Error("포인트 잔액을 불러오지 못했어요: " + error.message);
  const map: Record<string, { name: string; balance: number }> = {};
  for (const r of data ?? []) {
    const pid = (r as any).profile_id;
    if (!map[pid]) map[pid] = { name: (r as any).profiles?.name ?? "(회원)", balance: 0 };
    map[pid].balance += (r as any).amount;
  }
  return Object.entries(map).map(([profileId, v]) => ({ profileId, name: v.name, balance: v.balance }));
}

// 결제 등록 시 선택할 수강권 상품 목록
export async function fetchSaleProducts(centerId: string): Promise<{ id: string; name: string; price: number; totalCount: number | null; kind: "pass" | "goods"; unlimited: boolean }[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, price, total_count, product_kind, unlimited")
    .eq("center_id", centerId)
    .eq("is_active", true)
    .eq("is_on_sale", true)
    .order("created_at", { ascending: false });
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((p: any) => ({
    id: p.id, name: p.name, price: p.price, totalCount: p.total_count,
    kind: p.product_kind === "goods" ? "goods" : "pass",
    unlimited: p.unlimited ?? false,
  }));
}

// 매출 CSV 내보내기 (항목 선택)
export function paymentsToCsv(rows: PaymentRow[], columns: string[]): string {
  const SALE_LABEL: Record<string, string> = { new: "신규", renew: "재등록", refund: "환불", extra: "추가" };
  const ALL: Record<string, { label: string; get: (r: PaymentRow) => string }> = {
    profileName: { label: "회원", get: (r) => r.profileName },
    saleType: { label: "구분", get: (r) => SALE_LABEL[r.saleType] ?? r.saleType },
    productName: { label: "상품/수강권", get: (r) => r.productName ?? "" },
    paidAt: { label: "결제일", get: (r) => r.paidAt },
    trainerName: { label: "담당", get: (r) => r.trainerName ?? "" },
    cardAmount: { label: "카드", get: (r) => String(r.cardAmount) },
    cashAmount: { label: "현금", get: (r) => String(r.cashAmount) },
    transferAmount: { label: "계좌이체", get: (r) => String(r.transferAmount) },
    pointAmount: { label: "포인트", get: (r) => String(r.pointAmount) },
    totalAmount: { label: "합계", get: (r) => String(r.totalAmount) },
    unpaidAmount: { label: "미수금", get: (r) => String(r.unpaidAmount) },
    memo: { label: "메모", get: (r) => r.memo ?? "" },
  };
  const cols = columns.filter((c) => ALL[c]);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = cols.map((c) => esc(ALL[c].label)).join(",");
  const body = rows.map((r) => cols.map((c) => esc(ALL[c].get(r))).join(",")).join("\n");
  return "\uFEFF" + header + "\n" + body;
}
