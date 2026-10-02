/*
  성능 배치(2026-10-02) 2: 이미지 lazy 정책 / viewport(키보드) burst 합치기 / 기존 gesture 최적화 보존 / reduced-motion.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

describe("이미지: 목록 썸네일은 lazy + async decode, 뷰어 활성 이미지는 즉시", () => {
  const thumbs: [string, string][] = [
    ["app/category/[label]/page.tsx", 'className="cat-center-photo"'], ["app/search/page.tsx", 'className="search-center-photo"'],
    ["app/profiles/page.tsx", 'className="profile-avatar-img"'], ["app/center/[id]/page.tsx", "reviewPhotoUrl(ph)"],
    ["app/manager/announcements/page.tsx", "announcementPhotoUrl(ph)"], ["app/components/InquiryChat.tsx", "inquiryPhotoUrl(ph)"],
    ["app/components/AlimtalkComposer.tsx", "b.url"], 
  ];
  for (const [f, marker] of thumbs) {
    it(`${f}: lazy + decoding async`, () => {
      const tags = [...read(f).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(marker));
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) { expect(tag).toContain('loading="lazy"'); expect(tag).toContain('decoding="async"'); }
    });
  }
  it("ImageViewer의 확대 가능 썸네일(ZoomImage)은 lazy + async", () => {
    const v = read("app/components/ImageViewer.tsx");
    const z = v.slice(v.indexOf("      className={className}"), v.indexOf('cursor: "zoom-in"'));
    expect(z).toContain('loading="lazy"');
    expect(z).toContain('decoding="async"');
  });
  it("이미지 뷰어의 현재 활성 이미지(image-viewer-img)와 로그인 애플 아이콘은 lazy가 아니다", () => {
    const v = read("app/components/ImageViewer.tsx");
    const active = v.slice(v.indexOf('className="image-viewer-img"') - 20, v.indexOf('className="image-viewer-img"') + 400);
    expect(active).not.toContain('loading="lazy"');
    expect(read("app/login/page.tsx").slice(read("app/login/page.tsx").indexOf("apple-signin.png") - 30, read("app/login/page.tsx").indexOf("apple-signin.png") + 80)).not.toContain("lazy");
  });
});

describe("visualViewport burst: rAF 합치기 + 값 동일 시 skip", () => {
  for (const f of ["app/components/BottomNav.tsx", "app/components/ManagerNav.tsx"]) {
    it(`${f}: requestAnimationFrame으로 합치고 같은 값이면 setState 생략, cleanup에서 cancel`, () => {
      const s = read(f);
      expect(s).toContain("requestAnimationFrame(apply)");
      expect(s).toContain("setKeyboardOpen((prev) => (prev === open ? prev : open))");
      expect(s).toContain("cancelAnimationFrame(raf)");
      expect(s).toContain("window.innerHeight - viewport.height > 140");   // 판정 기준은 그대로
    });
  }
  it("SheetOverlay: resize/scroll burst를 프레임당 1회 fit()으로 합치고 리스너를 정리", () => {
    const s = read("app/components/SheetOverlay.tsx");
    expect(s).toContain("scheduleFit");
    expect(s).toContain('viewport?.addEventListener("resize", scheduleFit)');
    expect(s).toContain('viewport?.removeEventListener("resize", scheduleFit)');
    expect(s).toContain("cancelAnimationFrame(fitRaf)");
  });
});

describe("기존 gesture 최적화/모션 계약 보존", () => {
  it("SwipeRow는 pointermove에서 React state 대신 DOM(CSS 변수)만 갱신, reduced-motion 존중", () => {
    const s = read("app/components/SwipeRow.tsx");
    expect(s).toContain('row.style.setProperty("--swipe-l"');
    expect(s).toContain("prefersReducedMotion()");
  });
  it("sheetDrag는 transform 기반 유지(top/left/height를 프레임마다 바꾸지 않음)", () => {
    const s = read("lib/sheetDrag.ts");
    expect(s).toMatch(/transform/);
    expect(s).not.toMatch(/style\.(top|left|height|width)\s*=/);
  });
  it("prefers-reduced-motion 규칙이 globals.css에 유지된다", () => {
    expect((read("app/globals.css").match(/prefers-reduced-motion/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
  it("로그인/네이티브: Google/Apple/FCM 플러그인 등록과 GoogleSignIn openURL 처리 보존", () => {
    const sd = read("ios/App/App/SceneDelegate.swift");
    for (const p of ["FcmTokenPlugin()", "AppleSignInPlugin()", "GoogleSignInPlugin()"]) expect(sd).toContain(p);
    expect(sd).toContain("GIDSignIn.sharedInstance.handle(context.url)");
  });
});
