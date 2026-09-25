"use client";

/*
  "캘린더에 추가" 선택 시트 — 회원 예약 캘린더 / 관리자 수업 화면 공용(2026-09-26).
  기존 공용 시트 패턴(.sheet / .sheet-title + .sheet-close-btn / .sheet-option 행)을 그대로 재사용한다.

  mode="select"(상단 "내 캘린더에 추가"): 현재 표시 중인 달의 일정을 체크박스 목록으로 보여준다.
    · 전체 선택 / 전체 해제, 선택 개수 표시, 0개면 CTA 비활성
    · [선택한 N개 기본 캘린더에 추가] — 사용자가 이 버튼을 눌러야만 저장/시스템 화면이 열린다
    · [다른 캘린더 앱 선택] — 앱에서만(iOS: Open In → Share Sheet, Android: chooser)
    · 웹: 시스템 캘린더 연결이 없으므로 CTA 하나 [선택한 N개 .ics 파일로 내보내기]
  mode="single"(카드의 "캘린더에 추가"): 체크박스 없이 [기본 캘린더에 추가] [다른 캘린더 앱 선택].
  성공 문구는 실제로 확인된 결과(iOS 저장 개수)에만 표시 — 실패/부분 실패를 성공처럼 보이지 않는다.
*/
import { useMemo, useState } from "react";
import UiIcon from "./UiIcon";
import {
  addCalendarEvents, isCalendarAddBusy,
  type CalendarAddMode, type CalendarAddResult, type CalendarPlatform,
} from "../../lib/calendarAdd";
import { pickSelected, selectAll, selectNone, toggleSelection, type CalendarEventItem } from "../../lib/calendarEvents";

const KIND_LABEL: Record<CalendarEventItem["kind"], string> = { reservation: "예약", class: "수업", holiday: "휴무일" };

function dateLabel(dateKey: string): string {
  return dateKey.slice(5).replace("-", "."); // "2026-09-05" → "09.05"
}

export default function CalendarAddSheet({ items, subtitle, mode = "select", platform, onClose, onDone, onError }: {
  items: CalendarEventItem[];
  subtitle?: string;
  mode?: "select" | "single";
  platform: CalendarPlatform;
  onClose: () => void;
  onDone: (result: CalendarAddResult) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(selectNone());
  const picked = useMemo(() => pickSelected(items, selected), [items, selected]);
  const showKind = useMemo(() => new Set(items.map((i) => i.kind)).size > 1 || items.some((i) => i.kind !== "reservation"), [items]);

  async function run(target: CalendarEventItem[], how: CalendarAddMode) {
    if (busy || isCalendarAddBusy() || target.length === 0) return; // 컴포넌트 + 모듈 in-flight 이중 잠금
    setBusy(true);
    try {
      const res = await addCalendarEvents(target, how, platform);
      onDone(res);
      if (res.kind !== "cancelled") onClose(); // 취소했으면 시트를 남겨 다른 방법을 고를 수 있게
    } catch (e) {
      onError(e instanceof Error ? e.message : "캘린더에 추가하지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  const native = platform !== "web";

  return (
    <div className="sheet-overlay" onClick={busy ? undefined : onClose}>
      <div className="sheet calendar-add-sheet" role="dialog" aria-modal="true" aria-label="캘린더에 추가" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          캘린더에 추가
          <button type="button" className="sheet-close-btn" aria-label="닫기" onClick={onClose}>
            <UiIcon name="close" size={20} />
          </button>
        </div>

        {mode === "single" && items[0] ? (
          <>
            <div className="calendar-add-summary">
              <b>{items[0].timeLabel} · {items[0].title}</b>
              <span>{items[0].centerName}</span>
            </div>
            <button type="button" className="sheet-option" disabled={busy} onClick={() => run([items[0]], "default")}>
              <span className="sheet-option-label">
                기본 캘린더에 추가
                <small>{platform === "ios" ? "일정 추가 화면에서 저장을 눌러 확정해요" : platform === "android" ? "캘린더 앱의 일정 추가 화면이 열려요" : ".ics 파일로 내보내요"}</small>
              </span>
            </button>
            {native && (
              <button type="button" className="sheet-option" disabled={busy} onClick={() => run([items[0]], "chooser")}>
                <span className="sheet-option-label">
                  다른 캘린더 앱 선택
                  <small>{platform === "ios" ? "이 파일을 열 수 있는 설치된 앱을 골라요" : "설치된 캘린더 앱 중에서 골라요"}</small>
                </span>
              </button>
            )}
          </>
        ) : (
          <>
            {subtitle && <div className="calendar-add-summary"><span>{subtitle}</span></div>}
            {items.length === 0 ? (
              <div className="calendar-add-empty">이 달에는 추가할 일정이 없어요</div>
            ) : (
              <>
                <div className="calendar-add-controls">
                  <button type="button" className="calendar-add-link" disabled={busy || selected.size === items.length} onClick={() => setSelected(selectAll(items))}>전체 선택</button>
                  <button type="button" className="calendar-add-link" disabled={busy || selected.size === 0} onClick={() => setSelected(selectNone())}>전체 해제</button>
                  <span className="calendar-add-count" aria-live="polite">{selected.size} / {items.length}</span>
                </div>
                <div className="calendar-add-list" role="list">
                  {items.map((e) => (
                    <label key={e.id} role="listitem" className={`calendar-add-item ${selected.has(e.id) ? "on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        disabled={busy}
                        onChange={() => setSelected((cur) => toggleSelection(cur, e.id))}
                      />
                      <span className="calendar-add-item-main">
                        <b>
                          {showKind && <em className={`calendar-add-kind ${e.kind}`}>{KIND_LABEL[e.kind]}</em>}
                          {dateLabel(e.dateKey)} {e.timeLabel}
                        </b>
                        <span>{e.title}</span>
                        {e.centerName && !e.title.includes(e.centerName) && <small>{e.centerName}</small>}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="calendar-add-footer">
                  <button type="button" className="primary-btn calendar-add-cta" disabled={busy || picked.length === 0} onClick={() => run(picked, "default")}>
                    {platform === "web"
                      ? (picked.length > 0 ? `선택한 ${picked.length}개 .ics 파일로 내보내기` : "일정을 선택해주세요")
                      : (picked.length > 0 ? `선택한 ${picked.length}개 기본 캘린더에 추가` : "일정을 선택해주세요")}
                  </button>
                  {native && (
                    <button type="button" className="ghost-btn calendar-add-other" disabled={busy || picked.length === 0} onClick={() => run(picked, "chooser")}>
                      다른 캘린더 앱 선택
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
