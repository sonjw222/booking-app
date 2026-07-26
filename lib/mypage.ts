/*
  마이페이지 데이터 함수
  - 프로필, 수강권(잔여/유효기간), 예약내역, 출석기록 조회
*/

import { supabase } from "./supabaseClient";

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
  expiresAt: string; // "2026-10-31"
  createdAt: string; // 구매 시각 (환불 24시간 판단용)
  profileName: string; // 어느 프로필 것인지 (대표면 "")
};

export type HistoryItem = {
  id: string;
  title: string;
  centerName: string;
  when: string; // "2026-07-14 20:00"
  status: "confirmed" | "waitlisted" | "cancelled" | "attended" | "no_show";
  profileName: string; // 어느 프로필 것인지 (대표면 "")
};

const KST_DT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function fmtDateTime(iso: string) {
  return KST_DT.format(new Date(iso)).replace(/\. /g, "-").replace(".", "").replace(",", "");
}

async function getMyContext(): Promise<{ accountId: string; profileId: string; name: string; phone: string | null; isMember: boolean; isManager: boolean; isPlatformAdmin: boolean }> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data: acc, error: accErr } = await supabase
    .from("accounts").select("id, name, phone, is_member, is_manager, is_platform_admin")
    .eq("auth_id", authData.user.id).single();
  if (accErr || !acc) throw new Error("계정 정보를 찾을 수 없어요");
  // 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 사용
  // (대표 프로필이 없거나 2개 이상이면 single() 이 실패하므로 방어)
  const { data: profs, error: profErr } = await supabase
    .from("profiles").select("id, is_primary, created_at")
    .eq("account_id", acc.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const prof = profs?.[0];
  if (profErr) throw new Error("프로필을 불러오지 못했어요: " + profErr.message);
  if (!prof) throw new Error("프로필이 없어요. 관리자에게 문의하거나 다시 가입해주세요.");
  return { accountId: acc.id, profileId: prof.id, name: acc.name, phone: acc.phone, isMember: acc.is_member, isManager: acc.is_manager, isPlatformAdmin: acc.is_platform_admin ?? false };
}

export async function fetchMyPage() {
  const me = await getMyContext();

  // 내 모든 프로필 (대표 + 자녀 등 추가 프로필)
  const { data: profRows } = await supabase
    .from("profiles")
    .select("id, name, nickname, label, is_primary")
    .eq("account_id", me.accountId)
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
    .select("id, profile_id, bound_profile_id, center_id, product_id, product_name, total_count, remaining_count, expires_at, created_at, centers(name), products(product_kind, unlimited)")
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
      createdAt: m.created_at,
      profileName: m.bound_profile_id ? (profileLabel[m.bound_profile_id] ?? "") : "",
    }));

  // 예약내역 (모든 프로필, 최근순)
  const { data: resRows, error: resErr } = await supabase
    .from("reservations")
    .select("id, profile_id, status, created_at, classes(title, start_time, centers(name))")
    .in("profile_id", profileIds)
    .order("created_at", { ascending: false })
    .limit(50);
  if (resErr) throw new Error("예약내역을 불러오지 못했어요: " + resErr.message);

  const history: HistoryItem[] = (resRows ?? []).map((r: any) => ({
    id: r.id,
    title: r.classes?.title ?? "",
    centerName: r.classes?.centers?.name ?? "",
    when: r.classes?.start_time ? fmtDateTime(r.classes.start_time) : "",
    status: r.status,
    profileName: profileLabel[r.profile_id] ?? "",
  }));

  const profile: Profile = { name: me.name, phone: me.phone, isMember: me.isMember, isManager: me.isManager, isPlatformAdmin: me.isPlatformAdmin };

  return { profile, memberships, history };
}

export async function logout() {
  await supabase.auth.signOut();
  window.location.href = "/login";
}

/* ============================================================
   전체 예약 내역 (수강권 구매 이후 과거 수업까지 날짜별)
   ============================================================ */

export type FullHistoryItem = {
  id: string;
  title: string;
  centerName: string;
  lessonDate: string;   // "2026-07-14"
  timeText: string;     // "19:30"
  status: "confirmed" | "waitlisted" | "cancelled" | "attended" | "no_show";
  profileName: string;
};

const KST_DATE_ONLY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });
const KST_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
});

export async function fetchFullHistory(): Promise<FullHistoryItem[]> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return [];
  const { data: acc } = await supabase
    .from("accounts").select("id").eq("auth_id", authData.user.id).maybeSingle();
  if (!acc) return [];

  const { data: profRows } = await supabase
    .from("profiles").select("id, name, label, is_primary").eq("account_id", acc.id);
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
    .from("reservations")
    .select("id, profile_id, status, classes(title, start_time, centers(name))")
    .in("profile_id", profileIds)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error("예약 내역을 불러오지 못했어요: " + error.message);

  return (data ?? [])
    .filter((r: any) => r.classes?.start_time)
    .map((r: any) => {
      const dt = new Date(r.classes.start_time);
      return {
        id: r.id,
        title: r.classes?.title ?? "",
        centerName: r.classes?.centers?.name ?? "",
        lessonDate: KST_DATE_ONLY.format(dt),
        timeText: KST_TIME.format(dt),
        status: r.status,
        profileName: profileLabel[r.profile_id] ?? "",
      };
    })
    // 수업 날짜 최신순
    .sort((a, b) => b.lessonDate.localeCompare(a.lessonDate) || b.timeText.localeCompare(a.timeText));
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
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data: acc } = await supabase.from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (!acc) throw new Error("계정을 찾을 수 없어요");

  const { data: profiles } = await supabase
    .from("profiles").select("id, name, nickname, label, is_primary").eq("account_id", acc.id);
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
    "PRODID:-//우리동네 클래스//예약//KR",
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
