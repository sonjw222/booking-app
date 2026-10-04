/*
  알림톡 관리 — 템플릿(alimtalk_templates) + 자동 발송 규칙(notification_rules)
  add_alimtalk_integration.sql / add_notification_rule_evaluators.sql /
  add_notification_rule_multi_per_type.sql 참고.

  자동 발송 규칙은 (center_id, trigger_type, product_id) 조합당 한 행만 존재 — 트리거 타입은
  같아도 적용 대상 수강권(product)이 다르면 여러 개 만들 수 있다(예: "10회권 잔여 2회 이하"와
  "20회권 잔여 3회 이하"를 별도 규칙으로). 화면은 실제로 만들어진 규칙만 목록으로 보여주고,
  "새로 만들기"에서 트리거 타입 + 적용 대상을 골라 새로 추가한다.
*/

import { supabase } from "./supabaseClient";

export type AlimtalkTemplateStatus = "draft" | "pending" | "approved" | "rejected";

export type AlimtalkTemplate = {
  id: string;
  centerId: string | null; // null = 공통(플랫폼 전체) 템플릿, add_alimtalk_template_common.sql
  aligoTemplateCode: string | null;
  title: string;
  content: string;
  variables: string[];
  status: AlimtalkTemplateStatus;
  isActive: boolean;
};

function fromTemplateRow(r: any): AlimtalkTemplate {
  // 2026-10-01 — 읽는 시점에 항상 정규화한다(normalize-on-read, A-2). DB에 예전 알리고
  // 원격 템플릿을 그대로 가져와 #{변수} 문법으로 저장된 행이 있을 수 있는데(예: UL_2071),
  // production 데이터 migration 없이 안전하게 고치는 방법으로 이 방식을 택했다 — 이 함수를
  // 거치는 모든 화면(템플릿 관리, 알림톡 보내기 템플릿 선택 등)이 항상 [[변수]] 문법만
  // 보게 된다. fromAligoVariableSyntax는 이미 [[...]]인 텍스트에는 아무 효과가 없어(멱등)
  // 정상 행을 다시 불러와도 안전하다. variables도 저장된 값을 그대로 믿지 않고 정규화된
  // content에서 다시 추출한다 — 예전 #{...} 전용 추출 로직 시절엔 variables가 빈 배열로
  // 저장됐을 수 있기 때문(추출 로직 버그, 지금은 고쳐짐).
  const content = fromAligoVariableSyntax(r.content);
  return {
    id: r.id,
    centerId: r.center_id,
    aligoTemplateCode: r.aligo_template_code,
    title: r.title,
    content,
    variables: extractTemplateVariables(content),
    status: r.status,
    isActive: r.is_active,
  };
}

