/*
  매니저 - 수업매출 캘린더
  - 결제일이 아니라 "수업이 실제로 열린 날짜" 기준 매출 조회
  - 날짜별 요약(캘린더) + 특정 날짜 상세 breakdown + 회차별 금액 커스텀
*/

import { supabase } from "./supabaseClient";

export type ClassRevenueDaily = {
  date: string;           // "2026-08-16"
  classRevenue: number;   // 수업(횟수제 회차 + 정기권 usage_split)에 귀속된 매출
  periodPassRevenue: number; // 정기권이 purchase_date_full 모드일 때의 구매일 전액
  goodsRevenue: number;   // 상품(대여품 등, 수업과 무관) 매출
  refundAmount: number;   // 환불(음수)
  total: number;
};

export type ClassRevenueRowType = "class" | "period_pass" | "goods" | "refund";

export type ClassRevenueRow = {
  type: ClassRevenueRowType;
  classId: string | null;
  classTitle: string | null;
  time: string | null;      // ISO, 수업 시작 시각(type='class'만)
  place: string | null;
  productName: string | null; // type='period_pass'|'goods'만
  profileName: string;
  amount: number;
  // 횟수제(count) 수강권의 회차 귀속인 경우만 채워짐(정기권 usage_split 행은 회차
  // 개념이 없어 전부 null) — "회차별 금액 편집" UI를 여기서 띄운다.
  membershipId: string | null;
  sessionIndex: number | null;
  totalSessions: number | null;
};

// 기간별 날짜 요약 (캘린더 그리드용)
export async function fetchClassRevenueDaily(
  centerId: string, fromDate: string, toDate: string
): Promise<ClassRevenueDaily[]> {
  const { data, error } = await supabase.rpc("class_revenue_daily_summary", {
    p_center_id: centerId, p_from: fromDate, p_to: toDate,
  });
  if (error) throw new Error("수업매출을 불러오지 못했어요: " + error.message);
  return (data as ClassRevenueDaily[]) ?? [];
}

// 특정 날짜 상세 breakdown
export async function fetchClassRevenueForDate(
  centerId: string, date: string
): Promise<ClassRevenueRow[]> {
  const { data, error } = await supabase.rpc("class_revenue_for_date", {
    p_center_id: centerId, p_date: date,
  });
  if (error) throw new Error("그날의 수업매출을 불러오지 못했어요: " + error.message);
  return (data as ClassRevenueRow[]) ?? [];
}

// 횟수제 수강권의 회차별(1회차..총횟수) 금액 커스텀 저장 (합계는 그 수강권의 총
// 결제금액과 정확히 일치해야 함 — 안 맞으면 서버에서 거부됨)
export async function setMembershipSessionAmounts(
  membershipId: string, amounts: number[]
): Promise<void> {
  const { error } = await supabase.rpc("set_membership_session_amounts", {
    p_membership_id: membershipId, p_amounts: amounts,
  });
  if (error) throw new Error("회차별 금액 저장에 실패했어요: " + error.message);
}

// 같은 classId로 묶어서 "이 수업으로 총 얼마" 표시용 그룹핑
export type ClassRevenueGroup = {
  key: string;              // classId 또는 (type이 class가 아니면) `${type}-${index}`
  type: ClassRevenueRowType;
  classId: string | null;
  classTitle: string | null;
  time: string | null;
  place: string | null;
  productName: string | null;
  total: number;
  rows: ClassRevenueRow[];  // 회원별 상세(클릭 시 펼침)
};

export function groupClassRevenueRows(rows: ClassRevenueRow[]): ClassRevenueGroup[] {
  const groups: Record<string, ClassRevenueGroup> = {};
  const order: string[] = [];
  rows.forEach((r, i) => {
    const key = r.type === "class" && r.classId ? r.classId : `${r.type}-${i}`;
    if (!groups[key]) {
      groups[key] = {
        key, type: r.type, classId: r.classId, classTitle: r.classTitle,
        time: r.time, place: r.place, productName: r.productName,
        total: 0, rows: [],
      };
      order.push(key);
    }
    groups[key].total += r.amount;
    groups[key].rows.push(r);
  });
  return order.map((k) => groups[k]);
}

// 회차별 금액 편집 모달 초기값 계산 — RPC(set_membership_session_amounts)의 검증
// 로직(합계=총결제액)과 기본 분배(균등분배+나머지 앞회차 보정)를 그대로 클라이언트에서
// 재현해, "기본값"으로 보여주는 금액이 실제 서버 계산과 항상 일치하게 한다.
export type MembershipSessionEditData = {
  totalCount: number;
  paidTotal: number;
  amounts: number[]; // 길이 = totalCount, 1회차부터 순서대로
};

export async function fetchMembershipSessionEditData(
  membershipId: string
): Promise<MembershipSessionEditData> {
  const [{ data: mem, error: memErr }, { data: payRows, error: payErr }, { data: overrides, error: ovErr }] =
    await Promise.all([
      supabase.from("memberships").select("total_count").eq("id", membershipId).single(),
      supabase.from("payments").select("total_amount").eq("membership_id", membershipId).neq("sale_type", "refund"),
      supabase.from("membership_session_amounts").select("session_index, amount").eq("membership_id", membershipId),
    ]);
  if (memErr || !mem) throw new Error("수강권 정보를 불러오지 못했어요: " + memErr?.message);
  if (payErr) throw new Error("결제 내역을 불러오지 못했어요: " + payErr.message);
  if (ovErr) throw new Error("회차별 금액을 불러오지 못했어요: " + ovErr.message);

  const totalCount = mem.total_count ?? 0;
  const paidTotal = (payRows ?? []).reduce((sum, p: any) => sum + (p.total_amount ?? 0), 0);
  const overrideMap = new Map<number, number>();
  for (const o of overrides ?? []) overrideMap.set((o as any).session_index, (o as any).amount);

  const base = totalCount > 0 ? Math.floor(paidTotal / totalCount) : 0;
  const remainder = totalCount > 0 ? paidTotal % totalCount : 0;
  const amounts: number[] = [];
  for (let i = 1; i <= totalCount; i++) {
    amounts.push(overrideMap.has(i) ? overrideMap.get(i)! : base + (i <= remainder ? 1 : 0));
  }
  return { totalCount, paidTotal, amounts };
}
