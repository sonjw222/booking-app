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
  return {
    id: r.id,
    centerId: r.center_id,
    aligoTemplateCode: r.aligo_template_code,
    title: r.title,
    content: r.content,
    variables: r.variables ?? [],
    status: r.status,
    isActive: r.is_active,
  };
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
  input: { title: string; content: string; variables: string[] }
): Promise<void> {
  const { error } = await supabase.from("alimtalk_templates").insert({
    center_id: centerId, title: input.title, content: input.content, variables: input.variables,
  });
  if (error) throw new Error("템플릿 등록에 실패했어요: " + error.message);
}

export async function updateAlimtalkTemplate(
  id: string,
  patch: Partial<{ title: string; content: string; variables: string[]; aligoTemplateCode: string | null; status: AlimtalkTemplateStatus; isActive: boolean }>
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.content !== undefined) row.content = patch.content;
  if (patch.variables !== undefined) row.variables = patch.variables;
  if (patch.aligoTemplateCode !== undefined) row.aligo_template_code = patch.aligoTemplateCode;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  const { error } = await supabase.from("alimtalk_templates").update(row).eq("id", id);
  if (error) throw new Error("템플릿 수정에 실패했어요: " + error.message);
}

export async function deleteAlimtalkTemplate(id: string): Promise<void> {
  const { error } = await supabase.from("alimtalk_templates").delete().eq("id", id);
  if (error) throw new Error("템플릿 삭제에 실패했어요: " + error.message);
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

// 알리고 inspStatus → 이 앱의 AlimtalkTemplateStatus 매핑.
export function inspStatusToLocalStatus(inspStatus: string): AlimtalkTemplateStatus {
  switch (inspStatus) {
    case "APR": return "approved";
    case "REQ": return "pending";
    case "REJ": return "rejected";
    default: return "draft"; // REG(카카오 심사 요청 전) 등
  }
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
