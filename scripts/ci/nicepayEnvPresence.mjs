#!/usr/bin/env node
/*
  NICEPAY 환경변수 "존재 여부"만 점검한다 — 값은 읽어서 판정에만 쓰고 어디에도 출력하지 않는다(MID·MerchantKey·토큰 시크릿 포함).
  사용: node scripts/ci/nicepayEnvPresence.mjs [--env-file <파일>]   (파일 없으면 현재 프로세스 환경변수. 예: `vercel env pull .env.check` 로 받은 파일을 넘기면 그 파일만 읽는다)
  출력: 이름 / present(yes|no) / 형식 메모(값 없음). 종료 코드: 0 = 필수 항목이 모두 존재, 1 = 누락 있음(결제 비활성 상태에서는 누락이 정상이다 — 활성화 직전 점검용).
  이 스크립트는 네트워크·파일 쓰기·결제 호출을 하지 않는다.
*/
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// v3(MID) 계열 활성화에 필요한 서버 환경변수(lib/payments/server/nicepay/config.ts 와 같은 목록). secret=true 는 값의 어떤 부분도 출력하지 않는다.
export const NICEPAY_V3_REQUIRED = [
  { name: "NICEPAY_CHECKOUT_ENABLED", secret: false, kind: "flag" },
  { name: "NICEPAY_API_FAMILY", secret: false, kind: "family" },
  { name: "NICEPAY_ENV", secret: false, kind: "env" },
  { name: "NICEPAY_RETURN_BASE_URL", secret: false, kind: "https-url" },
  { name: "PAYMENT_RETURN_TOKEN_SECRET", secret: true, kind: "secret" },
  { name: "NICEPAY_MID", secret: true, kind: "secret" },
  { name: "NICEPAY_MERCHANT_KEY", secret: true, kind: "secret" },
];
// 클라이언트 번들/게이트 관련(비밀 아님) — 일반 회원 결제 OFF 유지 여부를 함께 본다.
export const NICEPAY_RELATED_PUBLIC = ["NEXT_PUBLIC_PAYMENT_PROVIDER", "NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER"];

const present = (v) => typeof v === "string" && v.trim().length > 0;
function memo(item, v) {
  if (!present(v)) return "누락";
  switch (item.kind) {
    case "flag": return v === "true" ? "형식 OK(활성 값)" : "존재(활성 값 아님)";
    case "family": return v === "v3_mid" ? "형식 OK(v3_mid)" : v === "rest_v1" ? "존재(rest_v1 — v3 아님)" : "형식 오류";
    case "env": return v === "production" || v === "sandbox" ? `형식 OK(${v})` : "형식 오류";
    case "https-url": return /^https:\/\/[^/\s]+\/?$/.test(v.trim()) ? "형식 OK(https)" : "형식 확인 필요(https 호스트만)";
    default: return "존재(값 비공개)";
  }
}
/** 순수 함수: 값은 반환하지 않는다(이름·present·메모만). */
export function checkNicepayEnvPresence(env) {
  const required = NICEPAY_V3_REQUIRED.map((it) => ({ name: it.name, required: true, present: present(env[it.name]), memo: memo(it, env[it.name]) }));
  const related = NICEPAY_RELATED_PUBLIC.map((name) => ({ name, required: false, present: present(env[name]), memo: present(env[name]) ? (name === "NEXT_PUBLIC_PG_CHECKOUT_ENABLED" || name === "NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER" ? (env[name] === "true" ? "켜짐(true)" : "꺼짐(true 아님)") : (env[name] === "nicepay" ? "nicepay" : "nicepay 아님")) : "없음(기본값)" }));
  return { required, related, allRequiredPresent: required.every((r) => r.present) };
}
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--env-file");
  const env = i >= 0 ? parseEnvFile(fs.readFileSync(process.argv[i + 1], "utf8")) : process.env;
  const r = checkNicepayEnvPresence(env);
  const row = (x) => `${x.name.padEnd(44)} ${x.present ? "present" : "MISSING"}  ${x.memo}`;
  console.log("NICEPAY v3 필수 환경변수(값 비출력):"); r.required.forEach((x) => console.log("  " + row(x)));
  console.log("관련 공개 설정:"); r.related.forEach((x) => console.log("  " + row(x)));
  console.log(r.allRequiredPresent ? "→ 필수 항목 모두 존재" : "→ 누락 있음(결제 비활성 상태에서는 정상 — 활성화 직전에 모두 채워야 함)");
  process.exit(r.allRequiredPresent ? 0 : 1);
}
