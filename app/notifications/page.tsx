"use client";

/*
  회원 알림 화면
  - 공지 / 예약 임박 / 수강권 만료·소진 재등록 등 알림 누적 목록
  - 들어오면 전체 읽음 처리
  - 공지 알림은 눌러서 상세(제목/본문/사진) 확인
  - 재등록 알림은 눌러서 센터로 이동해 바로 결제
  - 안정화 배치(2026-09-22) — 관리자 알림(app/manager/notifications/page.tsx)에서 쓰던
    swipe-to-delete를 SwipeRow(공용 컴포넌트)로 그대로 재사용.
  - 실기기 QA(2026-09-25) — 사용자 요청으로 관리자 알림과 동일하게 방향별 action:
    오른쪽→왼쪽 = 삭제, 왼쪽→오른쪽 = 고정 / 고정 해제(기존 notifications.pinned 컬럼과
    setNotificationPinned 재사용 — DB/RLS 변경 없음, fetchNotifications가 이미 고정 우선 정렬).
*/

import { useEffect, useRef, useState } from "react";
import Loading from "../components/Loading";
import { ZoomableImage } from "../components/ImageViewer";
import UiIcon from "../components/UiIcon";
import EmptyState from "../components/EmptyState";
import SwipeRow from "../components/SwipeRow";
import {
  fetchNotifications, markRead, deleteNotification, setNotificationPinned, notificationHref,
  type Notification,
} from "../../lib/notifications";
import {
  fetchMyAnnouncements, announcementPhotoUrl, type Announcement,
} from "../../lib/announcements";
import { formatMonthDayWeekday } from "../../lib/kst";

// UX 감사(A-17) — 알림이 쌓이면(실측 9,600px) 날짜 구분도 페이징도 없이 쭉 나열됐다. 카드
// 탭 시 딥링크 이동, 읽음/안읽음 구분(진입 즉시 자동 읽음 처리)은 이미 구현돼 있었음
// (리포트가 놓친 부분) — 날짜 그룹핑 + 20개씩 "더보기"만 추가한다.
const KST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" });
function dateHeading(iso: string) {
  const d = new Date(iso);
  const today = KST_DATE.format(new Date());
  const key = KST_DATE.format(d);
  if (key === today) return "오늘";
  const [y, m, day] = key.split("-").map(Number);
  return formatMonthDayWeekday(y, m, day);
}

const SWIPE_ACTION_WIDTH = 88; // 좌(고정/해제)·우(삭제) 각각 1개 — 관리자 알림과 동일(공용 SwipeRow).