// 알리고/카카오 공식 변수 문법(#{변수})을 앱 내부 표준([[변수]])으로 바꾼다 — Oracle 프록시
// 쪽 toAligoVariableSyntax(supabase/functions/_shared/aligo.ts, [[변수]] → #{변수})의 반대
// 방향. 이미 [[...]]인 텍스트에는 아무 영향이 없다(멱등 — 여러 번 적용해도 안전).
export function fromAligoVariableSyntax(content: string): string {
  return content.replace(/#\{([^}]+)\}/g, (_m, v) => `[[${v}]]`);
}

// 이 센터 전용 템플릿 + 공통(center_id null) 템플릿을 같이 불러온다 — 공통 템플릿은 사장님이
// 알리고에 미리 등록해둔 것으로, 모든 센터가 같이 쓸 수 있다(add_alimtalk_template_common.sql).
export async function fetchAlimtalkTemplates(centerId: string): Promise<AlimtalkTemplate[]> {
  const { data, error } = await supabase
    .from("alimtalk_templates")
    .select("id, center_id, aligo_template_code, title, content, variables, status, is_active")
    .or(`center_id.eq.${centerId},center_id.is.null`)
    .order("created_at", { ascending: false });
  if (error) throw new Error("템플릿 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map(fromTemplateRow);
}

// centerId를 null로 넘기면 "공통" 템플릿 생성 — RLS가 플랫폼 운영자만 허용하므로 일반
// 매니저가 호출하면 그냥 DB 에러로 막힌다(화면에서도 운영자에게만 그 옵션을 보여줌).
export async function createAlimtalkTemplate(
  centerId: string | null,
  input: {
    title: string; content: string; variables: string[];
    // 알리고 원격 템플릿 가져오기(2026-09-30)에서만 채워 넣는다 — 새 템플릿을 직접 작성할
    // 때는 여전히 비워두면 기존과 동일하게 draft/코드 없음으로 생성된다(회귀 없음).
    aligoTemplateCode?: string | null; status?: AlimtalkTemplateStatus;
  }
): Promise<string> {
  // 2026-10-01 — 저장 시점에도 정규화한다(normalize-on-write) — DB 내부 표준을 항상
  // [[변수]]로 유지(A-2). 이미 [[...]]인 내용은 그대로(멱등).
  const content = fromAligoVariableSyntax(input.content);
  const { data, error } = await supabase.from("alimtalk_templates").insert({
    center_id: centerId, title: input.title, content, variables: input.variables,
    ...(input.aligoTemplateCode !== undefined ? { aligo_template_code: input.aligoTemplateCode } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  }).select("id").single();
  // 23505: idx_alimtalk_templates_aligo_code_unique(fix_alimtalk_template_code_unique.sql) — 같은 알리고 템플릿 코드가 이미 다른 행(센터/공통)에 있다. 두 탭 경합 등에서도 DB가 막는다.
  if (error?.code === "23505") throw new Error("이미 등록된 알림톡 템플릿이에요");
  if (error) throw new Error("템플릿 등록에 실패했어요: " + error.message);
  return data.id;
}

export async function updateAlimtalkTemplate(
  id: string,
  patch: Partial<{ title: string; content: string; variables: string[]; aligoTemplateCode: string | null; status: AlimtalkTemplateStatus; isActive: boolean }>
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.content !== undefined) row.content = fromAligoVariableSyntax(patch.content);
  if (patch.variables !== undefined) row.variables = patch.variables;
  if (patch.aligoTemplateCode !== undefined) row.aligo_template_code = patch.aligoTemplateCode;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  const { error } = await supabase.from("alimtalk_templates").update(row).eq("id", id);
  if (error?.code === "23505") throw new Error("이미 다른 템플릿에서 쓰고 있는 알리고 템플릿 코드예요");
  if (error) throw new Error("템플릿 수정에 실패했어요: " + error.message);
}

export async function deleteAlimtalkTemplate(id: string): Promise<void> {
  const { error } = await supabase.from("alimtalk_templates").delete().eq("id", id);
  if (error) throw new Error("템플릿 삭제에 실패했어요: " + error.message);
}

// 템플릿 문구의 변수를 자동으로 뽑는다 — evaluate_notification_rules()가 [[회원명]]/
// [[수강권명]]/[[수강권 잔여횟수]]/[[수강권 잔여일]]로 치환한다. 새 템플릿 작성(수동)과
// 알리고 원격 템플릿 가져오기 양쪽에서 같은 로직을 재사용한다(2026-09-30 — 기존 app/manager/
// alimtalk/templates/page.tsx의 inline 함수를 이 파일로 옮김, 로직 변경 없음).
// 2026-10-01(A-3) — DB 내부 표준은 [[...]]로 유지하지만, 예전에 #{...} 상태로 저장된
// 레거시 행(fromTemplateRow가 정규화하기 전에 만들어진 행, 또는 아직 정규화를 거치지 않은
// 원문을 직접 넘기는 호출부)과의 호환을 위해 방어적으로 두 문법을 모두 인식한다. 같은
// 변수 이름이 두 문법으로 각각 나와도 중복 제거된다.
export function extractTemplateVariables(text: string): string[] {
  const bracket = (text.match(/\[\[([^\]]+)\]\]/g) ?? []).map((v) => v.slice(2, -2));
  const brace = (text.match(/#\{([^}]+)\}/g) ?? []).map((v) => v.slice(2, -1));
  return [...new Set([...bracket, ...brace])];
}

// 최종 발송 직전 방어(A-6) — 치환 안 된 [[변수]] 또는 #{변수} placeholder가 하나라도
// 남아있으면 true. 클라이언트(발송 버튼 비활성화)와 서버(Edge Function, Aligo 호출 직전)
// 양쪽에서 같은 판정을 쓴다 — Edge Function은 Deno라 이 lib를 import할 수 없어
// supabase/functions/_shared/aligo.ts에 동일한 정규식으로 복제해 둔다(로직 동일 유지 필수).
export function hasUnresolvedAlimtalkVariables(content: string): boolean {
  return /\[\[([^\]]+)\]\]|#\{([^}]+)\}/.test(content);
}

// values에 있는 변수만 치환하고 나머지는 그대로 둔다(둘 다 채워지지 않으면
// hasUnresolvedAlimtalkVariables가 여전히 true를 반환 — 발송 차단으로 이어짐).
// supabase/functions/_shared/aligo.ts의 renderTemplate과 같은 로직이다(Edge Function은
// Deno 런타임이라 이 lib를 import할 수 없어 별도 파일에 복제, 로직은 반드시 동일하게 유지).
export function renderAlimtalkVariables(content: string, values: Record<string, string>): string {
  let out = content;
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`[[${k}]]`).join(v).split(`#{${k}}`).join(v);
  }
  return out;
}

