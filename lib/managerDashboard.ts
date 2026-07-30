/*
  관리자 홈 대시보드 데이터 함수
  - add_manager_dashboard_summary.sql의 manager_dashboard_summary RPC를 감쌈 (단일 호출 집계)
*/

import { supabase } from "./supabaseClient";

export type DashboardSummary = {
  classCount: number;
  confirmedCount: number;
  cancelledCount: number;
  memberCount: number;
  activeMemberCount: number;
  activeMembershipCount: number;
  adminAssignmentCount: number;
  adminFreeCount: number;
};

export type DashboardPeriod = "today" | "7d" | "30d";

function periodToRange(period: DashboardPeriod): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (period === "today") return { from: today, to: today };
  const days = period === "7d" ? 7 : 30;
  const from = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return { from, to: today };
}

export async function fetchDashboardSummary(centerId: string, period: DashboardPeriod): Promise<DashboardSummary> {
  const { from, to } = periodToRange(period);
  const { data, error } = await supabase.rpc("manager_dashboard_summary", {
    p_center_id: centerId, p_from: from, p_to: to,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const r = data as any;
  return {
    classCount: r.class_count ?? 0,
    confirmedCount: r.confirmed_count ?? 0,
    cancelledCount: r.cancelled_count ?? 0,
    memberCount: r.member_count ?? 0,
    activeMemberCount: r.active_member_count ?? 0,
    activeMembershipCount: r.active_membership_count ?? 0,
    adminAssignmentCount: r.admin_assignment_count ?? 0,
    adminFreeCount: r.admin_free_count ?? 0,
  };
}
