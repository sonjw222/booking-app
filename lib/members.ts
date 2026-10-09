/*
  매니저 - 회원 관리
  - 센터에 등록된 회원 목록 (등급/상태 필터, 이름·전화 검색)
  - 회원 등급 관리 (생성/삭제)
  - 회원별 수강권 요약, 메모
  - CSV(엑셀) 내보내기용 데이터
*/

import { displayMemberName } from "./memberName";
import { supabase } from "./supabaseClient";
import { fetchAllPages, fetchByIdChunks } from "./memberList";
import { extensionErrorMessage } from "./membershipExpiry";
import { getMessageService } from "./messaging";
import {
  extractTemplateVariables, resolveKnownAlimtalkVariables, renderAlimtalkVariables,
  hasUnresolvedAlimtalkVariables, type AlimtalkRecipientContext,
} from "./alimtalk";

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

// 센터 회원 목록 — 네트워크 조회 부분(등급 필터만 서버에서 적용). 상태·키워드 필터는 filterMembers가 맡는다.
// PERF-030~033: PostgREST 1000행 상한/.in() URL 길이 때문에 center_members·memberships는 range 페이지네이션(안정 정렬 키
// + count 검증), profile id 대상 조회는 150개 청크로 나눈다. 세 후속 조회는 서로 독립이라 병렬(직렬 단계 4 → 2).
export async function fetchMemberBase(centerId: string, filter: Pick<MemberFilter, "gradeId"> = {}): Promise<CenterMember[]> {
  // egress 감사(2026-09-15)에서 넣었던 limit(2000)은 2000명 초과 센터에서 뒷 회원을 조용히 누락시키므로 제거하고
  // 전량 페이지네이션으로 바꿨다(서버 검색 RPC가 생기면 그쪽이 egress 해법 — docs/TODO 참고).
  // 정렬 키: registered_at 단독이면 동률 행이 페이지 경계에서 중복/누락되므로 id를 보조 키로 둔다.
  const rows = await fetchAllPages<any>(
    (from, to, wantCount) => {
      let q = supabase
        .from("center_members")
        .select(`
      id, profile_id, grade_id, registered_at, last_attended_at,
      app_linked, memo, status,
      profiles(name, accounts(address)),
      member_grades(name, color)
    `, wantCount ? { count: "exact" } : undefined)
        .eq("center_id", centerId);
      if (filter.gradeId) q = q.eq("grade_id", filter.gradeId);
      return q.order("registered_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
    },
    { key: (r) => r.id, errorLabel: "회원 목록을 불러오지 못했어요" },
  );
  const profileIds = Array.from(new Set<string>(rows.map((r: any) => r.profile_id)));

  // 주소는 accounts에 있음 (center_members → profiles → accounts 임베드). 전화번호는 여기서 같이 select하지
  // 않고 customer.member.phone 권한을 서버에서 확인하는 별도 RPC로만 받아온다 —
  // 권한 없는 스태프에게는 응답 자체에 전화번호가 담기지 않는다(권한 없음은 오류가 아니라 null 값으로 내려온다).
  const phoneByProfile: Record<string, string | null> = {};
  const addressByProfile: Record<string, string | null> = {};
  for (const r of rows) addressByProfile[r.profile_id] = r.profiles?.accounts?.address ?? null;

  // 수강권 전체 조회 → 회원 분류 계산. 오류를 무시하면 수강권이 없는 것으로 오인돼 전원이 "만료"로 보이므로 반드시 던진다.
  const nowIso = new Date().toISOString();
  const passByProfile: Record<string, { name: string; remaining: number | null; expires: string }> = {};
  const passStateByProfile: Record<string, { hasUsable: boolean; hasAny: boolean }> = {};

  const [phoneRows, passRows] = await Promise.all([
    fetchByIdChunks<any>(profileIds, async (chunk) => {
      const { data, error } = await supabase.rpc("fetch_member_phones_safe", { p_profile_ids: chunk, p_center_id: centerId });
      if (error) throw new Error("회원 연락처를 불러오지 못했어요: " + error.message);
      return (data ?? []) as any[];
    }),
    fetchByIdChunks<any>(profileIds, (chunk) => fetchAllPages<any>(
      (from, to, wantCount) => supabase
        .from("memberships")
        .select("id, profile_id, product_name, remaining_count, expires_at, pass_type, status", wantCount ? { count: "exact" } : undefined)
        .eq("center_id", centerId)
        .in("profile_id", chunk)
        .order("expires_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      { key: (m) => m.id ?? `${m.profile_id}|${m.expires_at}|${m.product_name}`, errorLabel: "수강권을 불러오지 못했어요", concurrency: 3 },
    )),
  ]);
  for (const row of phoneRows) phoneByProfile[row.profile_id] = row.account_phone ?? null;
  for (const m of passRows) {
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
      passByProfile[pid] = {
        name: (m as any).product_name,
        remaining: (m as any).remaining_count,
        expires: (m as any).expires_at,
      };
    }
  }

  return rows.map((r: any) => {
    const st = passStateByProfile[r.profile_id];
    // 상태 계산: 수동 휴면(dormant) 우선 > 사용가능 수강권 있으면 이용중 > 수강권 있으나 소진/만료면 만료
    let derived: "active" | "expired" | "dormant";
    if (r.status === "dormant") derived = "dormant";
    else if (st?.hasUsable) derived = "active";
    else if (st?.hasAny) derived = "expired";
    else derived = "expired"; // 수강권 없음 (필터에서 hasPass로 구분)
    return {
      id: r.id,
      profileId: r.profile_id,
      name: displayMemberName(r.profiles?.name),
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
}

// 이미 불러온 목록에 상태/키워드/검색필드 필터를 적용(순수 함수, 네트워크 없음).
export function filterMembers(base: CenterMember[], filter: MemberFilter = {}): CenterMember[] {
  let list = base;

  // 2026-10-03: 예전에는 "수강권 이력이 없으면 목록에서 제외"해서, 관리자가 회원 추가(등록)에 성공해도 수강권을 발급하기 전까지는
  // 센터 회원 목록에 나타나지 않았다. 등록된 center_members는 수강권이 없어도 목록에 보인다(상태 배지는 "수강권 없음").
  // 활성/만료 상태 필터는 수강권 이력이 있는 회원만 대상으로 하고, 수강권이 없는 회원은 필터 없음/휴면 필터에서만 보인다.

  // 상태 필터 (파생 상태 기준)
  if (filter.status) {
    list = list.filter((m) => m.status === filter.status && (m.status === "dormant" || m.hasPass));
  }

  // 이름/전화/주소 검색은 조인 결과라서 클라이언트에서 필터.
  // 콤마로 여러 명을 한 번에 검색할 수 있게(예: "회원1,회원2" / "회원1, 회원2" /
  // "회원1 , 회원2") — 콤마 앞뒤 공백은 있어도 없어도 되게 정규식으로 나눠서 어느 한
  // 조건이라도 맞으면 포함(OR 매칭). 여러 명에게 동시에 알림톡을 보내려는 화면
  // (app/manager/alimtalk/send)에서 체크박스를 일일이 찾지 않아도 되게 하기 위함
  // (2026-09-08 요청).
  const kw = filter.keyword?.trim();
  if (kw) {
    const terms = kw.split(/\s*[,，]\s*/).map((t) => t.trim()).filter(Boolean);
    const field = filter.searchField ?? "all";
    list = list.filter((m) => terms.some((term) => {
      const termNoDash = term.replace(/-/g, "");
      const byName = m.name.includes(term);
      const byPhone = (m.phone ?? "").replace(/-/g, "").includes(termNoDash);
      const byAddr = (m.address ?? "").includes(term);
      if (field === "name") return byName;
      if (field === "phone") return byPhone;
      if (field === "address") return byAddr;
      return byName || byPhone || byAddr;
    }));
  }
  return list;
}


// 센터 회원 목록 (기존 호출부 호환: 조회 + 필터)
export async function fetchMembers(centerId: string, filter: MemberFilter = {}): Promise<CenterMember[]> {
  return filterMembers(await fetchMemberBase(centerId, { gradeId: filter.gradeId }), filter);
}

// 회원 등급 변경
export async function updateMemberGrade(memberId: string, gradeId: string | null): Promise<void> {
  const { error } = await supabase
    .from("center_members")
    .update({ grade_id: gradeId })
    .eq("id", memberId);
  if (error) throw new Error("등급 변경에 실패했어요: " + error.message);
}

// 특이사항 저장 (center_members.memo, 회원에겐 보이지 않음, 단일 필드).
// 여러 스태프가 각자 남기는 정식 "회원 메모"는 별개 기능(member_memos, memberMemos.ts) —
// 이 필드는 그와 무관한 기존 자유 텍스트 항목이라 customer.memo.* 권한 체계를 쓰지 않는다.
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

// 관리자 "수강권 만료일 연장"(add_membership_expiry_extension.sql) — 클라이언트가 memberships.expires_at을 직접 UPDATE하지 않고
// 전용 RPC만 호출한다(서버가 권한/상태/날짜를 최종 검증하고 감사 로그를 남긴다).
export async function extendMembershipExpiry(input: {
  membershipId: string; mode: "days" | "date"; days?: number | null; newExpiresAt?: string | null; reason?: string | null;
}): Promise<{ oldExpiresAt: string; newExpiresAt: string; daysAdded: number }> {
  const { data, error } = await supabase.rpc("manager_extend_membership_expiry", {
    p_membership_id: input.membershipId,
    p_mode: input.mode,
    p_days: input.mode === "days" ? input.days ?? null : null,
    p_new_expires_at: input.mode === "date" ? input.newExpiresAt ?? null : null,
    p_reason: input.reason?.trim() ? input.reason.trim() : null,
  });
  if (error) throw new Error(extensionErrorMessage(error));
  const d = data as any;
  return { oldExpiresAt: d.oldExpiresAt, newExpiresAt: d.newExpiresAt, daysAdded: d.daysAdded };
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
    // 휴면 기간만큼 만료일이 있는 수강권 연장 — 서버 함수가 같은 계산으로 처리한다(expires_at 직접 UPDATE는 가드 트리거가 막는다).
    // 함수가 아직 없는 환경(SQL 미적용)에서만 예전 직접 UPDATE 경로로 폴백한다.
    const { error: extErr } = await supabase.rpc("extend_passes_after_dormant", { p_center_member_id: memberId });
    if (extErr) {
      const missing = extErr.code === "PGRST202" || extErr.code === "42883" || /Could not find the function/i.test(extErr.message ?? "");
      if (!missing) throw new Error("휴면 기간만큼 수강권을 연장하지 못했어요: " + extErr.message);
      await legacyExtendPassesAfterDormant(cm);
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
    expiresAt: { label: "만료일", get: (m) => m.expiresAt ?? "무제한" },
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
  activePasses: { id: string; name: string; remaining: number | null; expiresAt: string | null; kind: string; selectedSize: string | null }[];
  // 회원이 마이페이지에서 입력한 정보
  profileInfo: {
    birthDate: string | null; gender: string | null;
    shoeSize: string | null; clothSize: string | null;
    address: string | null; phone: string | null; memo: string | null;
  } | null;
};

export async function fetchMemberDetail(profileId: string, centerId: string): Promise<MemberDetailData> {
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
  // 회원이 입력한 프로필 정보. phone은 customer.member.phone 권한이 있어야 담기는
  // 별도 RPC로만 받아온다(fetchMembers와 동일한 이유) — 여기 select에는 안 넣는다.
  const { data: prof } = await supabase
    .from("profiles")
    .select("birth_date, gender, shoe_size, cloth_size, address, memo")
    .eq("id", profileId)
    .single();

  const { data: phoneRows } = await supabase.rpc("fetch_member_phones_safe", {
    p_profile_ids: [profileId], p_center_id: centerId,
  });
  const phone = (phoneRows ?? [])[0]?.profile_phone ?? null;

  // selected_size(2026-10-01)는 SQL 미적용 환경에서 없을 수 있어 42703이면 컬럼 없이 다시 조회한다.
  const memQuery = (cols: string) => supabase
    .from("memberships")
    .select(cols)
    .eq("profile_id", profileId)
    .eq("status", "active")
    .order("expires_at", { ascending: true });
  const memFirst = await memQuery("id, product_id, product_name, remaining_count, expires_at, status, selected_size");
  let mem: any[] | null = memFirst.data as any[] | null;
  if (memFirst.error?.code === "42703") {
    mem = (await memQuery("id, product_id, product_name, remaining_count, expires_at, status")).data as any[] | null;
  }

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
      selectedSize: m.selected_size ?? null,
    })),
    profileInfo: prof ? {
      birthDate: (prof as any).birth_date ?? null,
      gender: (prof as any).gender ?? null,
      shoeSize: (prof as any).shoe_size ?? null,
      clothSize: (prof as any).cloth_size ?? null,
      address: (prof as any).address ?? null,
      phone,
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

export type MemberCandidate = { profileId: string; name: string; phone: string | null; alreadyMember: boolean };

// 회원 추가 검색(2026-10-03 Batch A) — 서버 RPC search_member_candidates가 센터별 권한을 확인한다.
//  · 이 센터에 이미 등록된 회원: 이름/전화번호 일부로 검색
//  · 아직 이 센터에 없는 가입자: "정확한 전체 휴대폰 번호"로만 검색(결과는 이름 + 마스킹된 번호)
// profiles/accounts를 client에서 직접 조회하지 않는다(관리자 계정마다 RLS 결과가 달라지고 전역 검색이 열려 있었다).
export async function searchAccountsForMember(centerId: string, keyword: string): Promise<MemberCandidate[]> {
  const kw = keyword.trim();
  if (kw.length < 2) return [];
  const { data, error } = await supabase.rpc("search_member_candidates", { p_center_id: centerId, p_keyword: kw });
  if (error) {
    if (error.code === "42883" || error.code === "PGRST202") throw new Error("회원 검색 기능을 사용할 수 없어요. 앱/서버 업데이트 후 다시 시도해주세요");
    throw new Error(/권한|너무 많아요/.test(error.message ?? "") ? error.message : "검색에 실패했어요: " + error.message);   // 권한/rate limit 메시지는 generic이라 그대로 보여준다
  }
  return ((data ?? []) as any[]).map((r) => ({
    profileId: r.profile_id,
    name: displayMemberName(r.name),
    phone: r.phone ?? null,
    alreadyMember: !!r.already_member,
  }));
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
  unresolved: number;   // 2026-10-01(A-6) — 변수가 안 채워져 발송 자체를 시도하지 않고 건너뜀
  failedNames: string[];
};

// 알림톡 발송 대상 — 이름/전화번호는 필수, 나머지는 자동 변수 채우기([[수강권명]]/
// [[수강권 잔여횟수]]/[[수강권 잔여일]])에 쓰인다(A-4). 호출부가 이 값들을 모르면(옵셔널)
// 해당 변수는 자동으로 안 채워지고, commonVariables로 수동 입력된 값이 있으면 그걸 쓴다.
export type AlimtalkSendTarget = AlimtalkRecipientContext & { phone: string | null };

// 선택한 회원들에게 알림톡(실패 시 SMS 대체발송은 벤더 쪽에서 처리)을 보낸다.
// lib/messaging의 Adapter Pattern을 그대로 쓰므로, 벤더 미확정 상태에서는 Mock으로
// 발송을 시뮬레이션하고(실제로 전송 안 됨), NEXT_PUBLIC_MESSAGE_PROVIDER=alimtalk로
// 바꾸고 AlimtalkSmsProvider 구현을 채우면 이 함수·화면은 그대로 실제 발송에 쓸 수 있다.
//
// 2026-10-01(A-4~A-6) — content에 [[변수]]/#{변수}가 남아있으면 그동안 그 문자 그대로
// 발송됐다(회원마다 달라야 할 [[회원명]] 등이 전혀 치환되지 않음). 이제 대상마다:
//   1) 자동으로 알 수 있는 변수(회원명/고객명, 센터명, 수강권명, 수강권 잔여횟수·잔여일)를
//      resolveKnownAlimtalkVariables로 채우고
//   2) 나머지는 호출부가 미리 입력받아 넘긴 commonVariables(모든 대상에 공통, 예:
//      "수업명"/"예약일시"처럼 자동으로 알 수 없는 값)로 채운 뒤
//   3) 그래도 placeholder가 남아있으면(자동도 아니고 공통 입력도 안 된 변수) 그 대상은
//      건너뛴다 — 절대 원문 그대로("[[수업명]]님...") 발송하지 않는다. 화면(app/manager/
//      alimtalk/send, app/manager/members)이 발송 전에 이미 같은 방식으로 검증해 이 경로를
//      타지 않게 막지만, 이 함수 자체도 독립적으로 다시 막는다(마지막 방어선, 서버
//      Edge Function의 hasUnresolvedVariables 검증과 같은 원칙).
export async function sendAlimtalkToMembers(
  targets: AlimtalkSendTarget[],
  content: string,
  centerId: string,
  templateCode?: string,
  options?: { centerName?: string; commonVariables?: Record<string, string> }
): Promise<AlimtalkSendResult> {
  const service = getMessageService();
  const result: AlimtalkSendResult = { sent: 0, skipped: 0, failed: 0, unresolved: 0, failedNames: [] };
  const varNames = extractTemplateVariables(content);
  for (const t of targets) {
    if (!t.phone) { result.skipped++; continue; }
    const known = resolveKnownAlimtalkVariables(varNames, options?.centerName ?? "", t);
    const rendered = renderAlimtalkVariables(content, { ...known, ...(options?.commonVariables ?? {}) });
    if (hasUnresolvedAlimtalkVariables(rendered)) {
      result.unresolved++;
      result.failedNames.push(t.name);
      continue;
    }
    try {
      const res = await service.send({ to: t.phone, content: rendered, channel: "alimtalk", centerId, templateCode });
      if (res.status === "sent") result.sent++;
      else { result.failed++; result.failedNames.push(t.name); }
    } catch {
      result.failed++;
      result.failedNames.push(t.name);
    }
  }
  return result;
}

// (폴백) add_membership_expiry_extension.sql 적용 전 환경용 — 예전 클라이언트 직접 UPDATE.
async function legacyExtendPassesAfterDormant(cm: { center_id: string; profile_id: string; dormant_since: string }): Promise<void> {
  const dormantDays = Math.floor((Date.now() - new Date(cm.dormant_since).getTime()) / 86400000);
  if (!(dormantDays > 0)) return;
  const { data: periodPasses } = await supabase
    .from("memberships")
    .select("id, expires_at, pass_type, status")
    .eq("profile_id", cm.profile_id)
    .eq("center_id", cm.center_id)
    .eq("status", "active");
  for (const p of periodPasses ?? []) {
    if ((p as any).expires_at) {
      const newExp = new Date(new Date((p as any).expires_at).getTime() + dormantDays * 86400000);
      await supabase.from("memberships").update({ expires_at: newExp.toISOString().slice(0, 10) }).eq("id", (p as any).id);
    }
  }
}
