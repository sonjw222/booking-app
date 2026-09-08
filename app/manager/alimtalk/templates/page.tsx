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
import { checkPlatformAdmin } from "../../../../lib/admin";
import {
  fetchAlimtalkTemplates, createAlimtalkTemplate, updateAlimtalkTemplate, deleteAlimtalkTemplate,
  fetchAligoRemoteTemplates, inspStatusToLocalStatus, createAligoRemoteTemplate, submitAligoTemplateForApproval,
  type AlimtalkTemplate, type AlimtalkTemplateStatus, type AligoRemoteTemplate,
} from "../../../../lib/alimtalk";

const INSP_STATUS_LABEL: Record<string, string> = {
  REG: "등록(심사 전)", REQ: "심사 요청중", APR: "승인됨", REJ: "반려됨",
};

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
  const [remoteTemplates, setRemoteTemplates] = useState<AligoRemoteTemplate[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [isCommon, setIsCommon] = useState(false); // "공통"(플랫폼 전체) 템플릿 여부, 운영자만
  const [isAdmin, setIsAdmin] = useState(false);
  const [requestingApproval, setRequestingApproval] = useState(false);

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
    checkPlatformAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
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
    setTitle(""); setContent(""); setAligoCode(""); setStatus("draft"); setIsCommon(false);
    setRemoteTemplates(null); setRemoteError(null);
    setEditing("new");
  }

  function openEdit(t: AlimtalkTemplate) {
    setTitle(t.title); setContent(t.content); setAligoCode(t.aligoTemplateCode ?? ""); setStatus(t.status);
    setIsCommon(t.centerId === null);
    setRemoteTemplates(null); setRemoteError(null);
    setEditing(t);
  }

  // 이 템플릿의 owner 판정: 새 템플릿이면 지금 고른 공통 체크박스, 기존 템플릿이면
  // 저장된 center_id 기준(공통이면 null). "공통" 템플릿은 운영자만 수정/삭제/신청 가능
  // (RLS도 동일하게 막음, add_alimtalk_template_common.sql) — 화면에서도 미리 잠가둔다.
  const editingIsCommon = editing === "new" ? isCommon : editing?.centerId === null;
  const canEditThis = editing === "new" ? (isCommon ? isAdmin : true) : (editingIsCommon ? isAdmin : true);

  // 알리고 계정에 등록된 템플릿 목록을 불러온다 — 승인상태/코드를 수동으로 옮겨 적는 대신
  // 여기서 골라서 자동으로 채운다(2026-09-08). 플랫폼 단일 알리고 계정 전체 목록이라
  // 다른 센터 템플릿도 섞여 나올 수 있어 이름으로 구분해서 골라야 한다.
  async function handleLoadFromAligo() {
    if (!centerId) return;
    setRemoteLoading(true); setRemoteError(null);
    try {
      setRemoteTemplates(await fetchAligoRemoteTemplates(centerId));
    } catch (e: any) { setRemoteError(e.message); }
    finally { setRemoteLoading(false); }
  }

  function handlePickRemote(templtCode: string) {
    const t = remoteTemplates?.find((r) => r.templtCode === templtCode);
    if (!t) return;
    setAligoCode(t.templtCode);
    setStatus(inspStatusToLocalStatus(t.inspStatus));
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
        await createAlimtalkTemplate(isCommon ? null : centerId, { title: title.trim(), content: content.trim(), variables });
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

  // "카카오 승인 신청하기" — 알리고에 템플릿을 생성(template/add)하고 바로 심사 요청까지
  // 제출(template/request)한다. 저장돼 있는 문구를 그대로 쓰므로 먼저 "저장"을 한 번 해서
  // editing이 실제 행이어야 한다(새 템플릿은 저장 후 다시 열어서 신청). 여러 센터가 같은
  // 알리고 계정을 쓰므로 알리고 쪽 이름에 센터명(또는 "공통")이 자동으로 붙는다(서버가 붙임).
  async function handleRequestApproval() {
    if (editing === "new" || !editing) return;
    const ok = await globalThis.appConfirm(
      "알리고에 템플릿을 만들고 카카오 심사를 신청할까요?\n신청 후 결과는 통상 4-5일 걸려요."
    );
    if (!ok) return;
    setRequestingApproval(true); setError(null);
    try {
      const centerParam = editingIsCommon ? undefined : (editing.centerId ?? centerId ?? undefined);
      const created = await createAligoRemoteTemplate(centerParam, editing.title, editing.content);
      await submitAligoTemplateForApproval(centerParam, created.templtCode);
      await updateAlimtalkTemplate(editing.id, { aligoTemplateCode: created.templtCode, status: "pending" });
      setAligoCode(created.templtCode);
      setStatus("pending");
      showToast("카카오 승인을 신청했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setRequestingApproval(false); }
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
              <div className="hist-title">
                {t.title}
                {t.centerId === null && <span className="grade-badge" style={{ marginLeft: 6 }}>공통</span>}
              </div>
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
            {!canEditThis && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>
                공통 템플릿은 플랫폼 운영자만 수정/삭제할 수 있어요 — 읽기만 가능해요.
              </div>
            )}
            {isAdmin && editing === "new" && (
              <label className="csv-col" style={{ marginBottom: 8 }}>
                <input type="checkbox" checked={isCommon} onChange={(e) => setIsCommon(e.target.checked)} disabled={saving} />
                모든 센터 공통으로 등록(운영자가 알리고에 직접 만든 템플릿 등)
              </label>
            )}
            {editing !== "new" && editingIsCommon && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>공통 템플릿 — 모든 센터가 같이 써요.</div>
            )}
            <input className="input-field" placeholder="템플릿 이름 (내부 관리용)" value={title}
              onChange={(e) => setTitle(e.target.value)} disabled={saving || !canEditThis} style={{ marginBottom: 8 }} />
            <textarea
              className="input-field"
              style={{ minHeight: 120, resize: "vertical", paddingTop: 12, marginBottom: 8 }}
              placeholder={"승인 신청용 문구를 입력하세요. 변수는 [[회원명]] 형태로 쓰세요.\n예: [[회원명]]님, [[수강권명]] 잔여횟수가 [[수강권 잔여횟수]]회 남았어요."}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={saving || !canEditThis}
            />
            {editing !== "new" && (
              <>
                {canEditThis && !aligoCode && (
                  <button
                    type="button" className="outline-action compact" style={{ marginBottom: 8 }}
                    disabled={saving || requestingApproval} onClick={handleRequestApproval}
                  >
                    {requestingApproval ? "신청 중..." : "카카오 승인 신청하기"}
                  </button>
                )}
                <button
                  type="button" className="outline-action compact" style={{ marginBottom: 8, marginLeft: canEditThis && !aligoCode ? 8 : 0 }}
                  disabled={saving || remoteLoading} onClick={handleLoadFromAligo}
                >
                  {remoteLoading ? "불러오는 중..." : "알리고에서 불러오기"}
                </button>
                {remoteError && <div className="perm-guide" style={{ margin: "0 0 8px", color: "var(--danger)" }}>{remoteError}</div>}
                {remoteTemplates && (
                  remoteTemplates.length === 0 ? (
                    <div className="perm-guide" style={{ margin: "0 0 8px" }}>알리고에 등록된 템플릿이 없어요.</div>
                  ) : (
                    <select
                      className="input-field" defaultValue="" disabled={saving}
                      onChange={(e) => { if (e.target.value) handlePickRemote(e.target.value); }}
                      style={{ marginBottom: 8 }}
                    >
                      <option value="">알리고 템플릿 선택해서 코드/상태 채우기...</option>
                      {remoteTemplates.map((t) => (
                        <option key={t.templtCode} value={t.templtCode}>
                          {t.templtName} · {INSP_STATUS_LABEL[t.inspStatus] ?? t.inspStatus} · {t.templtCode}
                        </option>
                      ))}
                    </select>
                  )
                )}
                <input className="input-field" placeholder="알리고 템플릿 코드 (카카오 승인 후 입력)" value={aligoCode}
                  onChange={(e) => setAligoCode(e.target.value)} disabled={saving || !canEditThis} style={{ marginBottom: 8 }} />
                <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value as AlimtalkTemplateStatus)} disabled={saving || !canEditThis} style={{ marginBottom: 8 }}>
                  {(Object.keys(STATUS_LABEL) as AlimtalkTemplateStatus[]).map((s) => (
                    <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </>
            )}
            <div className="add-profile-actions">
              {editing !== "new" && canEditThis && (
                <button className="ghost-btn" disabled={saving} onClick={() => { handleDelete(editing); setEditing(null); }}>삭제</button>
              )}
              <button className="ghost-btn" disabled={saving} onClick={() => setEditing(null)}>취소</button>
              {canEditThis && (
                <button className="primary-btn" disabled={saving || !title.trim() || !content.trim()} onClick={handleSave}>
                  {saving ? "저장 중..." : "저장"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