// 자동으로 채울 수 있는 변수(A-4) — 회원명/고객명(alias), 센터명, 수강권명, 수강권
// 잔여횟수, 수강권 잔여일. varNames 중 이 목록에 없거나 recipient/center 쪽 값 자체가
// 없는 건 결과에서 빠진다(호출부가 "남은 게 있으면 수동 입력 UI 필요"로 구분, A-5).
const ALIMTALK_NAME_ALIASES = ["회원명", "고객명"];

// 화면(app/manager/alimtalk/send, app/manager/members)이 "이 변수는 자동으로 채워지니
// 입력창을 따로 안 보여줘도 된다"를 판단할 때 쓰는 목록 — resolveKnownAlimtalkVariables가
// 실제로 처리하는 이름과 반드시 같게 유지한다(둘 중 하나만 고치면 화면에는 입력창이 없는데
// 실제로는 못 채워지는 변수가 생길 수 있음).
export const ALIMTALK_AUTO_VARIABLE_NAMES = [
  ...ALIMTALK_NAME_ALIASES, "센터명", "수강권명", "수강권 잔여횟수", "수강권 잔여일",
];

export type AlimtalkRecipientContext = {
  name: string;
  passName?: string | null;
  remainingCount?: number | null;
  expiresAt?: string | null; // ISO 날짜 문자열 (lib/members.ts CenterMember.expiresAt)
};

// "수강권 잔여일" — 자동 발송 규칙(add_notification_rule_evaluators.sql)의 [[수강권 잔여일]]은
// 그 규칙에 설정된 days_before(트리거 임계값)를 그대로 쓴다(트리거가 발동했다는 것 자체가
// 이미 "그 날짜가 됐다"는 뜻이라 재계산이 불필요). 하지만 즉시 발송은 그런 트리거 임계값이
// 없으므로, 여기서는 오늘부터 실제 만료일까지 남은 일수를 직접 계산한다(같은 변수 이름이지만
// 값을 만드는 맥락이 다름 — 의도적인 차이, 버그 아님).
function daysUntil(iso: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(iso); target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86400000);
}

export function resolveKnownAlimtalkVariables(
  varNames: string[], centerName: string, recipient: AlimtalkRecipientContext
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of varNames) {
    if (ALIMTALK_NAME_ALIASES.includes(v)) { out[v] = recipient.name; continue; }
    if (v === "센터명") { out[v] = centerName; continue; }
    if (v === "수강권명" && recipient.passName) { out[v] = recipient.passName; continue; }
    if (v === "수강권 잔여횟수" && recipient.remainingCount != null) { out[v] = String(recipient.remainingCount); continue; }
    if (v === "수강권 잔여일" && recipient.expiresAt) { out[v] = String(daysUntil(recipient.expiresAt)); continue; }
  }
  return out;
}

// 알리고 계정에 등록된 템플릿 목록 조회(send-alimtalk Edge Function의 action:"list_templates").
// 플랫폼 단일 알리고 계정 전체를 조회하는 거라 center_id 구분이 없다 — 여러 센터 템플릿이
// 한 목록에 섞여 나올 수 있어 이름(templtName)으로 매니저가 직접 구분해서 골라야 한다.
export type AligoRemoteTemplate = {
  templtCode: string;
  templtName: string;
  templtContent: string;
  inspStatus: string; // REG(등록) / REQ(심사요청) / APR(승인) / REJ(반려)
};

// supabase-js는 Edge Function이 non-2xx를 반환하면 몸통(body)에 실은 실제 에러 메시지를
// error.message에 담지 않고 "Edge Function returned a non-2xx status code"로 뭉개버린다
// (실제로 이 함수를 실제 브라우저로 테스트하다가 확인함, 2026-09-08) — error.context가
// 원본 Response라 여기서 다시 파싱해야 진짜 이유("알리고 계정/발신프로필이 아직 연동되지
// 않았어요" 등)가 보인다.
async function functionsErrorMessage(error: unknown, fallback: string): Promise<string> {
  try {
    const body = await (error as { context?: Response }).context?.clone().json();
    if (typeof body?.error === "string") return body.error;
    if (typeof body?.message === "string") return body.message;
  } catch { /* 본문이 JSON이 아니면 fallback으로 */ }
  return (error as { message?: string })?.message ?? fallback;
}

