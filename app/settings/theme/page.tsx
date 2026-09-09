"use client";

/*
  테마 설정
  - globals.css 에 정의된 테마(버건디/네이비/세이지/차콜) 중 선택
  - 선택을 localStorage("app_theme")에 저장하고 <html data-theme>에 반영
*/

import { useEffect, useState } from "react";

type Theme = "system" | "burgundy" | "charcoal";

const OPTIONS: { id: Theme; label: string; desc: string; swatch: string }[] = [
  { id: "system", label: "시스템 설정 따르기", desc: "기기 다크모드 설정에 맞춰 자동 전환", swatch: "linear-gradient(135deg, #0A2446 50%, #17181C 50%)" },
  { id: "burgundy", label: "기본 (라이트)", desc: "밝은 화면", swatch: "#0A2446" },
  { id: "charcoal", label: "다크 모드", desc: "어두운 화면", swatch: "#17181C" },
];

// layout.tsx의 하이드레이션 전 인라인 스크립트와 반드시 같은 판정을 내려야 한다(안 그러면
// 화면 전환마다 깜빡임) — "system"이거나 저장된 값이 없으면 OS 다크모드 설정을 따른다.
function resolveEffectiveTheme(theme: Theme): "burgundy" | "charcoal" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "charcoal" : "burgundy";
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", resolveEffectiveTheme(theme));
}

export default function ThemeSettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");

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
        {OPTIONS.map((o) => (
          <button key={o.id} className={`theme-option ${theme === o.id ? "on" : ""}`} onClick={() => choose(o.id)}>
            <span className="theme-swatch" style={{ background: o.swatch }} />
            <span className="theme-text">
              <span className="theme-label">{o.label}</span>
              <span className="theme-desc">{o.desc}</span>
            </span>
            <span className="theme-check">{theme === o.id ? "●" : "○"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
