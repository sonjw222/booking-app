import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/* 이용자 화면(app·lib·components)에 "심사용" 류 문구가 문자열/JSX 텍스트로 남지 않게 지킨다.
   주석(// , /* *​/ , {/* *​/})은 개발자용 기록이라 허용하고, 내부 식별자(is_nicepay_review, nicepay_review_access 등)는 문구가 아니므로 검사하지 않는다.
   실제 서비스가 없는 센터라는 사실을 숨기려는 테스트가 아니다 — 문구는 "테스트 센터/테스트 상품"처럼 사실대로 쓴다(SQL: fix_nicepay_review_wording_20261105.sql). */
const ROOT = join(__dirname, "../..");
const BANNED = /심사용|심사 전용|심사 안내|카드사 심사/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("이용자 화면에 노출되는 심사용 문구", () => {
  const files = ["app", "lib", "components"].flatMap((d) => { try { return walk(join(ROOT, d)); } catch { return []; } });

  it("코드 파일을 실제로 검사한다", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("주석을 제외한 문자열·JSX 텍스트에 '심사용/심사 전용/심사 안내/카드사 심사' 가 없다", () => {
    const hits: string[] = [];
    for (const f of files) {
      stripComments(readFileSync(f, "utf-8")).split("\n").forEach((line, i) => { if (BANNED.test(line)) hits.push(`${f.replace(ROOT + "/", "")}:${i + 1}: ${line.trim().slice(0, 100)}`); });
    }
    expect(hits).toEqual([]);
  });

  it("심사관에게만 보이는 홈 바로가기는 '수강권 및 결제 확인 센터' 로 표시한다", () => {
    const src = readFileSync(join(ROOT, "app/page.tsx"), "utf-8");
    expect(src).toContain("<h2>수강권 및 결제 확인 센터</h2>");
    expect(src).toContain("isNicepayReviewer && centers.length > 0");
  });
});
