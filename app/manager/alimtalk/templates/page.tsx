"use client";

import SheetOverlay from "../../../components/SheetOverlay";

/*
  매니저 - 알림톡 템플릿 관리 (더보기 > 알림톡 > 템플릿 관리)
  카카오 알림톡은 자유 문장이 아니라 사전 승인된 템플릿만 발송 가능하다 — 여기서 승인 신청용
  문구를 등록/관리하고, 실제 카카오 승인이 끝나면 알리고가 발급하는 템플릿 코드를 입력해
  status를 approved로 바꾼다(승인 여부 확인은 알리고 콘솔에서, 이 화면은 상태 기록용).
*/

import { useRef, useCallback, useEffect, useState } from "react";
import Loading from "../../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../../lib/manager";
import { checkPlatformAdmin } from "../../../../lib/admin";
import {
  fetchAlimtalkTemplates, createAlimtalkTemplate, updateAlimtalkTemplate, deleteAlimtalkTemplate,
  fetchAligoRemoteTemplates, inspStatusToLocalStatus, createAligoRemoteTemplate, submitAligoTemplateForApproval,
  extractTemplateVariables, excludeSystemAligoTemplates, ALIGO_INSP_STATUS_KO,
  isAligoTemplateAlreadyImported, importAligoTemplateAsLocal,
  type AlimtalkTemplate, type AlimtalkTemplateStatus, type AligoRemoteTemplate,
} from "../../../../lib/alimtalk";
import { toUserMessage } from "../../../../lib/userError";

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
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [aligoCode, setAligoCode] = useState("");
  const [status, setStatus] = useState<AlimtalkTemplateStatus>("draft");
  const [saving, setSaving] = useState(false);
  // "알리고 템플릿 불러오기"(2026-09-30) — 메인 화면에서 로컬 템플릿이 0개여도 항상 열 수
  // 있는 별도 시트. 고른 템플릿을 새 로컬 템플릿으로 "가져온다". 2026-10-01(A-11)부터
  // 편집 시트 안에 따로 있던 "알리고에서 불러오기"(특정 템플릿의 코드/상태만 채우는 용도,
  // remoteTemplates/handleLoadFromAligo/handlePickRemote)는 이 flow와 기능이 겹쳐서
  // 제거했다 — 알리고 템플릿을 가져오는 방법은 이제 이 진입점 하나뿐이다.
  const [importOpen, setImportOpen] = useState(false);
  const [importList, setImportList] = useState<AligoRemoteTemplate[] | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importingCode, setImportingCode] = useState<string | null>(null); // 지금 가져오는 중인 코드(중복 클릭 방지)
  const [importSearch, setImportSearch] = useState(""); // A-12 — 이름/코드/내용 검색(클라이언트 필터)
  const [expandedCode, setExpandedCode] = useState<string | null>(null); // A-13 — 원격 목록 상세 미리보기 토글
  const [isCommon, setIsCommon] = useState(false); // "공통"(플랫폼 전체) 템플릿 여부, 운영자만
  const [isAdmin, setIsAdmin] = useState(false);
  const [requestingApproval, setRequestingApproval] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(toUserMessage(e, "운영 중인 센터 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.")); setLoading(false); }
    })();
    checkPlatformAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
  }, []);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      setTemplates(await fetchAlimtalkTemplates(centerId));
    } catch (e: any) { setError(toUserMessage(e, "템플릿 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.")); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setTitle(""); setContent(""); setAligoCode(""); setStatus("draft"); setIsCommon(false);
    setEditing("new");
  }

  function openEdit(t: AlimtalkTemplate) {
    setTitle(t.title); setContent(t.content); setAligoCode(t.aligoTemplateCode ?? ""); setStatus(t.status);
    setIsCommon(t.centerId === null);
    setEditing(t);
  }

  // A-10 — 승인 완료(APR) 템플릿의 "새 템플릿으로 복제": 문구는 그대로 복사하되
  // aligo_template_code는 가져오지 않고(새 템플릿은 카카오 승인이 안 된 상태이므로 기존
  // 코드를 재사용하면 안 됨) status도 draft로 초기화한다 — createAlimtalkTemplate을 그대로
  // 타므로(editing === "new" 경로) "저장하기"를 눌러야 실제로 생성되고, 취소하면 아무것도
  // 만들어지지 않는다(DB insert가 버튼 클릭 즉시 일어나지 않음).
  function cloneAsNew(t: AlimtalkTemplate) {
    setTitle(`${t.title} 복제`);
    setContent(t.content);
    setAligoCode("");
    setStatus("draft");
    setIsCommon(t.centerId === null);
    setEditing("new");
  }

  // 이 템플릿의 owner 판정: 새 템플릿이면 지금 고른 공통 체크박스, 기존 템플릿이면
  // 저장된 center_id 기준(공통이면 null). "공통" 템플릿은 운영자만 수정/삭제/신청 가능
  // (RLS도 동일하게 막음, add_alimtalk_template_common.sql) — 화면에서도 미리 잠가둔다.
  const editingIsCommon = editing === "new" ? isCommon : editing?.centerId === null;
  const canEditThis = editing === "new" ? (isCommon ? isAdmin : true) : (editingIsCommon ? isAdmin : true);
  // A-9 — 카카오 승인(APR) 완료 문구는 고정 문구라 수정하면 안 된다(상세만 보여줌).
  // 심사 중(REQ, 로컬 status="pending")도 결과가 나올 때까지 잠근다. REG(로컬 "draft")와
  // REJ(로컬 "rejected")만 자유롭게 수정 가능.
  const isApprovedDetail = editing !== "new" && editing?.status === "approved";
  const isLocked = editing !== "new" && (editing?.status === "approved" || editing?.status === "pending");

  // 2026-10-01 — A-11에서 편집 시트 안의 "알리고에서 불러오기"(코드/상태 수동 매칭)를
  // 없앤 대신, 심사 요청(REQ) 중인 템플릿은 카카오 심사 결과가 나와도 이 화면이 자동으로
  // 알 방법이 없어진다(웹훅/폴링 없음, 기존에도 없었음). 완전히 새 API를 추가하지 않고
  // 기존 fetchAligoRemoteTemplates(알리고 계정 템플릿 전체 목록, 이미 있는 함수)에서 같은
  // 코드를 찾아 상태만 동기화하는 최소한의 보완 — 사용자가 다시 확인하고 싶을 때 누르는
  // 읽기 전용 동작이라 센터 관리자가 상태를 "직접 변경"하는 input/select는 아니다.
  async function handleRefreshStatus() {
    if (editing === "new" || !editing || !editing.aligoTemplateCode || !centerId) return;
    setRefreshingStatus(true); setError(null);
    try {
      const remote = await fetchAligoRemoteTemplates(centerId);
      const match = remote.find((r) => r.templtCode === editing.aligoTemplateCode);
      if (!match) { showToast("알리고에서 같은 코드의 템플릿을 찾지 못했어요."); return; }
      const nextStatus = inspStatusToLocalStatus(match.inspStatus);
      if (nextStatus === editing.status) { showToast("상태 변화가 없어요 — 여전히 " + ALIGO_INSP_STATUS_KO[match.inspStatus]); return; }
      await updateAlimtalkTemplate(editing.id, { status: nextStatus });
      setStatus(nextStatus);
      showToast(`상태가 "${ALIGO_INSP_STATUS_KO[match.inspStatus]}"(으)로 바뀌었어요`);
      await load();
    } catch (e: any) {
      setError(toUserMessage(e, "상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요."));
    } finally {
      setRefreshingStatus(false);
    }
  }

  // ============================================================
  // "알리고 템플릿 불러오기"(1-A~1-D, 2026-09-30) — 로컬 템플릿이 0개여도 항상 열 수 있는
  // 메인 화면 전용 시트. 위 handleLoadFromAligo(편집 중인 템플릿 하나의 코드/상태만 채움)와
  // 달리, 고른 항목을 완전히 새로운 로컬 템플릿 행으로 "가져온다".
  // ============================================================
  function openImportSheet() {
    setImportOpen(true);
    setImportList(null);
    setImportError(null);
    loadImportList();
  }

  async function loadImportList() {
    if (!centerId) return;
    setImportLoading(true); setImportError(null);
    try {
      setImportList(excludeSystemAligoTemplates(await fetchAligoRemoteTemplates(centerId)));
    } catch (e: any) { setImportError(toUserMessage(e, "알리고 템플릿을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.")); }
    finally { setImportLoading(false); }
  }

  async function handleImport(remote: AligoRemoteTemplate) {
    if (!centerId || importingCode) return; // 중복 클릭 방지
    // 클라이언트 쪽 1차 방어 — DB에는 (center_id, aligo_template_code) unique 제약이 없어
    // (schema 확인, 2026-09-30) 이 목록 기준 확인이 사실상 유일한 중복 방지선이다.
    if (isAligoTemplateAlreadyImported(templates, remote.templtCode)) {
      showToast("이미 등록된 템플릿이에요.");
      return;
    }
    setImportingCode(remote.templtCode);
    try {
      await importAligoTemplateAsLocal(centerId, remote);
      showToast("템플릿을 가져왔어요");
      await load();
    } catch (e: any) {
      showToast(toUserMessage(e, "템플릿을 등록하지 못했어요. 잠시 후 다시 시도해 주세요."));
    } finally {
      setImportingCode(null);
    }
  }

  async function handleSave() {
    if (!centerId || !title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      const variables = extractTemplateVariables(content);
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
    } catch (e: any) { setError(toUserMessage(e, "템플릿을 등록하지 못했어요. 잠시 후 다시 시도해 주세요.")); }
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
    } catch (e: any) { setError(toUserMessage(e, "카카오 승인 신청에 실패했어요. 잠시 후 다시 시도해 주세요.")); }
    finally { setRequestingApproval(false); }
  }

  // A-10 — "삭제"가 실제로는 로컬(alimtalk_templates) 행만 지우고 알리고에 등록된 원격
  // 템플릿은 전혀 건드리지 않는다(deleteAlimtalkTemplate 확인 — supabase 테이블 delete뿐,
  // Aligo API 호출 없음). 승인 완료(APR) 템플릿에 한해서만 "삭제"라는 표현이 "카카오
  // 승인까지 취소되는 것" 같은 오해를 줄 수 있어 문구를 "센터에서 제거"로 바꾸고, 실제로도
  // 로컬에서만 없어진다는 설명을 덧붙인다(실수로 원격 승인 템플릿을 지우는 새 기능을
  // 만들지 않음 — 기존 local-only 삭제 그대로).
  async function handleDelete(t: AlimtalkTemplate) {
    const isApproved = t.status === "approved";
    const ok = await globalThis.appConfirm(
      isApproved
        ? `"${t.title}"을(를) 이 센터에서 제거할까요?\n알리고에 등록된 카카오 승인 템플릿 자체는 그대로 남고, 이 센터 목록에서만 없어져요. 이 템플릿을 쓰는 자동 발송 규칙이 있다면 같이 꺼질 수 있어요.`
        : `"${t.title}" 템플릿을 삭제할까요? 이 템플릿을 쓰는 자동 발송 규칙이 있다면 같이 꺼질 수 있어요.`
    );
    if (!ok) return;
    try {
      await deleteAlimtalkTemplate(t.id);
      showToast(isApproved ? "센터에서 제거했어요" : "삭제했어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e, "템플릿을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.")); }
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
        <div style={{ display: "flex", gap: 6 }}>
          <button className="header-action" style={{ fontSize: 15, padding: "0 12px" }} onClick={openImportSheet}>알리고 불러오기</button>
          <button className="header-action" style={{ fontSize: 15, padding: "0 12px" }} onClick={openNew}>+ 템플릿</button>
        </div>
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button aria-pressed={c.id === centerId} key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      {error && <div className="daylist-empty" style={{ margin: "0 20px 10px" }}>{error}</div>}

      {loading ? (
        <Loading />
      ) : templates.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 60 }}>
          등록된 템플릿이 없어요.<br />
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
            <button className="outline-action" onClick={openImportSheet}>알리고 템플릿 불러오기</button>
            <button className="outline-action" onClick={openNew}>첫 템플릿 만들기</button>
          </div>
        </div>
      ) : (
        // A-8 — 기존 hist-item/hist-title/hist-sub/hist-status 클래스만 그대로 재사용(새
        // 카드 프레임/색상 없음). 이전엔 본문 미리보기와 코드가 한 줄에 합쳐져 있어 "관리자
        // 웹사이트 같다"는 인상을 줬다 — 제목·상태를 한 줄에, 본문 2줄 미리보기, 코드는
        // 더 작은 보조 줄로 분리해 정보 계층을 명확히 했다. 오른쪽 끝의 '›'는 새 아이콘을
        // 추가하지 않고 기존 back-header의 '‹' 글리프 관례를 그대로 따른 상세보기 표시.
        templates.map((t) => (
          <div key={t.id} className="hist-item clickable alimtalk-template-card" onClick={() => openEdit(t)}>
            <div className="hist-main">
              <div className="hist-title">
                {t.title}
                {t.centerId === null && <span className="grade-badge" style={{ marginLeft: 6 }}>공통</span>}
                <span className={`hist-status ${STATUS_BADGE[t.status]}`} style={{ marginLeft: "auto" }}>{STATUS_LABEL[t.status]}</span>
              </div>
              <div className="hist-sub alimtalk-template-preview">{t.content}</div>
              {t.aligoTemplateCode && <div className="hist-sub alimtalk-template-code">{t.aligoTemplateCode}</div>}
            </div>
            <span className="alimtalk-template-chevron" aria-hidden="true">›</span>
          </div>
        ))
      )}

      {editing && (
        <SheetOverlay className="sheet-overlay" swipeDismiss={!saving} onClick={() => !saving && setEditing(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {/* A-9 — 승인(APR) 완료 템플릿은 "수정"이 아니라 "상세"다. 고정 문구를 자유롭게
                고쳐서 보내면 카카오 심사를 통과한 문구와 실제 발송 문구가 달라질 수 있다. */}
            <div className="sheet-title">{editing === "new" ? "새 템플릿" : isApprovedDetail ? "템플릿 상세" : "템플릿 수정"}</div>
            {!canEditThis && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>
                공통 템플릿은 플랫폼 운영자만 수정/삭제할 수 있어요 — 읽기만 가능해요.
              </div>
            )}
            {isAdmin && editing === "new" && (
              <label className="csv-col" style={{ marginBottom: 8 }}>
                <input type="checkbox" checked={isCommon} onChange={(e) => setIsCommon(e.target.checked)} disabled={saving} />
                모든 센터 공통으로 등록
              </label>
            )}
            {editing !== "new" && editingIsCommon && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>공통 템플릿 — 모든 센터가 같이 써요.</div>
            )}
            {isApprovedDetail && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>
                카카오 승인이 끝난 문구는 그대로 유지돼요. 내용을 바꾸려면 "새 템플릿으로 복제"를 눌러 새로 만들고 다시 승인을 신청해주세요.
              </div>
            )}
            {isLocked && !isApprovedDetail && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>
                카카오 심사 중이에요 — 결과가 나올 때까지 수정할 수 없어요.
              </div>
            )}

            {/* A-11 — [템플릿 내용] 섹션: 이름/문구/변수 삽입만 */}
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>템플릿 내용</div>
            <input aria-label="템플릿 이름 (내부 관리용)" className="input-field" placeholder="템플릿 이름 (내부 관리용)" value={title}
              onChange={(e) => setTitle(e.target.value)} disabled={saving || !canEditThis || isLocked} style={{ marginBottom: 8 }} />
            {isApprovedDetail ? (
              // A-9 — 편집 가능한 textarea 대신 읽기 전용 미리보기로 보여준다(저장/상태
              // 변경 같은 편집 액션 자체가 노출되지 않음).
              <div className="alimtalk-readonly-content" aria-label="승인된 문구 (읽기 전용)">{content}</div>
            ) : (
              <>
                <label className="menu-section-label" htmlFor="template-content">문구</label>
                <textarea
                  id="template-content" ref={contentRef}
                  className="input-field"
                  style={{ minHeight: 120, resize: "vertical", paddingTop: 12, marginBottom: 8 }}
                  placeholder={"승인 신청용 문구를 입력하세요. 변수는 [[회원명]] 형태로 쓰세요.\n예: [[회원명]]님, [[수강권명]] 잔여횟수가 [[수강권 잔여횟수]]회 남았어요."}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  disabled={saving || !canEditThis || isLocked}
                />
                <div className="field-count">{content.length.toLocaleString()}자</div>
                {!isLocked && (
                  <div className="variable-chips" aria-label="문구에 변수 삽입">
                    {["회원명", "수강권명", "수강권 잔여횟수", "수강권 잔여일"].map(variable => <button key={variable} type="button" disabled={saving || !canEditThis} onClick={() => {
                      const field = contentRef.current;
                      const start = field?.selectionStart ?? content.length;
                      const end = field?.selectionEnd ?? start;
                      const token = `[[${variable}]]`;
                      setContent(content.slice(0, start) + token + content.slice(end));
                      requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + token.length, start + token.length); });
                    }}>{`[[${variable}]]`}</button>)}
                  </div>
                )}
              </>
            )}

            {/* A-11 — [카카오 승인] 섹션: 현재 상태(읽기 전용) + 승인 신청 버튼만.
                알리고 코드/내부 상태를 직접 바꾸는 input/select는 더 이상 없다 — 코드는
                카카오 승인 신청(handleRequestApproval)이 자동으로 채우고, 상태는 그 결과
                또는 "상태 새로고침"(handleRefreshStatus)로만 바뀐다. */}
            {editing !== "new" && editing && (
              <>
                <div className="menu-section-label" style={{ padding: "14px 0 6px" }}>카카오 승인</div>
                <div className="perm-guide" style={{ margin: "0 0 8px" }}>
                  현재 상태: <strong>{STATUS_LABEL[editing.status]}</strong>
                  {aligoCode && ` · ${aligoCode}`}
                </div>
                {canEditThis && !isLocked && !aligoCode && (
                  <button
                    type="button" className="outline-action compact" style={{ marginBottom: 8 }}
                    disabled={saving || requestingApproval} onClick={handleRequestApproval}
                  >
                    {requestingApproval ? "신청 중..." : "카카오 승인 신청하기"}
                  </button>
                )}
                {editing.status === "pending" && editing.aligoTemplateCode && (
                  <button
                    type="button" className="outline-action compact" style={{ marginBottom: 8 }}
                    disabled={refreshingStatus} onClick={handleRefreshStatus}
                  >
                    {refreshingStatus ? "확인 중..." : "상태 새로고침"}
                  </button>
                )}
              </>
            )}

            <div className="add-profile-actions">
              {editing !== "new" && canEditThis && (
                <button className="ghost-btn" disabled={saving} onClick={() => { handleDelete(editing); setEditing(null); }}>
                  {editing.status === "approved" ? "센터에서 제거" : "삭제"}
                </button>
              )}
              {isApprovedDetail && canEditThis && (
                <button className="outline-action compact" disabled={saving} onClick={() => cloneAsNew(editing as AlimtalkTemplate)}>
                  새 템플릿으로 복제
                </button>
              )}
              <button className="ghost-btn" disabled={saving} onClick={() => setEditing(null)}>{isLocked ? "닫기" : "취소"}</button>
              {!isLocked && canEditThis && (
                <button className="primary-btn" disabled={saving || !title.trim() || !content.trim()} onClick={handleSave}>
                  {saving ? "저장 중..." : "저장"}
                </button>
              )}
            </div>
          </div>
        </SheetOverlay>
      )}

      {importOpen && (() => {
        // A-12 — 이름/코드/내용으로 클라이언트 필터링(불필요한 API 재호출 없음, 이미 받아온
        // importList 안에서만 검색). A-13 — 각 항목을 눌러 전체 문구를 펼쳐볼 수 있다(기본
        // 2~3줄 미리보기, 다시 누르면 접힘) — "가져오기"를 누르기 전에 실제 승인 문구를
        // 확인할 수 있게 하기 위함.
        const q = importSearch.trim().toLowerCase();
        const filtered = !q ? importList : (importList ?? []).filter((t) =>
          t.templtName.toLowerCase().includes(q) || t.templtCode.toLowerCase().includes(q) || t.templtContent.toLowerCase().includes(q)
        );
        return (
          <SheetOverlay className="sheet-overlay" onClick={() => setImportOpen(false)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-title">알리고 템플릿 불러오기</div>
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>
                이미 알리고에 등록·승인된 템플릿을 골라 이 센터의 템플릿으로 가져올 수 있어요.
              </div>
              {importList && importList.length > 0 && (
                <input
                  aria-label="템플릿 검색" className="input-field" style={{ marginBottom: 10 }}
                  placeholder="템플릿 이름·코드·내용 검색"
                  value={importSearch} onChange={(e) => setImportSearch(e.target.value)}
                />
              )}
              {importLoading ? (
                <Loading />
              ) : importError ? (
                <div className="perm-guide" style={{ margin: "0 0 8px", color: "var(--danger)" }}>{importError}</div>
              ) : importList && importList.length === 0 ? (
                <div className="perm-guide" style={{ margin: "0 0 8px" }}>알리고에 등록된 템플릿이 없어요.</div>
              ) : filtered && filtered.length === 0 ? (
                <div className="perm-guide" style={{ margin: "0 0 8px" }}>검색 결과가 없어요.</div>
              ) : (
                filtered?.map((t) => {
                  const already = isAligoTemplateAlreadyImported(templates, t.templtCode);
                  const localStatus = inspStatusToLocalStatus(t.inspStatus);
                  const expanded = expandedCode === t.templtCode;
                  return (
                    <div key={t.templtCode} className="hist-item alimtalk-import-item" style={{ flexDirection: "column", alignItems: "stretch" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div className="hist-main">
                          <div className="hist-title">{t.templtName}</div>
                          {/* 원본 알리고 코드는 강조 없이 보조 정보로만(1-B) */}
                          <div className="hist-sub">{t.templtCode}</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flex: "0 0 auto" }}>
                          <span className={`hist-status ${STATUS_BADGE[localStatus]}`}>{ALIGO_INSP_STATUS_KO[t.inspStatus] ?? t.inspStatus}</span>
                          {already ? (
                            <span className="hist-sub">이미 등록됨</span>
                          ) : (
                            <button
                              type="button" className="outline-action compact"
                              disabled={importingCode !== null} onClick={() => handleImport(t)}
                            >
                              {importingCode === t.templtCode ? "가져오는 중..." : "가져오기"}
                            </button>
                          )}
                        </div>
                      </div>
                      <button
                        type="button" className="text-btn alimtalk-import-preview-toggle"
                        onClick={() => setExpandedCode(expanded ? null : t.templtCode)}
                        aria-expanded={expanded}
                      >
                        {expanded ? "내용 접기 ▲" : "내용 미리보기 ▼"}
                      </button>
                      <div className={`alimtalk-import-preview ${expanded ? "expanded" : ""}`}>{t.templtContent}</div>
                    </div>
                  );
                })
              )}
              <div className="add-profile-actions">
                <button className="ghost-btn" onClick={() => setImportOpen(false)}>닫기</button>
              </div>
            </div>
          </SheetOverlay>
        );
      })()}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
