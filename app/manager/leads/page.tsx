"use client";

/*
  매니저 - 상담고객(leads) 관리 — P1-8
  - 등록 전 잠재고객(전화 문의, 방문 상담 등) 기록·상태 관리
  - 회원 전환은 상태만 바꾼다 — 실제 등록은 /manager/members에서 앱 가입 계정을 찾아 진행
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchLeads, createLead, updateLead, updateLeadStatus, deleteLead,
  type Lead, type LeadStatus,
} from "../../../lib/leads";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "신규", contacted: "상담중", converted: "회원전환", dropped: "이탈",
};
const STATUS_FILTERS: { key: LeadStatus | "all"; label: string }[] = [
  { key: "all", label: "전체" }, { key: "new", label: "신규" },
  { key: "contacted", label: "상담중" }, { key: "converted", label: "회원전환" },
  { key: "dropped", label: "이탈" },
];

export default function LeadsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState<LeadStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [editing, setEditing] = useState<Lead | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState("");
  const [memo, setMemo] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

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
    try { setLeads(await fetchLeads(centerId)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);
  useEffect(() => { load(); }, [load]);

  function openAdd() { setAdding(true); setEditing(null); setName(""); setPhone(""); setChannel(""); setMemo(""); }
  function openEdit(l: Lead) { setEditing(l); setAdding(false); setName(l.name); setPhone(l.phone ?? ""); setChannel(l.channel ?? ""); setMemo(l.memo ?? ""); }
  function closeSheet() { setAdding(false); setEditing(null); }

  async function handleSave() {
    if (!name.trim()) { setError("이름을 입력해주세요"); return; }
    if (!centerId) return;
    setBusy(true);
    try {
      const input = { name: name.trim(), phone: phone.trim(), channel: channel.trim(), memo: memo.trim() };
      if (editing) { await updateLead(editing.id, input); showToast("상담고객 정보를 수정했어요"); }
      else { await createLead(centerId, input); showToast("상담고객을 등록했어요"); }
      closeSheet();
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleStatus(l: Lead, status: LeadStatus) {
    setBusy(true);
    try {
      await updateLeadStatus(l.id, status);
      if (status === "converted") showToast("회원전환으로 표시했어요 — 실제 회원 등록은 회원 화면에서 진행해주세요");
      else showToast("상태를 변경했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(l: Lead) {
    if (!(await globalThis.appConfirm(`'${l.name}' 상담고객 기록을 삭제할까요?`))) return;
    setBusy(true);
    try { await deleteLead(l.id); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const visible = filter === "all" ? leads : leads.filter((l) => l.status === filter);

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">상담고객 관리</div>
        <div className="side" />
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      <div className="mem-filters">
        {STATUS_FILTERS.map((f) => (
          <button key={f.key} className={`filter-chip ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? <Loading /> : (
        <>
          {visible.length === 0 ? (
            <div className="empty-action">
              <div className="empty-action-text">
                {filter === "all" ? "아직 등록된 상담고객이 없어요." : "이 상태의 상담고객이 없어요."}
              </div>
              {filter === "all" && <button className="empty-action-btn" onClick={openAdd}>+ 첫 상담고객 등록하기</button>}
            </div>
          ) : (
            <div className="profile-list">
              {visible.map((l) => (
                <div key={l.id} className="profile-item">
                  <button className="profile-item-info" style={{ textAlign: "left", background: "none", border: "none", flex: 1 }} onClick={() => openEdit(l)}>
                    <div className="profile-item-name">
                      {l.name} <span className={`hist-status s-${l.status}`}>{STATUS_LABEL[l.status]}</span>
                    </div>
                    {l.phone && <div className="profile-item-sub"><UiIcon name="phone" size={13} /> {l.phone}</div>}
                    {l.channel && <div className="profile-item-sub">유입: {l.channel}</div>}
                    {l.memo && <div className="profile-item-sub">{l.memo}</div>}
                  </button>
                  {l.status === "new" && (
                    <button className="room-edit" disabled={busy} onClick={() => handleStatus(l, "contacted")}>상담중으로</button>
                  )}
                  {l.status === "contacted" && (
                    <button className="room-edit" disabled={busy} onClick={() => handleStatus(l, "converted")}>회원전환으로</button>
                  )}
                  {(l.status === "new" || l.status === "contacted") && (
                    <button className="room-edit" disabled={busy} onClick={() => handleStatus(l, "dropped")}>이탈로</button>
                  )}
                  <button className="profile-del" disabled={busy} onClick={() => handleDelete(l)}>삭제</button>
                </div>
              ))}
            </div>
          )}

          {leads.length > 0 && (
            <button className="add-profile-btn" onClick={openAdd}>+ 상담고객 등록</button>
          )}
        </>
      )}

      {(adding || editing) && (
        <div className="sheet-overlay" onClick={closeSheet}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editing ? "상담고객 정보 수정" : "상담고객 등록"}</div>
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>이름</div>
            <input className="input-field" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>전화번호 (선택)</div>
            <input className="input-field" placeholder="010-0000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>유입경로 (선택)</div>
            <input className="input-field" placeholder="예: 인스타, 지인소개" value={channel} onChange={(e) => setChannel(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>메모 (선택)</div>
            <input className="input-field" placeholder="상담 내용 등" value={memo} onChange={(e) => setMemo(e.target.value)} />
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={closeSheet}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleSave}>{editing ? "수정하기" : "등록하기"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
