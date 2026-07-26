"use client";

/*
  테마 설정
  - globals.css 에 정의된 테마(버건디/네이비/세이지/차콜) 중 선택
  - 선택을 localStorage("app_theme")에 저장하고 <html data-theme>에 반영
*/

import { useEffect, useState } from "react";
import BottomNav from "../../components/BottomNav";

type Theme = "burgundy" | "charcoal";

const OPTIONS: { id: Theme; label: string; desc: string; swatch: string }[] = [
  { id: "burgundy", label: "기본 (라이트)", desc: "밝은 화면", swatch: "#8B2F52" },
  { id: "charcoal", label: "다크 모드", desc: "어두운 화면", swatch: "#17181C" },
];

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export default function ThemeSettingsPage() {
  const [theme, setTheme] = useState<Theme>("burgundy");

  useEffect(() => {
    const saved = (localStorage.getItem("app_theme") as Theme) || "burgundy";
    setTheme(saved);
    applyTheme(saved);
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    localStorage.setItem("app_theme", t);
    applyTheme(t);
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
      <BottomNav />
    </div>
  );
}
