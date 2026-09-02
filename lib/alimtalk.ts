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
    aligoTemplateCode: r.aligo_template_code,
    title: r.title,
    content: r.content,
    variables: r.variables ?? [],
    status: r.status,
    isActive: r.is_active,
  };
}

export async function fetchAlimtalkTemplates(centerId: string): Promise<AlimtalkTemplate[]> {
  const { data, error } = await supabase
    .from("alimtalk_templates")
    .select("id, aligo_template_code, title, content, variables, status, is_active")
    .eq("center_id", centerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("템플릿 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map(fromTemplateRow);
}

export async function createAlimtalkTemplate(
  centerId: string,
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
