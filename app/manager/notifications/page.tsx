"use client";

/*
  관리자 알림 화면
  - 신규 구매 / 신규 후기 / 신규 예약·취소 등 알림 누적
  - 방문만으로 읽음 처리하지 않고, 선택하거나 열어 본 알림만 읽음 처리
  - 누르면 해당 관리 화면으로 이동
  - 릴리스 폴리시 배치 8차(2026-09-17): 전체 삭제, swipe actions(고정/삭제), 더보기 버튼
    중앙 정렬 추가/수정. pinned는 add_notification_pin.sql로 서버에 영구 저장.
*/

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import ConfirmDialog from "../../components/ConfirmDialog";
import SwipeRow from "../../components/SwipeRow";
import {
  fetchNotifications, markRead, deleteNotification, deleteAllNotifications,
  setNotificationPinned, notificationHref,
  type Notification,
} from "../../../lib/notifications";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";

const SWIPE_ACTION_WIDTH = 144;

export default function ManagerNotificationsPage() {
  const router = useRouter();
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [list, setList] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const filtered = list.filter((n) => (!unreadOnly || !n.read) && (category === "all" || notificationIcon(n.kind) === category) && `${n.title} ${n.body}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { setSelected(new Set()); setVisibleCount(20); }, [query, category, unreadOnly]);
  async function bulkAction(remove: boolean) {
    if (bulkBusy || selected.size === 0) return;
    const ids = filtered.filter((n) => selected.has(n.id)).map((n) => n.id);
    if (!ids.length) return;
    if (remove && !await globalThis.appConfirm(`선택한 알림 ${ids.length}건을 삭제할까요? 삭제 후 복구할 수 없습니다.`)) return;
    setBulkBusy(true); setError(null);
    try {
      if (!remove) { await markRead(ids, true); setList((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, read: true } : n)); setSelected(new Set()); }
      else {
        const results = await Promise.allSettled(ids.map((id) => deleteNotification(id)));
        const done = new Set(ids.filter((_, i) => results[i].status === "fulfilled"));
        setList((prev) => prev.filter((n) => !done.has(n.id)));
        setSelected(new Set(ids.filter((id) => !done.has(id))));
        if (done.size < ids.length) setError(`${ids.length - done.size}건을 삭제하지 못했어요. 실패한 항목만 다시 선택되어 있습니다.`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "처리하지 못했어요"); }
    finally { setBulkBusy(false); }
  }
  // UX 감사(B-8) — 알림이 쌓이면(실측 10,000px+) 페이징 없이 전부 렌더됐다. 20개씩 "더보기".
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // swipe로 열려 있는 row(한 번에 하나만 — 다른 row를 열면 기존 row는 자동으로 닫힘).
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  // 삭제 애니메이션(row collapse + opacity) 중인 row id.
  const [removingId, setRemovingId] = useState<string | null>(null);
  // 개별 삭제/고정 중복 요청 방지(같은 id로 두 번째 요청이 오면 무시).
  const busyIds = useRef<Set<string>>(new Set());

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  useEffect(() => {
    (async () => {
      try {
      const myCenters = await fetchMyCenters();
      setCenters(myCenters);
      if (myCenters.length > 0) {
        const ns = await fetchNotifications(100, true);
        setList(ns);
      }
      } catch (e) { setError(e instanceof Error ? e.message : "알림을 불러오지 못했어요"); }
      finally { setLoading(false); }
    })();
  }, []);

  // outside tap(리스트 바깥 아무 곳이나 탭) 시 열려 있는 row를 닫는다.
  useEffect(() => {
    if (!openRowId) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-swipe-row-id]")) return;
      setOpenRowId(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openRowId]);

  function handleClick(n: Notification) {
    void markRead([n.id], true).catch(() => {});
    // 신규 문의 알림은 목록이 아니라 해당 스레드로 바로 이동(NOTIF-001 E-2) — 토스트 팝업과
    // 동일한 판단 로직을 공유한다(notificationHref).
    router.push(notificationHref(n));
  }

  async function handleDelete(id: string) {
    if (busyIds.current.has(id)) return; // 중복 요청 방지
    busyIds.current.add(id);
    setOpenRowId((v) => (v === id ? null : v));
    setRemovingId(id);
    try {
      await deleteNotification(id);
      // collapse + opacity 애니메이션이 보이도록 잠깐 기다렸다가 목록에서 실제로 제거.
      window.setTimeout(() => {
        setList((prev) => prev.filter((n) => n.id !== id));
        setRemovingId((v) => (v === id ? null : v));
        busyIds.current.delete(id);
      }, 220);
    } catch {
      // 실패 시 기존 목록 유지(=아무것도 안 지움), 애니메이션만 취소.
      setRemovingId((v) => (v === id ? null : v));
      busyIds.current.delete(id);
    }
  }

  async function handleTogglePin(n: Notification) {
    if (busyIds.current.has(n.id)) return;
    busyIds.current.add(n.id);
    const nextPinned = !n.pinned;
    const prevList = list;
    // 낙관적 갱신 + 정렬(고정 우선, 그 안은 최신순 유지) — 서버 실패 시 롤백.
    setList((prev) => {
      const updated = prev.map((item) => item.id === n.id ? { ...item, pinned: nextPinned } : item);
      return [...updated].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.createdAtRaw.localeCompare(a.createdAtRaw);
      });
    });
    setOpenRowId((v) => (v === n.id ? null : v));
    try {
      await setNotificationPinned(n.id, nextPinned);
    } catch {
      setList(prevList); // 롤백
    } finally {
      busyIds.current.delete(n.id);
    }
  }

  async function handleDeleteAll() {
    if (deletingAll) return; // 더블탭/중복 요청 방지
    setDeletingAll(true);
    try {
      await deleteAllNotifications();
      setList([]);
      setOpenRowId(null);
      setConfirmDeleteAll(false);
    } catch {
      // 실패 시 기존 목록 유지 — 모달은 열어둔 채 버튼만 원상 복구해 재시도 가능하게 한다.
    } finally {
      setDeletingAll(false);
    }
  }

  function notificationIcon(kind: string) {
    if (kind.includes("reservation") || kind.includes("waitlist") || kind === "no_show") return "calendar" as const;
    if (kind.includes("order")) return "receipt" as const;
    if (kind.includes("review")) return "star" as const;
    if (kind.includes("inquiry")) return "message" as const;
    if (kind.includes("announcement")) return "megaphone" as const;
    return "bell" as const;
  }

  function priorityOf(kind: string) {
    return ["reservation_canceled", "no_show", "reservation_today", "new_inquiry"].includes(kind) ? "important" : "normal";
  }

  if (centers.length === 0 && !loading && !error) {
    return (
      <div className="app-shell">
        <div className="header">
          <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>알림</div>
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  if (loading) return <Loading />;

  return (
    <div className="app-shell manager-notifications-v2">
      {error && <p role="alert" className="auth-msg error">{error}</p>}
      <p className="menu-section-label">최근 알림 최대 100건에서 검색합니다. 고정된 알림이 먼저 표시됩니다.</p>
      <div className="workflow-toolbar">
        <label>알림 검색<input className="input-field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="제목·내용" /></label>
        <label>유형<select className="input-field" value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">전체</option><option value="calendar">예약·취소</option><option value="receipt">주문</option><option value="message">문의</option><option value="star">후기</option><option value="megaphone">공지</option><option value="bell">기타</option></select></label>
        <label><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> 읽지 않음</label>
        <button className="outline-action" disabled={bulkBusy} onClick={() => setSelected(new Set(filtered.map((n) => n.id)))}>결과 {filtered.length}건 선택</button>
        <button className="outline-action" disabled={bulkBusy || !selected.size} onClick={() => setSelected(new Set())}>선택 해제</button>
        <button className="outline-action" disabled={bulkBusy || !selected.size} onClick={() => bulkAction(false)}>선택 읽음</button>
        <button className="outline-action" disabled={bulkBusy || !selected.size} onClick={() => bulkAction(true)}>선택 삭제 ({selected.size})</button>
      </div>
      <ConfirmDialog
        open={confirmDeleteAll}
        title="모든 알림을 삭제할까요?"
        description="삭제한 알림은 복구할 수 없습니다."
        confirmLabel="전체 삭제"
        danger
        busy={deletingAll}
        onCancel={() => { if (!deletingAll) setConfirmDeleteAll(false); }}
        onConfirm={handleDeleteAll}
      />

      {list.length > 0 && (
        <div className="noti-page-head">
          <span className="noti-page-count">{list.length}건</span>
          <button type="button" className="noti-delete-all-btn" onClick={() => setConfirmDeleteAll(true)}>
            전체 삭제
          </button>
        </div>
      )}

      {list.length === 0 ? (
        <div className="empty-note" style={{ padding: "50px 20px", textAlign: "center", color: "var(--text-dim)" }}>
          아직 알림이 없어요.
        </div>
      ) : (
        <div className="noti-list">
          {filtered.length === 0 && <p className="perm-guide">조건에 맞는 알림이 없어요.</p>}
          {filtered.slice(0, visibleCount).map((n) => (
            <div key={n.id} className={`noti-row-wrap ${removingId === n.id ? "removing" : ""}`}>
              <SwipeRow
                id={n.id}
                openId={openRowId}
                onOpenChange={setOpenRowId}
                actionWidth={SWIPE_ACTION_WIDTH}
                actions={
                  <>
                    <button
                      type="button"
                      className="swipe-action-btn pin"
                      aria-label={n.pinned ? "고정 해제" : "고정"}
                      onClick={() => handleTogglePin(n)}
                    >
                      <UiIcon name="pin" size={19} />
                      <span>{n.pinned ? "고정 해제" : "고정"}</span>
                    </button>
                    <button
                      type="button"
                      className="swipe-action-btn delete"
                      aria-label="삭제"
                      onClick={() => handleDelete(n.id)}
                    >
                      <UiIcon name="close" size={19} />
                      <span>삭제</span>
                    </button>
                  </>
                }
              >
                <div
                  className={`noti-row ${n.read ? "" : "unread"} priority-${priorityOf(n.kind)}`}
                  onClick={() => handleClick(n)}
                >
                  <input type="checkbox" aria-label={`${n.title} 선택`} disabled={bulkBusy} checked={selected.has(n.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => { const checked = e.target.checked; setSelected((prev) => { const next = new Set(prev); if (checked) next.add(n.id); else next.delete(n.id); return next; }); }} />
                  <span className={`noti-emoji kind-${n.kind}`}><UiIcon name={notificationIcon(n.kind)} size={21} /></span>
                  <div className="noti-main">
                    <div className="noti-title-row">
                      {n.pinned && <span className="noti-pin-badge" aria-hidden="true"><UiIcon name="pin" size={11} />고정</span>}
                      <div className="noti-title">{n.title}</div>
                      {n.kind === "reservation_canceled" && <span className="noti-state danger">취소</span>}
                      {n.kind === "no_show" && <span className="noti-state danger">노쇼</span>}
                    </div>
                    <div className="noti-body">{n.body}</div>
                    <div className="noti-time">{n.createdAt}</div>
                  </div>
                  <button
                    className="noti-del"
                    onClick={(e) => { e.stopPropagation(); handleDelete(n.id); }}
                    aria-label="삭제"
                  >×</button>
                </div>
              </SwipeRow>
            </div>
          ))}
          {filtered.length > visibleCount && (
            <div className="noti-load-more-row">
              <button type="button" className="noti-load-more-btn" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
                더보기 ({filtered.length - visibleCount}건 더 있음)
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}
