"use client";

/*
  매니저 - 알림톡 보내기 (더보기 > 알림톡 > 알림톡 보내기)
  회원탭(app/manager/members/page.tsx)의 발송 시트와 같은 컴포저(AlimtalkComposer)·같은
  발송 함수(sendAlimtalkToMembers)를 재사용한다 — 여기는 회원탭 진입 없이 검색으로 대상을
  골라 바로 보내는 진입점.
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../../components/Loading";
import AlimtalkComposer, {
  emptyAlimtalkBlocks, flattenAlimtalkBlocks, hasAlimtalkContent, type AlimtalkBlock,
} from "../../../components/AlimtalkComposer";
import { fetchMyCenters, type ManagedCenter } from "../../../../lib/manager";
import {
  fetchMembers, fetchGrades, sendAlimtalkToMembers, type CenterMember, type Grade,
} from "../../../../lib/members";
import { fetchAlimtalkTemplates, type AlimtalkTemplate } from "../../../../lib/alimtalk";
import { fetchCenterSubscription } from "../../../../lib/centerSubscription";

const STATUS_LABEL: Record<string, string> = {
  active: "이용중", expired: "만료", dormant: "휴면",
};

export default function AlimtalkSendPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [members, setMembers] = useState<CenterMember[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [gradeFilter, setGradeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [composerOpen, setComposerOpen] = useState(false);
  const [blocks, setBlocks] = useState<AlimtalkBlock[]>(emptyAlimtalkBlocks());
  const [templates, setTemplates] = useState<AlimtalkTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [addonEnabled, setAddonEnabled] = useState(true); // 확인 전까지는 막지 않음(로딩 중 깜빡임 방지)
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2600); }

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

  // 센터가 바뀔 때만 다시 불러오는 것들(필터/검색과 무관) — 템플릿 목록, 등급 목록,
  // 애드온 신청 여부.
  const loadMeta = useCallback(async () => {
    if (!centerId) return;
    try { setGrades(await fetchGrades(centerId)); } catch { setGrades([]); }
    // 템플릿 관리 화면(app/manager/alimtalk/templates)에서 만든 템플릿을 여기서 바로
    // 불러올 방법이 없어 보낼 때마다 처음부터 다시 타이핑해야 했다(2026-09-06 UX 감사).
    try { setTemplates(await fetchAlimtalkTemplates(centerId)); } catch { setTemplates([]); }
    // 알림톡 애드온 미신청 센터는 어차피 서버(send-alimtalk)가 발송을 거부하므로,
    // 여러 명 실패 토스트를 보고 나서야 알게 되는 대신 여기서 미리 안내한다.
    try { setAddonEnabled((await fetchCenterSubscription(centerId))?.alimtalkAddon ?? false); }
    catch { setAddonEnabled(true); }
  }, [centerId]);

  useEffect(() => { loadMeta(); }, [loadMeta]);

  // 등급/상태 필터 + 검색(콤마로 여러 명 동시 검색 가능, lib/members.ts의 fetchMembers 참고)
  const loadMembers = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      setMembers(await fetchMembers(centerId, { gradeId: gradeFilter, status: statusFilter, keyword, searchField: "all" }));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, gradeFilter, statusFilter, keyword]);

  // 검색어 입력 중엔 300ms 기다렸다 조회 (결과 깜빡임 방지, app/manager/members와 동일 패턴)
  useEffect(() => {
    const t = setTimeout(() => { loadMembers(); }, 300);
    return () => clearTimeout(t);
  }, [loadMembers]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds(new Set(members.map((m) => m.id)));
  }

  async function handleSend() {
    if (!centerId || selectedIds.size === 0 || !hasAlimtalkContent(blocks)) return;
    const targets = members.filter((m) => selectedIds.has(m.id));
    const content = flattenAlimtalkBlocks(blocks);
    // 승인된 템플릿을 고르고 문구를 그대로 뒀을 때만 templateCode를 실어 진짜 카카오 알림톡으로
    // 나가게 한다 — 고른 뒤 내용을 고치면(아래 onChange에서) 선택이 자동 해제되므로, 여기 남아있는
    // templateId는 항상 "문구가 승인된 템플릿과 일치"를 뜻한다.
    const selectedTemplate = templates.find((t) => t.id === templateId);
    const templateCode =
      selectedTemplate && selectedTemplate.status === "approved" && selectedTemplate.aligoTemplateCode
        ? selectedTemplate.aligoTemplateCode
        : undefined;
    // 알림톡(templateCode 있음)과 SMS는 건당 요금이 다르다 — SMS로 나갈 때는 실수로 카톡인 줄
    // 알고 다수 발송하는 걸 막기 위해 매번 확인받는다(app/components/AppConfirmProvider.tsx,
    // 다른 화면의 삭제/취소 확인과 같은 패턴).
    if (!templateCode) {
      const recipientCount = targets.filter((m) => m.phone).length;
      const ok = await globalThis.appConfirm(
        `카카오 알림톡이 아니라 SMS로 나가요.\n번호가 있는 ${recipientCount}명에게 SMS 요금이 발생해요 — 계속할까요?`
      );
      if (!ok) return;
    }
    setSending(true);
    try {
      const result = await sendAlimtalkToMembers(targets, content, centerId, templateCode);
      const parts: string[] = [];
      if (result.sent > 0) parts.push(`${result.sent}명 발송`);
      if (result.skipped > 0) parts.push(`${result.skipped}명 번호 없음`);
      if (result.failed > 0) parts.push(`${result.failed}명 실패`);
      showToast(parts.join(" · "));
      setSelectedIds(new Set());
      setComposerOpen(false);
      setBlocks(emptyAlimtalkBlocks());
      setTemplateId("");
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  }

  function closeComposer() {
    if (sending) return;
    setComposerOpen(false);
    setBlocks(emptyAlimtalkBlocks());
    setTemplateId("");
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager/alimtalk">‹</a>
          <div className="title">알림톡 보내기</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/manager/alimtalk">‹</a>
        <div className="title">알림톡 보내기</div>
        <div style={{ minWidth: 30 }}>
          {selectedIds.size > 0 && (
            <button className="header-action" style={{ whiteSpace: "nowrap" }} onClick={() => setComposerOpen(true)}>
              알림톡 보내기 ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => { setCenterId(c.id); setSelectedIds(new Set()); setComposerOpen(false); setBlocks(emptyAlimtalkBlocks()); setTemplateId(""); }}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {error && <div className="daylist-empty" style={{ margin: "0 20px 10px" }}>{error}</div>}

      {!loading && !addonEnabled && (
        <div className="daylist-empty" style={{ margin: "0 20px 10px" }}>
          이 센터는 카카오 알림톡/SMS 발송 애드온을 신청하지 않아 발송할 수 없어요. 플랫폼 운영자에게 문의해주세요.
        </div>
      )}

      {addonEnabled && (
        <>
          <div style={{ padding: "0 20px 10px" }}>
            <input
              className="input-field"
              placeholder="이름 또는 전화번호로 검색 (콤마로 여러 명: 회원1,회원2)"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          <div className="mem-filters">
            <button className={`filter-chip ${!gradeFilter ? "on" : ""}`} onClick={() => setGradeFilter(null)}>등급 전체</button>
            {grades.map((g) => (
              <button key={g.id} className={`filter-chip ${gradeFilter === g.id ? "on" : ""}`} onClick={() => setGradeFilter(g.id)}>
                <span className="grade-dot" style={{ background: g.color ?? "var(--line-strong)" }} />{g.name}
              </button>
            ))}
          </div>
          <div className="mem-filters">
            <button className={`filter-chip ${!statusFilter ? "on" : ""}`} onClick={() => setStatusFilter(null)}>상태 전체</button>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <button key={k} className={`filter-chip ${statusFilter === k ? "on" : ""}`} onClick={() => setStatusFilter(k)}>{v}</button>
            ))}
          </div>

          <div style={{ padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="info">{selectedIds.size > 0 ? `${selectedIds.size}명 선택됨 (전체 ${members.length}명 중)` : `${members.length}명`}</span>
            <button className="outline-action compact" onClick={selectAllFiltered} disabled={members.length === 0}>검색결과 전체 선택</button>
          </div>

          {loading ? (
            <Loading />
          ) : (
            <div className="mem-detail-list" style={{ padding: "0 20px" }}>
              {members.length === 0 ? (
                <div className="daylist-empty">회원이 없어요</div>
              ) : (
                members.map((m) => (
                  <label key={m.id} className="mem-detail-row" style={{ cursor: "pointer" }}>
                    <span className="mem-detail-main">
                      <input type="checkbox" checked={selectedIds.has(m.id)} onChange={() => toggle(m.id)} style={{ marginRight: 8 }} />
                      {m.name}{m.phone ? ` · ${m.phone}` : " · 번호없음"}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}
        </>
      )}

      {composerOpen && (
        <div className="sheet-overlay" onClick={closeComposer}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">알림톡 보내기</div>
            <div className="perm-guide" style={{ margin: "0 0 10px" }}>
              선택한 {selectedIds.size}명에게 보내요. 전화번호가 없는 회원은 자동으로 건너뜁니다.
            </div>
            {templates.length > 0 && (
              <select
                className="input-field"
                style={{ marginBottom: 10 }}
                value={templateId}
                disabled={sending}
                onChange={(e) => {
                  const id = e.target.value;
                  setTemplateId(id);
                  const t = templates.find((x) => x.id === id);
                  if (t) setBlocks([{ type: "text", value: t.content }]);
                }}
              >
                <option value="">템플릿 불러오기 (선택)</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}{t.status !== "approved" ? ` · ${t.status === "pending" ? "승인대기" : t.status === "rejected" ? "반려됨" : "임시"}` : ""}</option>
                ))}
              </select>
            )}
            <AlimtalkComposer
              blocks={blocks}
              onChange={(next) => {
                setBlocks(next);
                // 템플릿을 고른 뒤 문구를 고치면 더 이상 승인된 템플릿과 일치하지 않으므로
                // 선택을 풀어 SMS 대체발송으로만 나가게 한다(발송 시 알리고가 거부하는 것보다
                // 미리 막는 편이 안전).
                if (templateId) {
                  const t = templates.find((x) => x.id === templateId);
                  if (t && flattenAlimtalkBlocks(next) !== t.content) setTemplateId("");
                }
              }}
              disabled={sending}
            />
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              {(() => {
                const t = templates.find((x) => x.id === templateId);
                return t && t.status === "approved" && t.aligoTemplateCode
                  ? "승인된 템플릿 그대로 보내면 카카오 알림톡으로 나가요."
                  : "카카오 알림톡은 승인된 템플릿 문구 그대로만 가능해요 — 지금은 SMS로 나가요.";
              })()}
            </div>
            <div className="add-profile-actions">
              <button className="ghost-btn" disabled={sending} onClick={closeComposer}>취소</button>
              <button className="primary-btn" disabled={sending || !hasAlimtalkContent(blocks)} onClick={handleSend}>
                {sending ? "발송 중..." : "발송"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
