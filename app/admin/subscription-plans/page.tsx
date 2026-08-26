"use client";

/*
  운영자 - 구독 플랜 관리
  - 센터가 플랫폼에 내는 월 구독료 플랜의 이름/가격/제한(룸·스태프·회원·상품 종류 수)을
    운영자가 직접 만들고 편집한다.
  - 여기서 정한 max_* 숫자는 add_subscription_plan_limits.sql의 DB 트리거가 실제로
    강제한다(화면 검증이 아니라 INSERT 자체를 막음) — 이 화면은 그 숫자를 편집하는
    카탈로그일 뿐, 강제 로직 자체는 여기 없다.
  - "기본 플랜"(is_default)은 신규 센터 가입 시 자동 배정되는 플랜 — 정확히 하나만 지정
    가능(DB가 부분 유니크 인덱스로 강제, RPC로 원자적 전환).
*/

import { useCallback, useEffect, useState } from "react";
import {
  fetchSubscriptionPlans, createSubscriptionPlan, updateSubscriptionPlan,
  deleteSubscriptionPlan, setDefaultSubscriptionPlan,
  type SubscriptionPlan, type SubscriptionPlanInput,
} from "../../../lib/operator";
import { checkPlatformAdmin } from "../../../lib/admin";
import Loading from "../../components/Loading";

const EMPTY_FORM: SubscriptionPlanInput = {
  name: "", monthlyPrice: 0, description: "", isActive: true,
  maxRooms: null, maxStaff: null, maxMembers: null, maxProducts: null,
};

type LimitKey = "maxRooms" | "maxStaff" | "maxMembers" | "maxProducts";
const LIMIT_FIELDS: { key: LimitKey; label: string }[] = [
  { key: "maxRooms", label: "룸 개수" },
  { key: "maxStaff", label: "스태프 수 (오너 제외)" },
  { key: "maxMembers", label: "회원 수" },
  { key: "maxProducts", label: "판매 상품 종류 수" },
];

// 숫자 입력 + "무제한" 체크박스 한 쌍. 무제한 체크 시 null로 저장(비활성화된 입력은
// 0으로 보이지 않도록 직전 값을 그대로 두고 disabled만 건다 — 체크 해제 시 되돌아옴).
function LimitInput({
  label, value, onChange,
}: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const unlimited = value === null;
  return (
    <div className="set-row">
      <div className="set-label">{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="number" min={0} className="set-num" style={{ width: 64 }}
          value={unlimited ? "" : value}
          disabled={unlimited}
          placeholder="무제한"
          onChange={(e) => onChange(Math.max(0, parseInt(e.target.value || "0", 10)))}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--text-dim)" }}>
          <input
            type="checkbox" checked={unlimited}
            onChange={(e) => onChange(e.target.checked ? null : 0)}
          />
          무제한
        </label>
      </div>
    </div>
  );
}

