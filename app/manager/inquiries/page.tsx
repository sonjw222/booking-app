"use client";

/*
  매니저 1:1 문의
  - 자기 센터로 온 문의방 목록
  - 채팅방에서 답변 (사진/글, 실시간)
*/

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Loading from "../../components/Loading";
import InquiryChat, { type InquiryDraft } from "../../components/InquiryChat";
import UiIcon from "../../components/UiIcon";
import InquiryWorkflowPanel from "../../components/InquiryWorkflowPanel";
import { fetchCenterThreads, type InquiryThread } from "../../../lib/inquiries";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";
import { useCenterSelection, preferredCenterId } from "../../../lib/managerCenterSelection";
import { getMyAccountId } from "../../../lib/authAccount";
import { readInquiryDrafts, writeInquiryDrafts } from "../../../lib/inquiryDraftStorage";
import { useUnsavedChanges, confirmDiscardChanges } from "../../../lib/useUnsavedChanges";

export default function ManagerInquiriesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ManagerInquiriesPageContent />
    </Suspense>
  );
}

function ManagerInquiriesPageContent() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [threads, setThreads] = useState<InquiryThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{ id: string; title: string; centerId: string } | null>(null);
  const [permsByCenter, setPermsByCenter] = useState<Record<string, Set<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, InquiryDraft>>({});
  const [draftAccount, setDraftAccount] = useState<string | null>(null);
  const [draftsReady, setDraftsReady] = useState(false);
  const [draftWarning, setDraftWarning] = useState(false);
  useUnsavedChanges(Object.values(drafts).some((draft) => !!draft.text.trim() || draft.photos.length > 0));
  useEffect(() => {
    let live = true;
    getMyAccountId().then((id) => { if (!live) return; setDraftAccount(id); if (id) setDrafts(readInquiryDrafts(id)); }).catch(() => { if (live) setDraftWarning(true); }).finally(() => { if (live) setDraftsReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (draftAccount && draftsReady) setDraftWarning(!writeInquiryDrafts(draftAccount, drafts)); }, [draftAccount, draftsReady, drafts]);
  const [centerId, setCenterId] = useCenterSelection();
  const visibleThreads = threads.filter((t) => t.centerId === centerId && (!unreadOnly || t.unread > 0) && `${t.memberName ?? ""} ${t.centerName} ${t.lastMessage ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  const searchParams = useSearchParams();

  // 센터마다 소속 역할이 다를 수 있어 관리 중인 센터별로 개인 유효 권한을 미리 계산해둔다
  // (오너인 센터는 계산 생략 — canSendForCenter에서 항상 true).
  useEffect(() => {
    const nonOwner = centers.filter((c) => !c.isOwner);
    if (nonOwner.length === 0) return;
    Promise.all(nonOwner.map((c) =>
      fetchMyEffectivePermissionKeys(c.managerCenterId, c.roleId).then((keys) => [c.id, keys] as const)
    )).then((pairs) => {
      setPermsByCenter(Object.fromEntries(pairs));
    }).catch(() => { /* 무시 — 실패 시 기본값(false)로 안전하게 처리됨 */ });
  }, [centers]);

  function canSendForCenter(centerId: string): boolean {
    const c = centers.find((x) => x.id === centerId);
    if (!c) return false;
    if (c.isOwner) return true;
    return permsByCenter[centerId]?.has("board.inquiry.comment") ?? false;
  }

  function canDeleteOthersForCenter(centerId: string): boolean {
    const c = centers.find((x) => x.id === centerId);
    if (!c) return false;
    if (c.isOwner) return true;
    return permsByCenter[centerId]?.has("board.inquiry.comment_other") ?? false;
  }

  async function loadThreads() {
    const list = await fetchCenterThreads();
    setThreads(list);
    return list;
  }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        setCenterId(preferredCenterId(list));
        if (list.length > 0) {
          const threadList = await loadThreads();
          // 신규 문의 알림에서 ?thread=<id>로 들어왔으면 목록이 아니라 그 스레드를 바로 연다(NOTIF-001 E-2)
          const threadParam = searchParams.get("thread");
          if (threadParam) {
            const found = threadList.find((t) => t.id === threadParam);
            if (found) { setCenterId(found.centerId); setActive({ id: found.id, title: found.centerName + " · 회원 문의", centerId: found.centerId }); }
          }
        }
      } catch (e: any) {
        // UX 감사(2026-09-06) — 예전엔 fetchCenterThreads()가 에러를 빈 배열로 삼켜서
        // 진짜 오류와 "문의 없음"을 구분할 수 없었다. 이제 여기서 에러를 그대로 보여준다.
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function backToList() {
    setActive(null);
    try { await loadThreads(); } catch (e: any) { setError(e.message); }
  }

  if (centers.length === 0 && !loading && !error) {
    return (
      <div className="app-shell">
        <div className="header">
          <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>1:1 문의</div>
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  if (loading || !draftsReady) return <Loading />;

  return (
    <div className={`app-shell inquiry-workspace ${active ? "has-active" : ""}`}>
      <section className="inquiry-index" aria-label="문의 목록">
      <div className="workflow-toolbar"><label>센터<select className="input-field" value={centerId ?? ""} onChange={async (e) => { const next = e.target.value; if (!await confirmDiscardChanges()) return; setCenterId(next); setActive(null); }}>{centers.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}</select></label><small>최근 대화 최대 500개에서 검색합니다. 답변 초안은 이 브라우저 탭에서 24시간 보관하며 로그아웃 시 삭제됩니다.</small>{draftWarning && <p role="alert">이 브라우저에서 초안을 보관하지 못했습니다. 이동 전에 내용을 복사해주세요.</p>}</div>
      <div className="workflow-toolbar"><label>문의 검색<input className="input-field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="회원·센터·최근 메시지" /></label><label><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> 읽지 않은 문의만</label><span>{visibleThreads.length}건</span></div>
      <div className="header">
        <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>1:1 문의</div>
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {error ? null : threads.length === 0 ? (
        <div className="empty-note" style={{ padding: "50px 20px", textAlign: "center", color: "var(--text-dim)" }}>
          아직 들어온 문의가 없어요.
        </div>
      ) : (
        <div className="thread-list">
          {visibleThreads.length === 0 && <p className="perm-guide">검색 조건에 맞는 문의가 없어요.</p>}
          {visibleThreads.map((t) => (
            <button key={t.id} className={`thread-row ${active?.id === t.id ? "selected" : ""}`} aria-pressed={active?.id === t.id} onClick={async () => { if (active?.id !== t.id && !await confirmDiscardChanges()) return; setActive({ id: t.id, title: t.centerName + " · 회원 문의", centerId: t.centerId }); }}>
              <div className="thread-avatar"><UiIcon name="message" size={18} /></div>
              <div className="thread-main">
                <div className="thread-top">
                  <span className="thread-name">{t.memberName ?? "회원"} - {t.centerName}</span>
                  {t.lastMessageAt && <span className="thread-time">{t.lastMessageAt}</span>}
                </div>
                <div className="thread-preview">{t.lastMessage ?? "새 문의"}</div>
              </div>
              {t.unread > 0 && <span className="thread-unread">{t.unread}</span>}
            </button>
          ))}
        </div>
      )}

      <div style={{ height: 20 }} />
      </section>
      <section className="inquiry-conversation" aria-label="문의 대화">
        {active && process.env.NEXT_PUBLIC_INQUIRY_WORKFLOW_ENABLED === "true" && <InquiryWorkflowPanel key={`workflow-${active.id}`} threadId={active.id} canEdit={canSendForCenter(active.centerId)} />}
        {active ? <InquiryChat key={active.id}
          draft={drafts[active.id]}
          onDraftChange={(draft) => setDrafts((prev) => ({ ...prev, [active.id]: draft }))}
          templates={["안녕하세요. 문의 내용을 확인하고 안내드리겠습니다.", "원하시는 수업 날짜와 시간을 알려주세요.", "추가로 궁금하신 점이 있으면 말씀해주세요."]}
          threadId={active.id} title={active.title} onBack={backToList}
          canSend={canSendForCenter(active.centerId)}
          canDeleteOthers={canDeleteOthersForCenter(active.centerId)}
        /> : <div className="inquiry-placeholder">목록에서 문의를 선택하면 대화와 답변을 확인할 수 있어요.</div>}
      </section>
    </div>
  );
}
