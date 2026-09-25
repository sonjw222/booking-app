"use client";

/*
  "캘린더에 추가" 선택 시트(2026-09-26, 앱 전용 — 웹은 시트 없이 바로 .ics 내보내기).
  기존 공용 시트 패턴(.sheet / .sheet-title + .sheet-close-btn / .sheet-option 행)을 그대로 재사용한다
  (센터 선택 시트와 같은 계열).

  · 일정 1건: [기본 캘린더에 추가] [다른 캘린더 앱 선택]
  · 일정 여러 건(상단 "내 캘린더에 추가"): 시스템 일정 추가 화면은 한 번에 하나만 받으므로 일정을 목록으로
    보여주고 하나씩 [추가]하게 한다 + [전체를 .ics로 내보내기/다른 앱 선택]. 결과가 확인된 경우(iOS에서 사용자가
    저장함)에만 "추가됨" 표시 — Android는 저장 여부를 앱이 알 수 없어 표시하지 않는다(가짜 성공 없음).
*/
import { useState } from "react";
import UiIcon from "./UiIcon";
import type { CalReservation } from "../../lib/mypage";
import {
  addReservationToCalendar, addReservationsAsFile, isCalendarAddBusy,
  type CalendarAddMode, type CalendarAddResult, type CalendarPlatform,
} from "../../lib/calendarAdd";

export default function CalendarAddSheet({ items, platform, onClose, onDone, onError }: {
  items: CalReservation[];
  platform: CalendarPlatform;
  onClose: () => void;
  onDone: (result: CalendarAddResult, count: number) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());

  async function addOne(r: CalReservation, mode: CalendarAddMode, closeAfter: boolean) {
    if (busy || isCalendarAddBusy(`one:${r.id}`)) return; // 중복 탭 방지(컴포넌트 + 모듈 in-flight 이중 잠금)
    setBusy(true);
    try {
      const res = await addReservationToCalendar(r, mode, platform);
      if (res.kind === "saved") setAdded((prev) => new Set(prev).add(r.id));
      onDone(res, 1);
      if (closeAfter && res.kind !== "cancelled") onClose(); // 취소했으면 시트를 남겨 다른 방법을 고를 수 있게
    } catch (e) {
      onError(e instanceof Error ? e.message : "캘린더에 추가하지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  async function addAllAsFile() {
    if (busy || isCalendarAddBusy("many")) return;
    setBusy(true);
    try {
      const res = await addReservationsAsFile(items, "모하빗_예약.ics", platform);
      onDone(res, items.length);
      if (res.kind !== "cancelled") onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "캘린더 파일을 내보내지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  const single = items.length === 1 ? items[0] : null;
  const otherLabel = "다른 캘린더 앱 선택";

  return (
    <div className="sheet-overlay" onClick={busy ? undefined : onClose}>
      <div className="sheet calendar-add-sheet" role="dialog" aria-modal="true" aria-label="캘린더에 추가" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          캘린더에 추가
          <button type="button" className="sheet-close-btn" aria-label="닫기" onClick={onClose}>
            <UiIcon name="close" size={20} />
          </button>
        </div>

        {single ? (
          <>
            <div className="calendar-add-summary">
              <b>{single.time} · {single.title}</b>
              <span>{single.centerName}</span>
            </div>
            <button type="button" className="sheet-option" disabled={busy} onClick={() => addOne(single, "default", true)}>
              <span className="sheet-option-label">
                기본 캘린더에 추가
                <small>{platform === "ios" ? "일정 추가 화면에서 저장을 눌러 확정해요" : "캘린더 앱의 일정 추가 화면이 열려요"}</small>
              </span>
            </button>
            <button type="button" className="sheet-option" disabled={busy} onClick={() => addOne(single, "chooser", true)}>
              <span className="sheet-option-label">
                {otherLabel}
                <small>{platform === "ios" ? "공유 창에서 설치된 캘린더 앱을 골라요" : "설치된 캘린더 앱 중에서 골라요"}</small>
              </span>
            </button>
          </>
        ) : (
          <>
            <div className="calendar-add-summary"><span>예약 {items.length}건 — 하나씩 캘린더에 추가할 수 있어요</span></div>
            <div role="list">
              {items.map((r) => (
                <div key={r.id} role="listitem" className="sheet-option calendar-add-row">
                  <span className="sheet-option-label">
                    {r.date.slice(5).replace("-", ".")} {r.time} · {r.title}
                    <small>{r.centerName}</small>
                  </span>
                  {added.has(r.id)
                    ? <span className="calendar-add-done">추가됨</span>
                    : <button type="button" className="calendar-add-btn" disabled={busy} onClick={() => addOne(r, "default", false)}>추가</button>}
                </div>
              ))}
            </div>
            <button type="button" className="sheet-option" disabled={busy} onClick={addAllAsFile}>
              <span className="sheet-option-label">
                {platform === "ios" ? `전체 ${items.length}건 — 다른 캘린더 앱 선택` : `전체 ${items.length}건을 파일(.ics)로 내보내기`}
                <small>{platform === "ios" ? "공유 창에서 설치된 캘린더 앱을 골라요" : "공유 창에서 캘린더 앱을 골라요"}</small>
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
