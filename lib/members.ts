/*
  매니저 - 회원 관리
  - 센터에 등록된 회원 목록 (등급/상태 필터, 이름·전화 검색)
  - 회원 등급 관리 (생성/삭제)
  - 회원별 수강권 요약, 메모
  - CSV(엑셀) 내보내기용 데이터
*/

import { supabase } from "./supabaseClient";
import { getMessageService } from "./messaging";

export type Grade = {
  id: string;
  name: string;
  color: string | null;
};

export type CenterMember = {
  id: string;            // center_members.id
  profileId: string;
  name: string;
  phone: string | null;
  address: string | null;
  gradeId: string | null;
  gradeName: string | null;
  gradeColor: string | null;
  registeredAt: string;
  lastAttendedAt: string | null;
  appLinked: boolean;
  memo: string | null;
  status: "active" | "expired" | "dormant";
  hasPass: boolean;
  // 수강권 요약
  passName: string | null;
  remainingCount: number | null;
  expiresAt: string | null;
};

export type MemberFilter = {
  gradeId?: string | null;      // null이면 전체
  status?: string | null;       // active / expired / dormant, null이면 전체
  keyword?: string;             // 이름 또는 전화번호 (또는 주소)
  searchField?: "all" | "name" | "phone" | "address";
};

// 센터 등급 목록
export async function fetchGrades(centerId: string): Promise<Grade[]> {
  const { data, error } = await supabase
    .from("member_grades")
    .select("id, name, color")
    .eq("center_id", centerId)
    .order("sort_order");
  if (error) throw new Error("등급을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((g: any) => ({ id: g.id, name: g.name, color: g.color }));
}

export async function createGrade(centerId: string, name: string, color: string): Promise<void> {
  const { error } = await supabase
    .from("member_grades")
    .insert({ center_id: centerId, name, color });
  if (error) {
    if (error.message.includes("duplicate")) throw new Error("이미 있는 등급 이름이에요");
    throw new Error("등급 생성에 실패했어요: " + error.message);
  }
}

export async function deleteGrade(gradeId: string): Promise<void> {
  const { error } = await supabase.from("member_grades").delete().eq("id", gradeId);
  if (error) throw new Error("등급 삭제에 실패했어요: " + error.message);
}

// 센터 회원 목록
export async function fetchMembers(centerId: string, filter: MemberFilter = {}): Promise<CenterMember[]> {
  let q = supabase
    .from("center_members")
    .select(`
      id, profile_id, grade_id, registered_at, last_attended_at,
      app_linked, memo, status,
      profiles(name),
      member_grades(name, color)
    `)
    .eq("center_id", centerId);

  if (filter.gradeId) q = q.eq("grade_id", filter.gradeId);

  const { data, error } = await q.order("registered_at", { ascending: false });
  if (error) throw new Error("회원 목록을 불러오지 못했어요: " + error.message);

  const rows = data ?? [];
  const profileIds = rows.map((r: any) => r.profile_id);

  // 회원 연락처·주소는 accounts 에 있음 (profiles → accounts)
  const phoneByProfile: Record<string, string | null> = {};
  const addressByProfile: Record<string, string | null> = {};
  if (profileIds.length > 0) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, accounts(phone, address)")
      .in("id", profileIds);
    for (const p of profs ?? []) {
      phoneByProfile[(p as any).id] = (p as any).accounts?.phone ?? null;
      addressByProfile[(p as any).id] = (p as any).accounts?.address ?? null;
    }
  }

  // 수강권 전체 조회 → 회원 분류 계산 (수강권 보유자만 회원)
  const nowIso = new Date().toISOString();
  const passByProfile: Record<string, { name: string; remaining: number | null; expires: string }> = {};
  const passStateByProfile: Record<string, { hasUsable: boolean; hasAny: boolean }> = {};
  if (profileIds.length > 0) {
    const { data: passes } = await supabase
      .from("memberships")
      .select("profile_id, product_name, remaining_count, expires_at, pass_type, status")
      .eq("center_id", centerId)
      .in("profile_id", profileIds)
      .order("expires_at", { ascending: true });
    for (const m of passes ?? []) {
      const pid = (m as any).profile_id;
      const st = passStateByProfile[pid] ??= { hasUsable: false, hasAny: false };
      st.hasAny = true;
      // 사용 가능한 수강권인지: status active + (기간권이면 만료 전 / 횟수권이면 잔여>0)
      const active = (m as any).status === "active";
      const notExpired = !(m as any).expires_at || (m as any).expires_at >= nowIso.slice(0, 10);
      const remaining = (m as any).remaining_count;
      const hasCount = remaining == null || remaining > 0;
      if (active && notExpired && hasCount) st.hasUsable = true;
      // 대표 표시용 수강권 (사용가능한 것 우선, 없으면 첫 번째)
      if (!passByProfile[pid] || (active && notExpired && hasCount)) {
        if (!passByProfile[pid] || (active && notExpired && hasCount)) {
          passByProfile[pid] = {
            name: (m as any).product_name,
            remaining: (m as any).remaining_count,
            expires: (m as any).expires_at,
          };
        }
      }
    }
  }

  let list: CenterMember[] = rows.map((r: any) => {
    const st = passStateByProfile[r.profile_id];
    // 상태 계산: 수동 휴면(dormant) 우선 > 사용가능 수강권 있으면 이용중 > 수강권 있으나 소진/만료면 만료
    let derived: "active" | "expired" | "dormant";
    if (r.status === "dormant") derived = "dormant";
    else if (st?.hasUsable) derived = "active";
    else if (st?.hasAny) derived = "expired";
    else derived = "expired"; // 수강권 없음 (아래에서 걸러짐)
    return {
      id: r.id,
      profileId: r.profile_id,
      name: r.profiles?.name ?? "(이름 없음)",
      phone: phoneByProfile[r.profile_id] ?? null,
      address: addressByProfile[r.profile_id] ?? null,
      gradeId: r.grade_id,
      gradeName: r.member_grades?.name ?? null,
      gradeColor: r.member_grades?.color ?? null,
      registeredAt: r.registered_at,
      lastAttendedAt: r.last_attended_at,
      appLinked: r.app_linked,
      memo: r.memo,
      status: derived,
      hasPass: !!st?.hasAny,
      passName: passByProfile[r.profile_id]?.name ?? null,
      remainingCount: passByProfile[r.profile_id]?.remaining ?? null,
      expiresAt: passByProfile[r.profile_id]?.expires ?? null,
    };
  });

  // 회원 = 수강권을 보유했거나 보유했던 사람. 수강권 이력이 없으면 제외
  list = list.filter((m) => (m as any).hasPass);

  // 상태 필터 (파생 상태 기준)
  if (filter.status) {
    list = list.filter((m) => m.status === filter.status);
  }

  // 이름/전화/주소 검색은 조인 결과라서 클라이언트에서 필터
  const kw = filter.keyword?.trim();
  if (kw) {
    const kwNoDash = kw.replace(/-/g, "");
    const field = filter.searchField ?? "all";
    list = list.filter((m) => {
      const byName = m.name.includes(kw);
      const byPhone = (m.phone ?? "").replace(/-/g, "").includes(kwNoDash);
      const byAddr = (m.address ?? "").includes(kw);
      if (field === "name") return byName;
      if (field === "phone") return byPhone;
      if (field === "address") return byAddr;
      return byName || byPhone || byAddr;
    });
  }
  return list;
}