export default function SubscriptionPlansPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null); // null=닫힘, ""=신규작성
  const [form, setForm] = useState<SubscriptionPlanInput>(EMPTY_FORM);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setPlans(await fetchSubscriptionPlans()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (admin) await load();
      else setLoading(false);
    })();
  }, [load]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId("");
  }

  function openEdit(p: SubscriptionPlan) {
    setForm({
      name: p.name, monthlyPrice: p.monthlyPrice, description: p.description ?? "", isActive: p.isActive,
      maxRooms: p.maxRooms, maxStaff: p.maxStaff, maxMembers: p.maxMembers, maxProducts: p.maxProducts,
    });
    setEditingId(p.id);
  }

  async function handleSave() {
    if (!form.name.trim()) { setError("플랜 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      if (editingId) await updateSubscriptionPlan(editingId, form);
      else await createSubscriptionPlan(form);
      setEditingId(null);
      showToast(editingId ? "플랜을 수정했어요" : "플랜을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(p: SubscriptionPlan) {
    const ok = await globalThis.appConfirm(`'${p.name}' 플랜을 삭제할까요?`);
    if (!ok) return;
    setBusy(true);
    try { await deleteSubscriptionPlan(p.id); showToast("플랜을 삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSetDefault(p: SubscriptionPlan) {
    setBusy(true);
    try { await setDefaultSubscriptionPlan(p.id); showToast(`'${p.name}'을(를) 기본 플랜으로 지정했어요`); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  function limitText(v: number | null, unit: string) {
    return v === null ? "무제한" : `${v}${unit}`;
  }

  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/admin">‹</a>
          <div className="title">구독 플랜 관리</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          플랫폼 운영자만 접근할 수 있는 화면이에요
        </div>
      </div>
    );
  }

  if (isAdmin === null || loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">구독 플랜 관리</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "8px 20px" }}>
        여기서 정한 개수 제한은 그 플랜을 쓰는 센터에 실제로 강제돼요(예: 룸 3개 제한이면
        4번째 룸부터 생성이 막혀요). 기본 플랜은 신규 가입 센터에 자동으로 배정돼요.
      </div>

      {editingId !== null ? (
        <div className="add-profile-form">
          <input className="input-field" placeholder="플랜 이름 (예: 베이직)" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input type="number" min={0} className="input-field" placeholder="월 구독료(원)" value={form.monthlyPrice}
            onChange={(e) => setForm({ ...form, monthlyPrice: Math.max(0, parseInt(e.target.value || "0", 10)) })} />
          <textarea className="input-field" placeholder="설명 (선택, 예: 소규모 센터용)" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />

          {LIMIT_FIELDS.map(({ key, label }) => (
            <LimitInput key={key} label={label} value={form[key]}
              onChange={(v) => setForm({ ...form, [key]: v })} />
          ))}

          <div className="set-row">
            <div className="set-label">신규 센터에 후보로 보이기</div>
            <button className={`switch ${form.isActive ? "on" : ""}`} onClick={() => setForm({ ...form, isActive: !form.isActive })}>
              <span className="knob" />
            </button>
          </div>

          <div className="add-profile-actions">
            <button className="ghost-btn" onClick={() => { setEditingId(null); setError(null); }}>취소</button>
            <button className="primary-btn" disabled={busy} onClick={handleSave}>
              {busy ? "저장 중..." : editingId ? "수정하기" : "추가하기"}
            </button>
          </div>
        </div>
      ) : (
        <button className="add-profile-btn" onClick={openCreate}>+ 플랜 추가</button>
      )}

      {plans.length === 0 ? (
        <div className="daylist-empty" style={{ padding: 20 }}>등록된 플랜이 없어요</div>
      ) : (
        <div className="profile-list">
          {plans.map((p) => (
            <div key={p.id} className="banner-admin-row">
              <div className="banner-admin-main">
                <div className="banner-admin-title">
                  {p.name} {p.isDefault && <span className="hist-status s-attended">기본</span>}
                  {!p.isActive && <span className="hist-status s-cancelled">비활성</span>}
                </div>
                <div className="banner-admin-sub">
                  {p.monthlyPrice > 0 ? `월 ${p.monthlyPrice.toLocaleString()}원` : "가격 미정"}
                  {p.description ? ` · ${p.description}` : ""}
                </div>
                <div className="banner-admin-sub">
                  룸 {limitText(p.maxRooms, "개")} · 스태프 {limitText(p.maxStaff, "명")} ·
                  회원 {limitText(p.maxMembers, "명")} · 상품 {limitText(p.maxProducts, "종")}
                </div>
              </div>
              <div className="banner-admin-actions" style={{ flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                {!p.isDefault && (
                  <button className="ghost-btn small" disabled={busy} onClick={() => handleSetDefault(p)}>기본으로</button>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="ghost-btn small" disabled={busy} onClick={() => openEdit(p)}>수정</button>
                  <button className="profile-del" disabled={busy} onClick={() => handleDelete(p)}>삭제</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
