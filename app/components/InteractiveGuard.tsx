"use client";

/*
  네이티브 앱(Capacitor) 전용 — 탭하는 UI(링크/버튼/탭/네비게이션 항목)를 길게 누를 때 나오는 브라우저
  기본 동작(컨텍스트 메뉴, 링크 드래그 미리보기)을 막는다(2026-09-26 실기기 QA).
  텍스트 선택/callout 자체는 CSS(app/globals.css의 "iOS 길게 누르기" 블록: -webkit-touch-callout /
  user-select)가 담당하고, 여기서는 그래도 발생하는 두 이벤트만 최소 범위로 처리한다:
    · contextmenu — Android WebView의 링크 길게 누르기 메뉴 등
    · dragstart   — 링크/이미지 드래그 시작(드래그 고스트/미리보기)
  document 전체의 드래그/컨텍스트 메뉴를 막지 않는다 — input/textarea/contenteditable, 일반 본문
  텍스트는 그대로 동작한다. 웹 브라우저(데스크톱 우클릭 "새 탭에서 열기" 등)에는 적용하지 않는다.
  action은 pointerdown이 아니라 release(click)에서 1회만 실행된다 — 여기서는 어떤 클릭도 만들지/막지 않음.
*/
import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

const INTERACTIVE = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="option"], [role="menuitem"]';
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** 사용자가 "탭하는 UI" 안(입력창/편집 영역 제외)의 요소인지 — 순수 함수(단위 테스트 대상). */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE)) return false;
  return target.closest(INTERACTIVE) !== null;
}

export default function InteractiveGuard() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const onContextMenu = (e: Event) => { if (isInteractiveTarget(e.target)) e.preventDefault(); };
    const onDragStart = (e: Event) => { if (isInteractiveTarget(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("dragstart", onDragStart);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("dragstart", onDragStart);
    };
  }, []);
  return null;
}
