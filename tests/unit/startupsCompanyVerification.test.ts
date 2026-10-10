// Claude Startups 기업 검증 개선 — 공개 문의 이메일 단일 출처, /about 서버 렌더링, 사업자 정보 브랜드 표기,
// robots/sitemap/메타데이터, 색인 방지 헤더. 법적 사업자 정보(상호/대표자/등록번호/주소/신고번호)는 바뀌지 않았음을 함께 고정한다.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, n); const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out); else if (/\.(ts|tsx)$/.test(n)) out.push(rel);
  }
  return out;
}

describe("공개 문의 이메일 — 단일 출처 BUSINESS_INFO.email", () => {
  it("공개 이메일은 contact@mwhabit.com이고 신청·관리용 계정/개인 이메일은 앱 코드에 없다", async () => {
    const { BUSINESS_INFO } = await import("../../lib/businessInfo");
    expect(BUSINESS_INFO.email).toBe("contact@mwhabit.com");
    for (const f of [...walk("app"), ...walk("lib"), ...walk("supabase/functions")]) {
      const s = read(f);
      expect(s, `${f}: 개인/신청용 이메일`).not.toMatch(/sonjw222@(naver|mwhabit)\.|@naver\.com/);
    }
  });
  it("계정 삭제 안내는 하드코딩 대신 BUSINESS_INFO.email을 쓴다(삭제 요청 이메일 유지)", () => {
    const s = read("app/account-deletion/page.tsx");
    expect(s).toContain('import { BUSINESS_INFO } from "../../lib/businessInfo"');
    expect(s.match(/\{BUSINESS_INFO\.email\}/g)?.length).toBe(2);
    expect(s).not.toContain("contact@mwhabit.com");
  });
  it("법적 사업자 정보는 변경되지 않았다(상호/대표자/등록번호/주소/통신판매업/고객센터)", async () => {
    const { BUSINESS_INFO: b } = await import("../../lib/businessInfo");
    expect([b.companyName, b.serviceName, b.ceoName, b.businessRegNo, b.mailOrderRegNo, b.address, b.customerServicePhone])
      .toEqual(["모하빗", "모하빗", "손장욱", "589-77-00451", "제2026-성남분당B-0866호", "경기도 성남시 분당구 중앙공원로 20, 420동 702호", "010-6505-8700"]);
    expect(b.brandNameEn).toBe("MWHABIT");
  });
  it("홈 푸터는 이메일/주소를 새로 노출하지 않는다(기존 정책 유지)", () => {
    const home = read("app/page.tsx");
    expect(home).not.toContain("BUSINESS_INFO.email");
    expect(home).not.toContain("BUSINESS_INFO.address");
  });
});