export default function NotificationsPage() {
  const [list, setList] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [announcements, setAnnouncements] = useState<(Announcement & { centerName: string })[]>([]);
  const [openAnnounce, setOpenAnnounce] = useState<(Announcement & { centerName: string }) | null>(null);
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // swipe로 열려 있는 row(한 번에 하나만) — app/manager/notifications/page.tsx와 동일 패턴.
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const busyIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const [ns, ans] = await Promise.all([fetchNotifications(), fetchMyAnnouncements()]);
      setList(ns);
      setAnnouncements(ans);
      setLoading(false);
      // 전체 읽음 처리 (뱃지 제거)
      await markRead();
    })();
  }, []);

  // outside tap(리스트 바깥 아무 곳이나 탭) 시 열려 있는 row를 닫는다 — 관리자 알림과 동일.
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
    // 공지 알림이면 상세 시트 열기
    if (n.kind === "announcement" && n.data?.announcement_id) {
      const found = announcements.find((a) => a.id === n.data.announcement_id);
      if (found) { setOpenAnnounce(found); return; }
    }
    // 문의 답변 알림은 목록이 아니라 해당 스레드로 바로 이동(NOTIF-001 E-2) — 토스트 팝업과
    // 동일한 판단 로직을 공유한다(notificationHref).
    window.location.href = notificationHref(n);
  }

  async function handleDelete(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (busyIds.current.has(id)) return; // 중복 요청 방지(× 버튼과 swipe 둘 다 연결돼 있어 동시 클릭 가능)
    busyIds.current.add(id);
    setOpenRowId((v) => (v === id ? null : v));
    setRemovingId(id);
    try {
      await deleteNotification(id);
      // collapse + opacity 애니메이션이 보이도록 잠깐 기다렸다가 목록에서 실제로 제거
      // (app/manager/notifications/page.tsx와 동일 패턴).
      window.setTimeout(() => {
        setList((prev) => prev.filter((n) => n.id !== id));
        setRemovingId((v) => (v === id ? null : v));
        busyIds.current.delete(id);
      }, 220);
    } catch {
      setRemovingId((v) => (v === id ? null : v));
      busyIds.current.delete(id);
    }
  }

  // 고정 / 고정 해제 — 관리자 알림(app/manager/notifications)과 같은 낙관적 갱신 + 실패 시 롤백.
  // 정렬은 서버(fetchNotifications)와 동일: 고정 우선, 그 안은 최신순.
  async function handleTogglePin(n: Notification) {
    if (busyIds.current.has(n.id)) return;
    busyIds.current.add(n.id);
    const nextPinned = !n.pinned;
    const prevList = list;
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
      setList(prevList);
    } finally {
      busyIds.current.delete(n.id);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="app-shell member-notifications">
      <div className="noti-head">
        <h1>알림</h1>
        <a href="/settings/notifications">설정</a>
      </div>

      {list.length === 0 ? (
        <EmptyState icon="bell" title="아직 알림이 없어요"
          description="예약과 수강권 소식을 이곳에서 알려드릴게요."
          action={<a className="ghost-btn" href="/reservation">수업 둘러보기</a>} />
      ) : (() => {
        const shown = list.slice(0, visibleCount);
        const groups: { heading: string; items: Notification[] }[] = [];
        for (const n of shown) {
          const heading = dateHeading(n.createdAtRaw);
          const last = groups[groups.length - 1];
          if (last && last.heading === heading) last.items.push(n);
          else groups.push({ heading, items: [n] });
        }
        return (
        <div className="noti-list">
          {groups.map((g) => (
            <div key={g.heading}>
              <div className="menu-section-label">{g.heading}</div>
              {g.items.map((n) => (
                <div key={n.id} className={`noti-row-wrap ${removingId === n.id ? "removing" : ""}`}>
                  <SwipeRow
                    id={n.id}
                    openId={openRowId}
                    onOpenChange={setOpenRowId}
                    leftActionWidth={SWIPE_ACTION_WIDTH}
                    rightActionWidth={SWIPE_ACTION_WIDTH}
                    leftAction={
                      <button
                        type="button"
                        className="swipe-action-btn pin"
                        aria-label={n.pinned ? "고정 해제" : "고정"}
                        onClick={() => handleTogglePin(n)}
                      >
                        <UiIcon name="pin" size={19} />
                        <span>{n.pinned ? "고정 해제" : "고정"}</span>
                      </button>
                    }
                    rightAction={
                      <button
                        type="button"
                        className="swipe-action-btn delete"
                        aria-label="삭제"
                        onClick={() => handleDelete(n.id)}
                      >
                        <UiIcon name="close" size={19} />
                        <span>삭제</span>
                      </button>
                    }
                  >
                    <div
                      className={`noti-row ${n.read ? "" : "unread"}`}
                      onClick={() => handleClick(n)}
                    >
                      <span className="noti-emoji"><UiIcon name={n.kind === "announcement" ? "megaphone" : n.kind.includes("reservation") ? "calendar" : n.kind.includes("class") ? "clock" : "ticket"} size={22} /></span>
                      <div className="noti-main">
                        <div className="noti-title-row">
                          {n.pinned && <span className="noti-pin-badge" aria-hidden="true"><UiIcon name="pin" size={11} />고정</span>}
                          <div className="noti-title">{n.title}</div>
                        </div>
                        <div className="noti-body">{n.body}</div>
                        <div className="noti-time">{n.createdAt}</div>
                      </div>
                      <button className="noti-del" onClick={(e) => handleDelete(n.id, e)}>×</button>
                    </div>
                  </SwipeRow>
                </div>
              ))}
            </div>
          ))}
          {list.length > visibleCount && (
            <button className="ghost-btn" style={{ margin: "12px 20px" }} onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
              더보기 ({list.length - visibleCount}건 더 있음)
            </button>
          )}
        </div>
        );
      })()}

      {/* 공지 상세 시트 */}
      {openAnnounce && (
        <div className="sheet-overlay" onClick={() => setOpenAnnounce(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="announce-detail-center">{openAnnounce.centerName}</div>
            <div className="sheet-title" style={{ marginTop: 2 }}>{openAnnounce.title}</div>
            <div className="announce-detail-date">{openAnnounce.createdAt}</div>
            <div className="announce-body" style={{ marginTop: 12 }}
              dangerouslySetInnerHTML={{ __html: openAnnounce.body }} />
            {openAnnounce.photos && openAnnounce.photos.length > 0 && (
              <div className="review-photos" style={{ marginTop: 12 }}>
                {openAnnounce.photos.map((ph, i) => (
                  <ZoomableImage
                    key={i} className="review-photo" src={announcementPhotoUrl(ph) ?? ""}
                    group={openAnnounce.photos!.map((p) => announcementPhotoUrl(p) ?? "")} groupIndex={i}
                  />
                ))}
              </div>
            )}
            <button className="ghost-btn" style={{ width: "100%", marginTop: 16 }} onClick={() => setOpenAnnounce(null)}>
              닫기
            </button>
          </div>
        </div>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}