// 회원 등급 변경
export async function updateMemberGrade(memberId: string, gradeId: string | null): Promise<void> {
  const { error } = await supabase
    .from("center_members")
    .update({ grade_id: gradeId })
    .eq("id", memberId);
  if (error) throw new Error("등급 변경에 실패했어요: " + error.message);
}

// 회원 메모 저장 (회원에겐 보이지 않음)
export async function updateMemberMemo(memberId: string, memo: string): Promise<void> {
  const { error } = await supabase
    .from("center_members")
    .update({ memo })
    .eq("id", memberId);
  if (error) throw new Error("메모 저장에 실패했어요: " + error.message);
}

// 회원 주소 저장 (accounts.address) — profileId로 계정 찾아 저장
export async function updateMemberAddress(profileId: string, address: string): Promise<void> {
  const { data: prof } = await supabase
    .from("profiles").select("account_id").eq("id", profileId).single();
  if (!prof?.account_id) throw new Error("계정을 찾을 수 없어요");
  const { error } = await supabase
    .from("accounts").update({ address: address || null }).eq("id", prof.account_id);
  if (error) throw new Error("주소 저장에 실패했어요: " + error.message);
}

// 회원 상태 변경 (활성/만료/휴면) — 권한: customer.member.update (오너 자동 통과)
export async function updateMemberStatus(
  memberId: string, status: "active" | "expired" | "dormant"
): Promise<void> {
  // 현재 회원 정보 (dormant_since, center_id, profile_id)
  const { data: cm } = await supabase
    .from("center_members")
    .select("center_id, profile_id, status, dormant_since")
    .eq("id", memberId)
    .single();

  const patch: any = { status };

  if (status === "dormant") {
    // 휴면 시작 시각 기록 (기간권 차감 정지 기준점)
    patch.dormant_since = new Date().toISOString();
  } else if (cm?.status === "dormant" && cm?.dormant_since) {
    // 휴면 → 활성/만료 복귀: 휴면 기간만큼 기간권 만료일 연장
    const dormantDays = Math.floor((Date.now() - new Date(cm.dormant_since).getTime()) / 86400000);
    if (dormantDays > 0 && cm.center_id && cm.profile_id) {
      const { data: periodPasses } = await supabase
        .from("memberships")
        .select("id, expires_at, pass_type, status")
        .eq("profile_id", cm.profile_id)
        .eq("center_id", cm.center_id)
        .eq("status", "active");
      for (const p of periodPasses ?? []) {
        // 기간권만 연장 (횟수권은 시간 개념 없음)
        if ((p as any).pass_type === "period" && (p as any).expires_at) {
          const newExp = new Date(new Date((p as any).expires_at).getTime() + dormantDays * 86400000);
          await supabase.from("memberships")
            .update({ expires_at: newExp.toISOString().slice(0, 10) })
            .eq("id", (p as any).id);
        }
      }
    }
    patch.dormant_since = null;
  }

  const { error } = await supabase
    .from("center_members")
    .update(patch)
    .eq("id", memberId);
  if (error) throw new Error("회원 상태 변경에 실패했어요: " + error.message);
}