describe("/legal/business — 상호와 영문 브랜드의 관계", () => {
  it("상호 옆에 서비스 브랜드 MWHABIT을 표기하고 별도 법인명/등록 상호를 만들지 않는다", () => {
    const s = read("app/legal/business/page.tsx");
    expect(s).toContain("{BUSINESS_INFO.companyName} (서비스 브랜드: {BUSINESS_INFO.brandNameEn})");
    expect(s).toContain("{BUSINESS_INFO.serviceName} ({BUSINESS_INFO.brandNameEn})");
    expect(s).not.toMatch(/Co\.|Inc\.\s*\(|Ltd|주식회사|법인명/);   // 호스팅 표기(Vercel Inc./Supabase Inc.)와 구분: 상호 영역에 법인 표현 없음
    expect(s).toContain('canonical: "/legal/business"');
  });
});

describe("/about — 서버 렌더링 회사·서비스 소개", () => {
  it("서버 HTML에 서비스 소개·운영 주체·영문 소개·링크가 있고 사업자 개인정보는 중복 노출하지 않는다", async () => {
    const { default: AboutPage } = await import("../../app/about/page");
    const html = renderToStaticMarkup(createElement(AboutPage));
    expect(html).toContain("모하빗");
    expect(html).toContain("MWHABIT");
    expect(html).toContain("스포츠·취미 클래스");
    expect(html).toContain("contact@mwhabit.com");
    expect(html).toContain('href="/legal/business"');
    expect(html).toContain("About (English)");
    expect(html).toMatch(/service brand name of the Korean business registered as/);
    expect(html).toContain("https://apps.apple.com/kr/app/");
    // 사업자 상세는 /legal/business에서만
    for (const v of ["589-77-00451", "손장욱", "중앙공원로", "010-6505-8700", "제2026-성남분당B-0866호"]) expect(html, v).not.toContain(v);
    // 확인되지 않은 것은 홍보하지 않는다
    expect(html).not.toMatch(/Google Play|play\.google\.com|투자|펀딩|funding|raised|AI 기반|Claude/);
  });
  it("메타데이터: 고유 title/description/canonical/OG", async () => {
    const { metadata } = await import("../../app/about/page");
    expect(metadata.title).toBe("회사·서비스 소개");
    expect(String(metadata.description)).toContain("모하빗(MWHABIT)");
    expect(metadata.alternates?.canonical).toBe("/about");
    expect((metadata.openGraph as { url?: string } | undefined)?.url).toBe("/about");
  });
  it("JSON-LD는 확인된 사실(이름/영문명/URL/이메일/App Store)만 포함한다", async () => {
    const { default: AboutPage } = await import("../../app/about/page");
    const html = renderToStaticMarkup(createElement(AboutPage));
    const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "";
    const ld = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(ld).toEqual({
      "@context": "https://schema.org", "@type": "Organization", name: "모하빗", alternateName: "MWHABIT", url: "https://mwhabit.com",
      email: "contact@mwhabit.com", sameAs: ["https://apps.apple.com/kr/app/%EB%AA%A8%ED%95%98%EB%B9%97/id6811008551"],
    });
  });
});

describe("공개 스토어 링크 — 확인된 것만", () => {
  it("App Store는 확인된 등록 URL, Google Play는 공개 확인 전까지 null", async () => {
    const { STORE_LINKS } = await import("../../lib/siteMeta");
    expect(STORE_LINKS.appStore).toMatch(/^https:\/\/apps\.apple\.com\/kr\/app\/.+\/id6811008551$/);
    expect(STORE_LINKS.googlePlay).toBeNull();
  });
});

describe("robots / sitemap / 메타데이터", () => {
  it("robots.txt: 공개 허용, 비공개 경로를 세그먼트 단위로 disallow(중복 없음), sitemap 위치 선언", async () => {
    const { default: robots } = await import("../../app/robots");
    const r = robots();
    const rule = (Array.isArray(r.rules) ? r.rules[0] : r.rules) as { allow?: string; disallow?: string[] };
    expect(rule.allow).toBe("/");
    for (const p of ["/manager", "/admin", "/mypage", "/checkout", "/login", "/api", "/reservation", "/my-reservations"]) {
      for (const f of [`${p}$`, `${p}/`, `${p}?`]) expect(rule.disallow, f).toContain(f);
    }
    expect(new Set(rule.disallow).size).toBe(rule.disallow?.length);   // 중복 항목 없음
    expect(r.sitemap).toBe("https://mwhabit.com/sitemap.xml");
  });
  it("robots 매칭(RFC 9309 최장 일치): /reservation 및 하위·쿼리는 차단, /reservation-guide 등 무관한 경로와 공개 경로는 허용", async () => {
    const { default: robots } = await import("../../app/robots");
    const rule = (Array.isArray(robots().rules) ? robots().rules[0] : robots().rules) as { allow?: string; disallow?: string[] };
    // `$`로 끝나는 패턴은 정확히 일치, 아니면 접두사 일치. 더 긴 패턴이 이기고 길이가 같으면 allow가 이긴다.
    const matches = (pat: string, path: string) => (pat.endsWith("$") ? path === pat.slice(0, -1) : path.startsWith(pat));
    const blocked = (path: string) => {
      const d = Math.max(-1, ...(rule.disallow ?? []).filter((p) => matches(p, path)).map((p) => p.length));
      const a = matches(rule.allow ?? "", path) ? (rule.allow ?? "").length : -1;
      return d > a;
    };
    for (const path of ["/reservation", "/reservation/", "/reservation/2026-10-11", "/reservation?date=2026-10-11", "/my-reservations", "/my-reservations/abc", "/manager", "/manager/classes", "/admin/centers", "/mypage/info", "/checkout/success", "/login", "/login/kakao-callback", "/api/billing/confirm", "/settings/theme", "/cart"]) {
      expect(blocked(path), `차단돼야 함: ${path}`).toBe(true);
    }
    for (const path of ["/reservation-guide", "/reservations", "/reservationx", "/managerial", "/administration", "/cartoon", "/loginx", "/apix", "/", "/about", "/legal", "/legal/business", "/account-deletion", "/search", "/products", "/category/yoga", "/center/abc"]) {
      expect(blocked(path), `허용돼야 함: ${path}`).toBe(false);
    }
  });
  it("sitemap: 공개 정적 페이지만(모두 실제 존재하는 라우트), 비공개·동적 경로 없음, https://mwhabit.com 기준", async () => {
    const { default: sitemap } = await import("../../app/sitemap");
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual(expect.arrayContaining(["https://mwhabit.com/", "https://mwhabit.com/about", "https://mwhabit.com/legal/business", "https://mwhabit.com/account-deletion"]));
    for (const u of urls) {
      expect(u.startsWith("https://mwhabit.com")).toBe(true);
      expect(u).not.toMatch(/\/(manager|admin|mypage|checkout|cart|login|api|center\/|my-reservations|purchases|inquiries|reset-password)/);
      const path = u.replace("https://mwhabit.com", "") || "/";
      const file = path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
      expect(existsSync(join(ROOT, file)), `${u} → ${file}`).toBe(true);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
  it("루트 레이아웃: metadataBase, title 템플릿, OG 사이트명(영문 병기), 페이지별 canonical 기본값", () => {
    const s = read("app/layout.tsx");
    expect(s).toContain("metadataBase: new URL(SITE_URL)");
    expect(s).toContain('template: "%s | 모하빗"');
    expect(s).toContain('siteName: "모하빗 (MWHABIT)"');
    expect(s).toContain('canonical: "./"');
    expect(s).toContain("viewportFit");   // 기존 viewport 설정 유지
  });
  it("법적 고지·계정삭제 페이지는 고유 title/description/canonical을 가진다", () => {
    for (const [f, c] of [["app/legal/page.tsx", "/legal"], ["app/legal/terms/page.tsx", "/legal/terms"], ["app/legal/privacy/page.tsx", "/legal/privacy"], ["app/legal/refund/page.tsx", "/legal/refund"], ["app/legal/business/page.tsx", "/legal/business"], ["app/account-deletion/page.tsx", "/account-deletion"]] as const) {
      const s = read(f);
      expect(s, f).toMatch(/export const metadata: Metadata/);
      expect(s, f).toContain(`canonical: "${c}"`);
    }
  });
});

describe("색인 방지 — 비공개 경로에 X-Robots-Tag: noindex", () => {
  it("next.config headers: 관리자·개인·결제·로그인·API는 noindex, 기존 Referrer-Policy 설정 유지", async () => {
    const cfg = (await import("../../next.config")).default;
    const rules = await (cfg.headers as () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>)();
    const noindex = (src: string) => rules.some((r) => r.source === src && r.headers.some((h) => h.key === "X-Robots-Tag" && /noindex/.test(h.value)));
    for (const p of ["/manager", "/manager/:path*", "/admin", "/admin/:path*", "/mypage/:path*", "/checkout/:path*", "/login", "/api/:path*", "/reservation", "/reservation/:path*", "/my-reservations", "/my-reservations/:path*"]) expect(noindex(p), p).toBe(true);
    for (const p of ["/about", "/legal", "/legal/:path*", "/account-deletion", "/", "/search", "/reservation-guide"]) expect(noindex(p), `공개 경로 ${p}는 noindex 아님`).toBe(false);
    expect(rules.some((r) => r.source === "/checkout/success" && r.headers.some((h) => h.key === "Referrer-Policy" && h.value === "no-referrer"))).toBe(true);
  });
});
