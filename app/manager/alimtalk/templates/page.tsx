"use client";

/*
  매니저 - 알림톡 템플릿 관리 (더보기 > 알림톡 > 템플릿 관리)
  카카오 알림톡은 자유 문장이 아니라 사전 승인된 템플릿만 발송 가능하다 — 여기서 승인 신청용
  문구를 등록/관리하고, 실제 카카오 승인이 끝나면 알리고가 발급하는 템플릿 코드를 입력해
  status를 approved로 바꾼다(승인 여부 확인은 알리고 콘솔에서, 이 화면은 상태 기록용).
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../../lib/manager";
import {
  fetchAlimtalkTemplates, createAlimtalkTemplate, updateAlimtalkTemplate, deleteAlimtalkTemplate,
  type AlimtalkTemplate, type AlimtalkTemplateStatus,
} from "../../../../lib/alimtalk";

const STATUS_LABEL: Record<AlimtalkTemplateStatus, string> = {
  draft: "초안", pending: "카카오 승인 대기", approved: "승인됨", rejected: "반려됨",
};
const STATUS_BADGE: Record<AlimtalkTemplateStatus, string> = {
  draft: "s-tpl_draft", pending: "s-tpl_pending", approved: "s-tpl_approved", rejected: "s-tpl_rejected",
};

export default function AlimtalkTemplatesPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<AlimtalkTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [editing, setEditing] = useState<AlimtalkTemplate | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [aligoCode, setAligoCode] = useState("");
  const [status, setStatus] = useState<AlimtalkTemplateStatus>("draft");
  const [saving, setSaving] = useState(false);

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
      setTemplates(await fetchAlimtalkTemplates(centerId));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setTitle(""); setContent(""); setAligoCode(""); setStatus("draft");
    setEditing("new");
  }

  function openEdit(t: AlimtalkTemplate) {
    setTitle(t.title); setContent(t.content); setAligoCode(t.aligoTemplateCode ?? ""); setStatus(t.status);
    setEditing(t);
  }

  // 템플릿 문구의 [[변수]]를 자동으로 뽑아 저장 — evaluate_notification_rules()가
  // [[회원명]]/[[수강권명]]/[[수강권 잔여횟수]]/[[수강권 잔여일]]로 치환한다.
  function extractVariables(text: string): string[] {
    const found = text.match(/\[\[([^\]]+)\]\]/g) ?? [];
    return [...new Set(found.map((v) => v.slice(2, -2)))];
  }

  async function handleSave() {
    if (!centerId || !title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      const variables = extractVariables(content);
      if (editing === "new") {
        await createAlimtalkTemplate(centerId, { title: title.trim(), content: content.trim(), variables });
      } else if (editing) {
        await updateAlimtalkTemplate(editing.id, {
          title: title.trim(), content: content.trim(), variables,
          aligoTemplateCode: aligoCode.trim() || null, status,
        });
      }
      setEditing(null);
      showToast("저장했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleDelete(t: AlimtalkTemplate) {
    const ok = await globalThis.appConfirm(`"${t.title}" 템플릿을 삭제할까요? 이 템플릿을 쓰는 자동 발송 규칙이 있다면 같이 꺼질 수 있어요.`);
    if (!ok) return;
    try {
      await deleteAlimtalkTemplate(t.id);
      showToast("삭제했어요");
      await load();
    } catch (e: any) { setError(e.message); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <div className="side" />
          <div className="title">템플릿 관리</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        {/* 뒤로가기는 ManagerChrome(공통 상단바)이 이미 그려준다 — 여기 .side에도 링크를
            넣으면 뒤로가기 버튼이 두 개로 보인다(사용자 리포트, 2026-09-01). 오른쪽 액션
            버튼과의 space-between 정렬용 빈 자리만 남겨둔다. */}
        <div className="side" />
        <div className="title">템플릿 관리</div>
        <button className="header-action" style={{ fontSize: 15, padding: "0 12px" }} onClick={openNew}>+ 템플릿</button>
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
      ) : templates.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 60 }}>
          등록된 템플릿이 없어요.<br />+ 버튼으로 새 템플릿을 만들어보세요.
        </div>
      ) : (
        templates.map((t) => (
          <div key={t.id} className="hist-item clickable" onClick={() => openEdit(t)}>
            <div className="hist-main">
              <div className="hist-title">{t.title}</div>
              <div className="hist-sub">
                {t.content.slice(0, 28)}{t.content.length > 28 ? "…" : ""}
                {t.aligoTemplateCode ? ` · ${t.aligoTemplateCode}` : ""}
              </div>
            </div>
            <span className={`hist-status ${STATUS_BADGE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
          </div>
        ))
      )}

      {editing && (
        <div className="sheet-overlay" onClick={() => !saving && setEditing(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editing === "new" ? "새 템플릿" : "템플릿 수정"}</div>
            <input className="input-field" placeholder="템플릿 이름 (내부 관리용)" value={title}
              onChange={(e) => setTitle(e.target.value)} disabled={saving} style={{ marginBottom: 8 }} />
            <textarea
              className="input-field"
              style={{ minHeight: 120, resize: "vertical", paddingTop: 12, marginBottom: 8 }}
              placeholder={"승인 신청용 문구를 입력하세요. 변수는 [[회원명]] 형태로 쓰세요.\n예: [[회원명]]님, [[수강권명]] 잔여횟수가 [[수강권 잔여횟수]]회 남았어요."}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={saving}
            />
            {editing !== "new" && (
              <>
                <input className="input-field" placeholder="알리고 템플릿 코드 (카카오 승인 후 입력)" value={aligoCode}
                  onChange={(e) => setAligoCode(e.target.value)} disabled={saving} style={{ marginBottom: 8 }} />
                <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value as AlimtalkTemplateStatus)} disabled={saving} style={{ marginBottom: 8 }}>
                  {(Object.keys(STATUS_LABEL) as AlimtalkTemplateStatus[]).map((s) => (
                    <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </>
            )}
            <div className="add-profile-actions">
              {editing !== "new" && (
                <button className="ghost-btn" disabled={saving} onClick={() => { handleDelete(editing); setEditing(null); }}>삭제</button>
              )}
              <button className="ghost-btn" disabled={saving} onClick={() => setEditing(null)}>취소</button>
              <button className="primary-btn" disabled={saving || !title.trim() || !content.trim()} onClick={handleSave}>
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