// 예약 이력이 있는데 아직 센터 회원으로 등록 안 된 사람을 자동 등록
//   (회원이 앱으로 예약하면 center_members 행이 없을 수 있음)
export async function syncMembersFromReservations(centerId: string): Promise<number> {
  const { data: resv } = await supabase
    .from("reservations")
    .select("profile_id, classes!inner(center_id)")
    .eq("classes.center_id", centerId);

  const fromResv = Array.from(new Set((resv ?? []).map((r: any) => r.profile_id)));
  if (fromResv.length === 0) return 0;

  const { data: existing } = await supabase
    .from("center_members")
    .select("profile_id")
    .eq("center_id", centerId);
  const have = new Set((existing ?? []).map((r: any) => r.profile_id));

  const missing = fromResv.filter((pid) => !have.has(pid));
  if (missing.length === 0) return 0;

  const { error } = await supabase.from("center_members").insert(
    missing.map((pid) => ({ center_id: centerId, profile_id: pid, app_linked: true }))
  );
  if (error) throw new Error("회원 동기화에 실패했어요: " + error.message);
  return missing.length;
}

// CSV 내보내기 (엑셀에서 열림)
export function membersToCsv(members: CenterMember[], columns: string[]): string {
  const ALL: Record<string, { label: string; get: (m: CenterMember) => string }> = {
    name: { label: "이름", get: (m) => m.name },
    grade: { label: "등급", get: (m) => m.gradeName ?? "" },
    phone: { label: "전화번호", get: (m) => m.phone ?? "" },
    registeredAt: { label: "등록일", get: (m) => m.registeredAt ?? "" },
    lastAttendedAt: { label: "최근출석일", get: (m) => m.lastAttendedAt ?? "" },
    appLinked: { label: "앱연결여부", get: (m) => (m.appLinked ? "연결됨" : "미연결") },
    status: { label: "상태", get: (m) => ({ active: "이용중", expired: "만료", dormant: "휴면" }[m.status] ?? m.status) },
    passName: { label: "수강권명", get: (m) => m.passName ?? "" },
    remainingCount: { label: "잔여횟수", get: (m) => (m.remainingCount == null ? "" : String(m.remainingCount)) },
    expiresAt: { label: "만료일", get: (m) => m.expiresAt ?? "" },
    memo: { label: "메모", get: (m) => m.memo ?? "" },
  };

  const cols = columns.filter((c) => ALL[c]);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = cols.map((c) => esc(ALL[c].label)).join(",");
  const body = members.map((m) => cols.map((c) => esc(ALL[c].get(m))).join(",")).join("\n");
  // 엑셀에서 한글이 깨지지 않도록 BOM 추가
  return "\uFEFF" + header + "\n" + body;
}

