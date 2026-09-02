"use client";

/*
  매니저 - 자동 발송 규칙 (더보기 > 알림톡 > 자동 발송 규칙)
  evaluate_notification_rules()(add_notification_rule_evaluators.sql)가 매일 평가하는 5가지
  트리거를, "+ 새로 만들기"로 필요한 만큼 만든다. 트리거 타입이 같아도 적용 대상 수강권
  (product)이 다르면 여러 개 만들 수 있다(add_notification_rule_multi_per_type.sql —
  예: "10회권 잔여 2회 이하"와 "20회권 잔여 3회 이하"를 별도 규칙으로).

  예: "회원권 잔여 2회 남은 회원에게 재등록 유도"는 새로 만들기 → count_low 선택 →
  잔여횟수 2, 승인된 템플릿 선택 → 저장.
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../../lib/manager";
import { fetchProducts, type Product } from "../../../../lib/passes";
import {
  fetchNotificationRules, saveNotificationRule, deleteNotificationRule, fetchAlimtalkTemplates,
  defaultNotificationRuleDraft, SUPPORTED_TRIGGER_TYPES, TRIGGER_TYPE_LABEL, SECONDARY_CONDITION,
  type NotificationRule, type NotificationRuleDraft, type AlimtalkTemplate, type SupportedTriggerType,
} from "../../../../lib/alimtalk";

function primarySummary(rule: NotificationRuleDraft): string {
  if (rule.triggerType === "count_low") return `잔여 ${rule.thresholdCount ?? "?"}회 이하`;
  if (rule.triggerType === "expired_rebuy") return `만료 후 ${rule.daysBefore ?? "?"}일`;
  if (rule.triggerType === "birthday") return "당일";
  return `D-${rule.daysBefore ?? "?"}`;
}

// 필수 조건 + (설정했으면) 선택 조건까지 같이 보여준다 — "D-3 · 잔여 2회 이하"처럼 조합 규칙임을
// 목록에서 바로 알 수 있게(사용자 피드백: 뭐가 저장돼 있는지 한눈에 안 보임, 2026-09-01).
function conditionSummary(rule: NotificationRuleDraft): string {
  const secondary = SECONDARY_CONDITION[rule.triggerType];
  const parts = [primarySummary(rule)];
  if (secondary === "days" && rule.daysBefore != null) parts.push(`만료 ${rule.daysBefore}일 이내`);
  if (secondary === "count" && rule.thresholdCount != null) parts.push(`잔여 ${rule.thresholdCount}회 이하`);
  return parts.join(" · ");
}

export default function AlimtalkRulesPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [templates, setTemplates] = useState<AlimtalkTemplate[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [sheetMode, setSheetMode] = useState<"new" | "edit" | null>(null);
  const [draft, setDraft] = useState<NotificationRuleDraft | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const [r, t, p] = await Promise.all([
        fetchNotificationRules(centerId), fetchAlimtalkTemplates(centerId), fetchProducts(centerId, "pass"),
      ]);
      setRules(r);
      setTemplates(t);
      setProducts(p);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const approvedTemplates = templates.filter((t) => t.status === "approved" && t.isActive);

  function openNew() {
    setDraft(defaultNotificationRuleDraft(SUPPORTED_TRIGGER_TYPES[0]));
    setSheetMode("new");
  }

  function openEdit(rule: NotificationRule) {
    setDraft({ ...rule });
    setSheetMode("edit");
  }

  function closeSheet() {
    setSheetMode(null);
    setDraft(null);
  }

  function switchDraftType(t: SupportedTriggerType) {
    setDraft(defaultNotificationRuleDraft(t));
  }

  async function handleSave() {
    if (!centerId || !draft) return;
    if (draft.sendAlimtalk && !draft.templateId) {
      setError("알림톡을 켜려면 승인된 템플릿을 먼저 골라야 해요");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveNotificationRule(centerId, draft);
      showToast("저장했어요");
      closeSheet();
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!draft?.id) return;
    const ok = await globalThis.appConfirm(`"${TRIGGER_TYPE_LABEL[draft.triggerType]}" 규칙을 삭제할까요?`);
    if (!ok) return;
    setSaving(true);
    try {
      await deleteNotificationRule(draft.id);
      showToast("삭제했어요");
      closeSheet();
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <div className="side" />
          <div className="title">자동 발송 규칙</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        {/* 뒤로가기는 ManagerChrome(공통 상단바)이 이미 그려준다 — 정렬용 빈 자리만 남겨둠 */}
        <div className="side" />
        <div className="title">자동 발송 규칙</div>
        <button className="header-action" style={{ fontSize: 15, padding: "0 12px" }} onClick={openNew}>+ 새로 만들기</button>
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      {error && <div className="daylist-empty" style={{ margin: "0 20px 10px" }}>{error}</div>}

      {loading ? (
        <Loading />
      ) : rules.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 60 }}>
          아직 만든 자동 발송 규칙이 없어요.<br />"+ 새로 만들기"로 시작해보세요.
        </div>
      ) : (
        rules.map((rule) => {
          const tpl = templates.find((t) => t.id === rule.templateId);
          const product = products.find((p) => p.id === rule.productId);
          return (
            <div key={rule.id} className="hist-item clickable" onClick={() => openEdit(rule)}>
              <div className="hist-main">
                <div className="hist-title">{TRIGGER_TYPE_LABEL[rule.triggerType]}</div>
                <div className="hist-sub">
                  {product ? `${product.name} · ` : "전체 수강권 · "}{conditionSummary(rule)}
                  {tpl ? ` · ${tpl.title}` : " · 템플릿 미지정"}
                </div>
              </div>
              <span className={`hist-status ${rule.isActive ? "s-rule_on" : "s-rule_off"}`}>
                {rule.isActive ? "켜짐" : "꺼짐"}
              </span>
            </div>
          );
        })
      )}

      {sheetMode && draft && (
        <div className="sheet-overlay" onClick={() => !saving && closeSheet()}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{sheetMode === "new" ? "새 자동 발송 규칙" : "규칙 수정"}</div>

            {sheetMode === "new" ? (
              <select
                className="input-field" disabled={saving} value={draft.triggerType}
                onChange={(e) => switchDraftType(e.target.value as SupportedTriggerType)}
                style={{ marginBottom: 10 }}
              >
                {SUPPORTED_TRIGGER_TYPES.map((t) => (
                  <option key={t} value={t}>{TRIGGER_TYPE_LABEL[t]}</option>
                ))}
              </select>
            ) : (
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>{TRIGGER_TYPE_LABEL[draft.triggerType]}</div>
            )}

            {draft.triggerType === "count_low" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span className="info">잔여</span>
                <input type="number" min={0} className="set-num" style={{ width: 56 }} disabled={saving}
                  value={draft.thresholdCount ?? 2}
                  onChange={(e) => setDraft({ ...draft, thresholdCount: Math.max(0, parseInt(e.target.value || "0", 10)) })} />
                <span className="info">회 이하일 때</span>
              </div>
            ) : draft.triggerType !== "birthday" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span className="info">{draft.triggerType === "expired_rebuy" ? "만료 후" : "기준일 D-"}</span>
                <input type="number" min={0} className="set-num" style={{ width: 56 }} disabled={saving}
                  value={draft.daysBefore ?? 3}
                  onChange={(e) => setDraft({ ...draft, daysBefore: Math.max(0, parseInt(e.target.value || "0", 10)) })} />
                <span className="info">일</span>
              </div>
            ) : null}

            {/* 보조 조건(선택) — 절충안: 완전 자유 조건 빌더 대신, 필수 조건 옆에 반대 성격의
                조건(기간형엔 잔여횟수, count_low엔 기간)을 하나 더 걸 수 있게 함 */}
            {SECONDARY_CONDITION[draft.triggerType] === "days" && (
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: draft.daysBefore != null ? 6 : 0 }}>
                  <input type="checkbox" checked={draft.daysBefore != null} disabled={saving}
                    onChange={(e) => setDraft({ ...draft, daysBefore: e.target.checked ? 7 : null })} />
                  만료 며칠 이내인 경우만 (선택)
                </label>
                {draft.daysBefore != null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="info">만료</span>
                    <input type="number" min={0} className="set-num" style={{ width: 56 }} disabled={saving}
                      value={draft.daysBefore}
                      onChange={(e) => setDraft({ ...draft, daysBefore: Math.max(0, parseInt(e.target.value || "0", 10)) })} />
                    <span className="info">일 이내</span>
                  </div>
                )}
              </div>
            )}
            {SECONDARY_CONDITION[draft.triggerType] === "count" && (
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: draft.thresholdCount != null ? 6 : 0 }}>
                  <input type="checkbox" checked={draft.thresholdCount != null} disabled={saving}
                    onChange={(e) => setDraft({ ...draft, thresholdCount: e.target.checked ? 2 : null })} />
                  잔여횟수 이하인 경우만 (선택)
                </label>
                {draft.thresholdCount != null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="info">잔여</span>
                    <input type="number" min={0} className="set-num" style={{ width: 56 }} disabled={saving}
                      value={draft.thresholdCount}
                      onChange={(e) => setDraft({ ...draft, thresholdCount: Math.max(0, parseInt(e.target.value || "0", 10)) })} />
                    <span className="info">회 이하</span>
                  </div>
                )}
              </div>
            )}

            {/* 적용 대상 상품(수강권) — 지정 안 하면 전체 수강권 대상(하위호환), 상품마다
                잔여횟수/기간 의미가 다르므로(무제한권엔 잔여횟수 자체가 없음) 특정 상품으로
                좁힐 수 있게 함. 트리거 타입이 같아도 상품이 다르면 별도 규칙으로 여러 개
                만들 수 있음(사용자 요청, 2026-09-01). birthday는 상품과 무관해서 제외. */}
            {draft.triggerType !== "birthday" && (
              <select
                className="input-field" disabled={saving} value={draft.productId ?? ""}
                onChange={(e) => setDraft({ ...draft, productId: e.target.value || null })}
                style={{ marginBottom: 10 }}
              >
                <option value="">적용 대상: 전체 수강권</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}

            <select
              className="input-field" disabled={saving} value={draft.templateId ?? ""}
              onChange={(e) => setDraft({ ...draft, templateId: e.target.value || null })}
              style={{ marginBottom: 10 }}
            >
              <option value="">템플릿 선택 (승인된 것만)</option>
              {approvedTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            {approvedTemplates.length === 0 && (
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>
                승인된 템플릿이 없어요. <a href="/manager/alimtalk/templates">템플릿 관리</a>에서 먼저 등록해주세요.
              </div>
            )}

            {sheetMode === "edit" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <input type="checkbox" checked={draft.isActive} disabled={saving}
                  onChange={(e) => setDraft({ ...draft, isActive: e.target.checked, sendAlimtalk: e.target.checked })} />
                이 규칙 켜기
              </label>
            )}

            <div className="add-profile-actions">
              {sheetMode === "edit" && (
                <button className="ghost-btn" disabled={saving} onClick={handleDelete}>삭제</button>
              )}
              <button className="ghost-btn" disabled={saving} onClick={closeSheet}>취소</button>
              <button className="primary-btn" disabled={saving} onClick={handleSave}>{saving ? "저장 중..." : "저장"}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
