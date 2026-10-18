/* 예약 화면의 "센터 맥락"(UX-04·15).
   - 예약 달력은 설계상 "활성 수강권을 가진 센터의 수업"만 불러온다(lib/reservations.ts fetchMonthData). 그래서 센터 선택 목록은 "이번 달 수업이 있는 센터"뿐이고,
     수업이 아직 없는 센터나 수강권이 없는 센터의 URL(?center=…, ?openClassId=…)로 들어오면 예전에는 이름 없는 "센터"와 빈 달력만 보였다.
   - 이 모듈은 URL이 가리킨 센터를 별도로(읽기 전용) 조회해 이름·보유 수강권을 보여주고, 빈 화면의 원인을 구분한다. 센터 목록을 넓히거나 접근 정책을 바꾸지 않는다:
     센터 조회는 기존 RLS(승인된 공개 센터만 읽힘)를 그대로 따르고, 읽히지 않으면 "이용할 수 없는 센터"로 안내한다. */
import { supabase } from "./supabaseClient";
import { todayKstYmd } from "./membershipExpiry";

export type CenterPassFact = { id: string; productName: string; remaining: number | null; expiresAt: string | null; profileName: string; usableNow: boolean };
export type CenterContext =
  | { state: "ok"; center: { id: string; name: string }; passes: CenterPassFact[] }
  | { state: "unavailable" }        // 읽히지 않는 센터(비공개/미승인/삭제) — 존재 여부를 추측하지 않는다
  | { state: "error" };

export async function fetchCenterContext(centerId: string, profiles: { id: string; name: string; label?: string | null }[]): Promise<CenterContext> {
  try {
    const { data: c, error } = await supabase.from("centers").select("id, name, status").eq("id", centerId).maybeSingle();
    if (error) return { state: "error" };
    if (!c || (c as { status?: string }).status !== "approved") return { state: "unavailable" };
    const ids = profiles.map((p) => p.id);
    const passes: CenterPassFact[] = [];
    if (ids.length > 0) {
      const { data: rows, error: memErr } = await supabase
        .from("memberships")
        .select("id, profile_id, bound_profile_id, product_name, remaining_count, expires_at, status, products(product_kind)")
        .in("profile_id", ids).eq("center_id", centerId).eq("status", "active");
      if (memErr) return { state: "error" };
      const today = todayKstYmd();
      const nameOf = (id: string | null) => { const p = profiles.find((x) => x.id === id); return p ? (p.label ? `${p.name} · ${p.label}` : p.name) : ""; };
      for (const m of (rows ?? []) as unknown as { id: string; profile_id: string; bound_profile_id: string | null; product_name: string; remaining_count: number | null; expires_at: string | null; products: { product_kind?: string } | { product_kind?: string }[] | null }[]) {
        const prod = Array.isArray(m.products) ? m.products[0] : m.products;
        if (prod?.product_kind === "goods") continue;
        const usableNow = (m.remaining_count == null || m.remaining_count > 0) && (!m.expires_at || m.expires_at >= today);
        passes.push({ id: m.id, productName: m.product_name, remaining: m.remaining_count, expiresAt: m.expires_at, profileName: profiles.length > 1 ? nameOf(m.bound_profile_id ?? m.profile_id) : "", usableNow });
      }
    }
    return { state: "ok", center: { id: (c as { id: string }).id, name: (c as { name: string }).name }, passes };
  } catch { return { state: "error" }; }
}

/** 수업 id만 아는 링크(?openClassId=)에서 센터를 찾는다. 읽히지 않으면 null(삭제됐거나 접근할 수 없는 수업). */
export async function resolveClassCenter(classId: string): Promise<string | null> {
  try {
    const { data } = await supabase.from("classes").select("center_id").eq("id", classId).maybeSingle();
    return (data as { center_id?: string } | null)?.center_id ?? null;
  } catch { return null; }
}

export type EmptyReason =
  | "holiday"              // 선택한 센터의 휴무일
  | "center_unavailable"   // URL의 센터를 읽을 수 없음(비공개·미승인·삭제)
  | "center_no_classes"    // 이 달에 그 센터의 등록된 수업이 하나도 없음
  | "filtered"             // 센터/날짜에는 수업이 있는데 시간대·마감 필터가 가림
  | "no_class_that_day";   // 이 달엔 있지만 선택한 날에는 없음

export function emptyDayReason(i: {
  holiday: boolean; centerUnavailable: boolean;
  monthClassesInScope: number;      // 센터/종목 범위의 이번 달 수업 수(시간대·마감 필터 제외)
  dayClassesInScope: number;        // 선택한 날의 같은 범위 수업 수(시간대·마감 필터 제외)
}): EmptyReason {
  if (i.holiday) return "holiday";
  if (i.centerUnavailable) return "center_unavailable";
  if (i.monthClassesInScope === 0) return "center_no_classes";
  if (i.dayClassesInScope > 0) return "filtered";
  return "no_class_that_day";
}

export const EMPTY_COPY: Record<EmptyReason, { text: string }> = {
  holiday: { text: "선택한 센터는 휴무일이에요" },
  center_unavailable: { text: "이 센터는 지금 이용할 수 없어요. 비공개이거나 운영이 중단된 센터일 수 있어요." },
  center_no_classes: { text: "이 달에는 이 센터에 등록된 수업이 아직 없어요" },
  filtered: { text: "선택한 시간대·조건에 맞는 수업이 없어요" },
  no_class_that_day: { text: "이 날은 예약 가능한 수업이 없어요" },
};