/* ============================================================
   회원 상세 - 예약이력 / 진도 / 결제내역
   ============================================================ */

const KST_MD2 = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" });

export type MemberDetailData = {
  reservations: { id: string; title: string; date: string; status: string }[];
  progress: { id: string; skill: string; date: string; note: string | null }[];
  payments: { id: string; amount: number; unpaid: number; saleType: string; date: string }[];
  activePasses: { id: string; name: string; remaining: number | null; expiresAt: string; kind: string }[];
  // 회원이 마이페이지에서 입력한 정보
  profileInfo: {
    birthDate: string | null; gender: string | null;
    shoeSize: string | null; clothSize: string | null;
    address: string | null; phone: string | null; memo: string | null;
  } | null;
};

export async function fetchMemberDetail(profileId: string): Promise<MemberDetailData> {
  // 예약 이력
  const { data: resv } = await supabase
    .from("reservations")
    .select("id, status, classes(title, start_time)")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(20);

  // 진도 기록
  const { data: prog } = await supabase
    .from("progress_records")
    .select("id, lesson_date, note, progress_categories(name)")
    .eq("profile_id", profileId)
    .order("lesson_date", { ascending: false })
    .limit(20);

  // 결제 내역
  const { data: pay } = await supabase
    .from("payments")
    .select("id, total_amount, unpaid_amount, sale_type, paid_at")
    .eq("profile_id", profileId)
    .order("paid_at", { ascending: false })
    .limit(20);

  // 보유 수강권
  // 회원이 입력한 프로필 정보
  const { data: prof } = await supabase
    .from("profiles")
    .select("birth_date, gender, shoe_size, cloth_size, address, phone, memo")
    .eq("id", profileId)
    .single();

  const { data: mem } = await supabase
    .from("memberships")
    .select("id, product_id, product_name, remaining_count, expires_at, status")
    .eq("profile_id", profileId)
    .eq("status", "active")
    .order("expires_at", { ascending: true });

  // 각 수강권의 종류(수강권/상품) 파악
  const prodIds = Array.from(new Set((mem ?? []).map((m: any) => m.product_id).filter(Boolean)));
  const kindById: Record<string, string> = {};
  if (prodIds.length > 0) {
    const { data: prods } = await supabase
      .from("products").select("id, product_kind").in("id", prodIds);
    for (const p of prods ?? []) kindById[(p as any).id] = (p as any).product_kind ?? "pass";
  }

  const fmt = (iso: string) => KST_MD2.format(new Date(iso));

  return {
    reservations: (resv ?? []).filter((r: any) => r.classes).map((r: any) => ({
      id: r.id,
      title: r.classes?.title ?? "",
      date: fmt(r.classes.start_time),
      status: r.status,
    })),
    progress: (prog ?? []).map((p: any) => ({
      id: p.id,
      skill: p.progress_categories?.name ?? "",
      date: p.lesson_date?.slice(5).replace("-", "/") ?? "",
      note: p.note ?? null,
    })),
    payments: (pay ?? []).map((p: any) => ({
      id: p.id,
      amount: p.total_amount,
      unpaid: p.unpaid_amount ?? 0,
      saleType: p.sale_type,
      date: p.paid_at ? fmt(p.paid_at) : "",
    })),
    activePasses: (mem ?? []).map((m: any) => ({
      id: m.id,
      name: m.product_name,
      remaining: m.remaining_count,
      expiresAt: m.expires_at,
      kind: m.product_id ? (kindById[m.product_id] ?? "pass") : "pass",
    })),
    profileInfo: prof ? {
      birthDate: (prof as any).birth_date ?? null,
      gender: (prof as any).gender ?? null,
      shoeSize: (prof as any).shoe_size ?? null,
      clothSize: (prof as any).cloth_size ?? null,
      address: (prof as any).address ?? null,
      phone: (prof as any).phone ?? null,
      memo: (prof as any).memo ?? null,
    } : null,
  };
}