export async function fetchAligoRemoteTemplates(centerId: string): Promise<AligoRemoteTemplate[]> {
  const { data, error } = await supabase.functions.invoke<{ templates?: AligoRemoteTemplate[]; error?: string }>(
    "send-alimtalk",
    { body: { action: "list_templates", centerId } }
  );
  if (error || !data) throw new Error(await functionsErrorMessage(error, "알리고 템플릿 목록을 불러오지 못했어요"));
  return data.templates ?? [];
}

// 알리고에 신규 템플릿 생성(action:"create_template") — 응답으로 코드/상태(REG)를 즉시 받음.
// centerId를 넘기지 않으면(undefined) "공통" 템플릿로 취급되고, 서버가 플랫폼 운영자인지
// 다시 확인한다(RLS와 별개로 Edge Function 쪽에서도 체크, 2026-09-08).
export async function createAligoRemoteTemplate(
  centerId: string | undefined, title: string, content: string
): Promise<AligoRemoteTemplate> {
  const { data, error } = await supabase.functions.invoke<{ template?: AligoRemoteTemplate; error?: string }>(
    "send-alimtalk",
    { body: { action: "create_template", centerId, title, content } }
  );
  if (error || !data?.template) throw new Error(await functionsErrorMessage(error, "템플릿 생성에 실패했어요"));
  return data.template;
}

// 생성된 템플릿을 실제 카카오 심사에 제출(action:"request_template_approval").
export async function submitAligoTemplateForApproval(centerId: string | undefined, tplCode: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
    "send-alimtalk",
    { body: { action: "request_template_approval", centerId, tplCode } }
  );
  if (error || !data?.ok) throw new Error(await functionsErrorMessage(error, "승인 신청에 실패했어요"));
}

// 회원가입 OTP 전용 시스템 템플릿(supabase/functions/send-phone-otp, ALIGO_OTP_TEMPLATE_CODE
// 시크릿) — 이 코드/발송 구조 자체는 이번 변경에서 전혀 건드리지 않는다. 센터 관리자용
// "알리고 템플릿 불러오기" 목록에서만 제외해, 실수로 자기 센터의 수동 템플릿으로 가져가는
// 것을 막는다(2026-09-30).
export const OTP_SYSTEM_ALIGO_TEMPLATE_CODE = "UL_8353";

export function excludeSystemAligoTemplates(list: AligoRemoteTemplate[]): AligoRemoteTemplate[] {
  return list.filter((t) => t.templtCode !== OTP_SYSTEM_ALIGO_TEMPLATE_CODE);
}

// "알리고 템플릿 불러오기" 목록 전용 상태 라벨(간결한 4단어) — 기존 편집 시트의
// INSP_STATUS_LABEL(더 자세한 설명 문구, app/manager/alimtalk/templates/page.tsx)과는
// 별개로 유지한다(기존 화면 문구를 바꾸면 회귀이므로 건드리지 않음).
export const ALIGO_INSP_STATUS_KO: Record<string, string> = {
  REG: "등록", REQ: "심사 중", APR: "승인", REJ: "반려",
};

// 알리고 inspStatus → 이 앱의 AlimtalkTemplateStatus 매핑.
export function inspStatusToLocalStatus(inspStatus: string): AlimtalkTemplateStatus {
  switch (inspStatus) {
    case "APR": return "approved";
    case "REQ": return "pending";
    case "REJ": return "rejected";
    default: return "draft"; // REG(카카오 심사 요청 전) 등
  }
}

// 알리고 원격 템플릿을 이 센터의 로컬 alimtalk_templates 행으로 가져온다(2026-09-30) —
// title/content/aligo_template_code/status를 그대로 매핑하고, 새 템플릿 생성과 동일한
// createAlimtalkTemplate()을 그대로 재사용한다(새 insert 경로를 따로 만들지 않음).
export function isAligoTemplateAlreadyImported(templates: AlimtalkTemplate[], templtCode: string): boolean {
  return templates.some((t) => t.aligoTemplateCode === templtCode);
}

export async function importAligoTemplateAsLocal(centerId: string, remote: AligoRemoteTemplate): Promise<string> {
  return createAlimtalkTemplate(centerId, {
    title: remote.templtName,
    content: remote.templtContent,
    variables: extractTemplateVariables(remote.templtContent),
    aligoTemplateCode: remote.templtCode,
    status: inspStatusToLocalStatus(remote.inspStatus),
  });
}

