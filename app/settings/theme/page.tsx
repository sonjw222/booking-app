"use client";

/*
  테마 설정
  - globals.css 에 정의된 테마(버건디/네이비/세이지/차콜) 중 선택
  - 선택을 localStorage("app_theme")에 저장하고 <html data-theme>에 반영
*/

import { useEffect, useState } from "react";
import { syncNativeWebViewBackground, syncNativeStatusBarStyle } from "../../../lib/nativeTheme";

type Theme = "system" | "burgundy" | "charcoal";
type PreviewMode = "light" | "dark";

const OPTIONS: { id: Theme; label: string; desc: string }[] = [
  { id: "system", label: "시스템 설정 따르기", desc: "기기 다크모드 설정에 맞춰 자동 전환" },
  { id: "burgundy", label: "기본 (라이트)", desc: "밝은 화면" },
  { id: "charcoal", label: "다크 모드", desc: "어두운 화면" },
];

// 릴리스 폴리시 배치 8차(2026-09-17) — 미리보기 색상 버그 수정(13번).
// 감사 결과: 기존엔 세 옵션 카드가 전부 `.theme-option { background: var(--bg) }`를 그대로
// 썼다 — var(--bg)는 "지금 실제로 적용된" 테마(대개 시스템 설정을 따름)를 따라가는 전역
// 변수라, 시스템이 다크면 "기본(라이트)" 카드까지 어두운 배경으로 보였다(요구사항 B에서
// 지적된 바로 그 증상) — 미리보기가 "지금 적용된 테마"에 오염된 것. "시스템 설정 따르기"
// 스와치도 실제 OS 상태와 무관한 고정 반반(half/half) 그라데이션이라 라이트/다크 어느
// 쪽인지 실제로 알려주지 않았다(요구사항 A).
// 수정: 각 옵션 카드를 "그 옵션이 실제로 뜻하는 결과 테마"의 고정 색으로 직접 그린다(전역
// var(--bg)를 참조하지 않음 — 그래서 지금 앱에 적용된 테마와 완전히 독립적) — "기본(라이트)"
// 은 시스템이 뭐든 항상 라이트, "다크 모드"는 항상 다크, "시스템 설정 따르기"만 아래
// resolveThemePreviewMode()로 실제 OS 설정을 읽어 그 결과를 그린다.
export function resolveThemePreviewMode(id: Theme, systemDark: boolean): PreviewMode {
  if (id === "system") return systemDark ? "dark" : "light";
  return id === "charcoal" ? "dark" : "light";
}

// app/globals.css :root/[data-theme="charcoal"]의 실제 토큰 값과 동일(라이트=기본 :root,
// 다크=charcoal) — 미리보기가 실제 화면 색과 어긋나지 않도록 그대로 가져다 쓴다.
const PREVIEW_TOKENS: Record<PreviewMode, { bg: string; ink: string; line: string; accent: string; swatch: string }> = {
  light: { bg: "#FBFBFA", ink: "#171719", line: "#DEDEDA", accent: "#0A2446", swatch: "#0A2446" },
  dark: { bg: "#17181C", ink: "#F5F5F7", line: "#34353C", accent: "#3E7BC4", swatch: "#17181C" },
};

// layout.tsx의 하이드레이션 전 인라인 스크립트와 반드시 같은 판정을 내려야 한다(안 그러면
// 화면 전환마다 깜빡임) — "system"이거나 저장된 값이 없으면 OS 다크모드 설정을 따른다.
function resolveEffectiveTheme(theme: Theme): "burgundy" | "charcoal" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "charcoal" : "burgundy";
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  const effective = resolveEffectiveTheme(theme);
  document.documentElement.setAttribute("data-theme", effective);
  // iOS 오버스크롤 배경도 같이 맞춘다(lib/nativeTheme.ts 주석 참고) — 앱을 켜둔 채 여기서
  // 테마를 바꾸는 경우(콜드 스타트는 app/layout.tsx의 인라인 스크립트가 이미 처리)까지
  // 반영해야 다음 화면 전환 때 오버스크롤 색이 즉시 새 테마와 맞는다.
  syncNativeWebViewBackground(effective === "charcoal");
  // 상태바 아이콘 색(iOS/Android 공통, 7차 배치 신규 — lib/nativeTheme.ts 주석 참고)도
  // 같이 맞춘다 — 안 그러면 시스템은 라이트인데 앱 안에서 차콜을 고른 경우 어두운
  // 배경에 어두운 아이콘이 남아 거의 안 보이게 된다.
  void syncNativeStatusBarStyle(effective === "charcoal");
}

export default function ThemeSettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  // "지금 실제 OS가 다크모드인지" — 미리보기 전용 상태다(앱에 실제 적용되는 테마 로직인
  // applyTheme()/resolveEffectiveTheme()와는 별개, 13번 요구사항: preview가 현재 시스템
  // 테마에 오염되면 안 되는 다른 두 옵션과 달리, "시스템 설정 따르기" 옵션의 preview만은
  // 반대로 이 값을 실시간으로 따라가야 한다).
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const saved = (localStorage.getItem("app_theme") as Theme) || "system";
    setTheme(saved);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    // 설정 화면을 보고 있는 동안 OS 다크모드를 바꾸면 바로 반영
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // 위 effect와 별개로 항상 구독한다 — 지금 고른 테마가 "system"이 아니어도(예: 다크
  // 모드를 명시적으로 골라둔 상태) "시스템 설정 따르기" 옵션의 미리보기 스와치는 실제
  // OS 설정이 바뀌면 그 즉시 갱신돼야 한다.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    localStorage.setItem("app_theme", t);
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">테마 설정</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "8px 20px" }}>
        원하는 색 테마를 골라주세요. 선택은 이 기기에 저장돼요.
      </div>

      <div className="theme-options">
        {OPTIONS.map((o) => {
          const mode = resolveThemePreviewMode(o.id, systemDark);
          const t = PREVIEW_TOKENS[mode];
          const on = theme === o.id;
          return (
            <button
              key={o.id}
              className={`theme-option ${on ? "on" : ""}`}
              onClick={() => choose(o.id)}
              style={{ background: t.bg, borderColor: on ? t.accent : t.line }}
            >
              <span className="theme-swatch" style={{ background: t.swatch }} />
              <span className="theme-text">
                <span className="theme-label" style={{ color: t.ink }}>{o.label}</span>
                <span className="theme-desc" style={{ color: t.ink, opacity: 0.62 }}>{o.desc}</span>
              </span>
              <span className="theme-check" style={{ color: on ? t.accent : t.ink, opacity: on ? 1 : 0.55 }}>{on ? "●" : "○"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