/* ============================================================
   회원 직접 추가 (매니저가 신규 회원을 센터에 등록)
   - 이름/전화로 가입된 계정을 검색
   - 그 사람의 대표 프로필을 센터 회원으로 등록
   - 이래야 결제(수강권 발급) 대상에 뜸
   ============================================================ */

export async function searchAccountsForMember(
  keyword: string
): Promise<{ profileId: string; name: string; phone: string | null }[]> {
  const kw = keyword.trim();
  if (kw.length < 2) return [];

  // 1) 이름으로 대표 프로필 검색
  const byName = supabase
    .from("profiles")
    .select("id, name, is_primary, accounts(phone)")
    .ilike("name", `%${kw}%`)
    .eq("is_primary", true)
    .limit(20);

  // 2) 전화번호로 계정 검색 → 그 계정의 대표 프로필
  const digits = kw.replace(/[^0-9]/g, "");
  const results: { profileId: string; name: string; phone: string | null }[] = [];
  const seen = new Set<string>();

  const { data: nameData, error: nameErr } = await byName;
  if (nameErr) throw new Error("검색에 실패했어요: " + nameErr.message);
  for (const r of nameData ?? []) {
    if (seen.has((r as any).id)) continue;
    seen.add((r as any).id);
    results.push({ profileId: (r as any).id, name: (r as any).name, phone: (r as any).accounts?.phone ?? null });
  }

  // 전화번호가 2자리 이상 숫자면 전화 검색도 수행
  if (digits.length >= 2) {
    const { data: acc } = await supabase
      .from("accounts")
      .select("id, phone, profiles(id, name, is_primary)")
      .ilike("phone", `%${digits}%`)
      .limit(20);
    for (const a of acc ?? []) {
      const primary = ((a as any).profiles ?? []).find((p: any) => p.is_primary);
      if (!primary || seen.has(primary.id)) continue;
      seen.add(primary.id);
      results.push({ profileId: primary.id, name: primary.name, phone: (a as any).phone ?? null });
    }
  }

  return results;
}

// 센터에 회원으로 등록 (이미 있으면 무시)
export async function addMemberToCenter(centerId: string, profileId: string): Promise<void> {
  // 이미 등록됐는지 확인
  const { data: exist } = await supabase
    .from("center_members")
    .select("id")
    .eq("center_id", centerId)
    .eq("profile_id", profileId)
    .maybeSingle();
  if (exist) throw new Error("이미 등록된 회원이에요");

  const { error } = await supabase
    .from("center_members")
    .insert({ center_id: centerId, profile_id: profileId, app_linked: true });
  if (error) throw new Error("회원 등록에 실패했어요: " + error.message);
}

export type AlimtalkSendResult = {
  sent: number;
  skipped: number;      // 전화번호가 없어 건너뜀
  failed: number;       // 벤더가 실패로 응답
  failedNames: string[];
};

// 선택한 회원들에게 알림톡(실패 시 SMS 대체발송은 벤더 쪽에서 처리)을 보낸다.
// lib/messaging의 Adapter Pattern을 그대로 쓰므로, 벤더 미확정 상태에서는 Mock으로
// 발송을 시뮬레이션하고(실제로 전송 안 됨), NEXT_PUBLIC_MESSAGE_PROVIDER=alimtalk로
// 바꾸고 AlimtalkSmsProvider 구현을 채우면 이 함수·화면은 그대로 실제 발송에 쓸 수 있다.
export async function sendAlimtalkToMembers(
  targets: { name: string; phone: string | null }[],
  content: string
): Promise<AlimtalkSendResult> {
  const service = getMessageService();
  const result: AlimtalkSendResult = { sent: 0, skipped: 0, failed: 0, failedNames: [] };
  for (const t of targets) {
    if (!t.phone) { result.skipped++; continue; }
    try {
      const res = await service.send({ to: t.phone, content, channel: "alimtalk" });
      if (res.status === "sent") result.sent++;
      else { result.failed++; result.failedNames.push(t.name); }
    } catch {
      result.failed++;
      result.failedNames.push(t.name);
    }
  }
  return result;
}