// evaluate_notification_rules()(SQL)가 실제로 처리하는 트리거만 화면에 노출한다 —
// class_reminder/waitlist_promoted/class_cancelled는 아직 미구현(add_notification_rule_evaluators.sql 주석 참고).
export const SUPPORTED_TRIGGER_TYPES = [
  "count_low", "membership_expiring", "expired_rebuy", "pause_ending", "birthday",
] as const;
export type SupportedTriggerType = (typeof SUPPORTED_TRIGGER_TYPES)[number];

export const TRIGGER_TYPE_LABEL: Record<SupportedTriggerType, string> = {
  count_low: "수강권 잔여횟수 N회 이하일 때",
  membership_expiring: "수강권 만료 N일 전",
  expired_rebuy: "수강권 만료 후 N일 지났을 때 (재등록 유도)",
  pause_ending: "정지기간 만료 N일 전",
  birthday: "회원 생일 당일",
};

// 트리거별 필수 조건 옆에 "선택"으로 같이 걸 수 있는 보조 조건 — 완전 자유 조건 빌더까지는
// 안 가고(별도 큰 작업) 기존 threshold_count/days_before 두 컬럼을 모든 타입에서 선택적으로
// 같이 쓰게 하는 절충안(사용자 결정, 2026-09-01). count_low는 잔여횟수가 필수라 보조로 기간을,
// 나머지 기간형은 기간이 필수라 보조로 잔여횟수를 건다.
export const SECONDARY_CONDITION: Record<SupportedTriggerType, "days" | "count" | null> = {
  count_low: "days",
  membership_expiring: "count",
  expired_rebuy: "count",
  pause_ending: "count",
  birthday: null,
};

export type NotificationRule = {
  id: string;
  triggerType: SupportedTriggerType;
  daysBefore: number | null;
  thresholdCount: number | null;
  productId: string | null; // null = 전체 수강권(상품) 대상. 특정 상품으로 좁히려면 지정
  sendAlimtalk: boolean;
  templateId: string | null;
  isActive: boolean;
};

// 아직 저장 안 된 새 규칙(id 없음) — "새로 만들기" 시트에서 씀
export type NotificationRuleDraft = Omit<NotificationRule, "id"> & { id: string | null };

export function defaultNotificationRuleDraft(triggerType: SupportedTriggerType): NotificationRuleDraft {
  return {
    id: null, triggerType, daysBefore: triggerType === "count_low" ? null : 3,
    thresholdCount: triggerType === "count_low" ? 2 : null,
    productId: null, sendAlimtalk: true, templateId: null, isActive: true,
  };
}

export async function fetchNotificationRules(centerId: string): Promise<NotificationRule[]> {
  const { data, error } = await supabase
    .from("notification_rules")
    .select("id, trigger_type, days_before, threshold_count, product_id, send_alimtalk, template_id, is_active")
    .eq("center_id", centerId)
    .in("trigger_type", SUPPORTED_TRIGGER_TYPES as unknown as string[])
    .order("created_at", { ascending: false });
  if (error) throw new Error("자동 발송 규칙을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id, triggerType: r.trigger_type, daysBefore: r.days_before, thresholdCount: r.threshold_count,
    productId: r.product_id, sendAlimtalk: r.send_alimtalk, templateId: r.template_id, isActive: r.is_active,
  }));
}

export async function deleteNotificationRule(id: string): Promise<void> {
  const { error } = await supabase.from("notification_rules").delete().eq("id", id);
  if (error) throw new Error("자동 발송 규칙 삭제에 실패했어요: " + error.message);
}

// insert(신규) 또는 update(id 있음) — 트리거 타입 하나에 여러 규칙(상품별)이 가능해진 뒤로는
// 단일 upsert(onConflict)로 표현할 수 없다(전체 수강권 대상은 부분 유니크 인덱스라 컬럼
// 목록만으로 ON CONFLICT 타깃을 못 정함, add_notification_rule_multi_per_type.sql 참고).
export async function saveNotificationRule(centerId: string, rule: NotificationRuleDraft): Promise<void> {
  const row = {
    center_id: centerId,
    trigger_type: rule.triggerType,
    days_before: rule.daysBefore,
    threshold_count: rule.thresholdCount,
    product_id: rule.productId,
    send_alimtalk: rule.sendAlimtalk,
    template_id: rule.templateId,
    is_active: rule.isActive,
  };
  const { error } = rule.id
    ? await supabase.from("notification_rules").update(row).eq("id", rule.id)
    : await supabase.from("notification_rules").insert(row);
  if (error) {
    if (error.code === "23505") throw new Error("같은 트리거·적용 대상 조합의 규칙이 이미 있어요");
    throw new Error("자동 발송 규칙 저장에 실패했어요: " + error.message);
  }
}
