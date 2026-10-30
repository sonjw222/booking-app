/*
  NICEPAY 서버 설정 로딩 + 활성화 판정 — 이 파일만 process.env.NICEPAY_* 를 읽는다(정적 테스트가 강제). 키/MID는 어디에도 기록·반환하지 않는다(진단은 "무엇이 비었는지" 이름만).
  원칙(fail-closed): 아래 4가지가 모두 참일 때만 "활성"이다. 하나라도 거짓이면 모든 NICEPAY 결제 경로(결제 준비/인증 복귀/환불)는 요청 자체를 거부한다.
    1) 코드 상수 NICEPAY_CHECKOUT_ACTIVATED === true   (리뷰된 코드 변경으로만 켠다 — 환경변수로는 못 켠다)
    2) 서버 환경변수 NICEPAY_CHECKOUT_ENABLED === "true" (Toss 시절의 NEXT_PUBLIC_PG_CHECKOUT_ENABLED와 별개 — 서로를 켜거나 끄지 않는다)
    3) NICEPAY_API_FAMILY 가 명시적으로 "rest_v1" | "v3_mid" 중 하나 (계약에서 어떤 계열 키가 나올지 모르므로 추측하지 않는다)
    4) 해당 계열의 자격증명이 모두 존재하고 형식이 맞음(rest_v1: NICEPAY_CLIENT_ID/NICEPAY_SECRET_KEY, v3_mid: NICEPAY_MID/NICEPAY_MERCHANT_KEY) + NICEPAY_RETURN_BASE_URL(https)
  대상 노출 정책은 별도: 활성이어도 일반 회원에게는 PG_CHECKOUT_ENABLED==="true" 이거나 심사용 계정 override 일 때만 열린다(runtime.ts gateAllows) —
  심사 계정 override가 NICEPAY 비활성 상태를 우회하지는 못한다(위 4조건이 먼저).
*/
import { NICEPAY_CHECKOUT_ACTIVATED } from "../../PaymentProviderFactory";
import { evaluateQaAuthOnly } from "./qaAuthOnly";

export type NicepayFamily = "rest_v1" | "v3_mid";
export type NicepayEnvName = "sandbox" | "production";
export type NicepayConfig =
  | { family: "rest_v1"; clientId: string; secretKey: string; env: NicepayEnvName; apiBase: string; sdkUrl: string; returnBaseUrl: string }
  | { family: "v3_mid"; mid: string; merchantKey: string; env: NicepayEnvName; returnBaseUrl: string;
      /** 격리 QA 인증만(auth-only) 모드 — 승인·망취소·취소·환불 호출 차단(qaAuthOnly.ts). 공용 테스트 MID(nicepay00m)이거나 NICEPAY_QA_AUTH_ONLY=true 이면 항상 true. */
      qaAuthOnly?: true };

export type ConfigResult = { ok: true; config: NicepayConfig } | { ok: false; reason: "code_flag_off" | "disabled" | "incomplete" | "qa_unsafe"; missing: string[] };

export const REST_HOSTS = { production: { api: "https://api.nicepay.co.kr", sdk: "https://pay.nicepay.co.kr/v1/js/" }, sandbox: { api: "https://sandbox-api.nicepay.co.kr", sdk: "https://sandbox-pay.nicepay.co.kr/v1/js/" } } as const;

type Env = Record<string, string | undefined>;
const present = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

export function loadNicepayConfig(env: Env = process.env, opts: { codeFlag?: boolean } = {}): ConfigResult {
  if (!(opts.codeFlag ?? NICEPAY_CHECKOUT_ACTIVATED)) return { ok: false, reason: "code_flag_off", missing: [] };
  if (env.NICEPAY_CHECKOUT_ENABLED !== "true") return { ok: false, reason: "disabled", missing: [] };
  // QA 인증만 모드 안전 검사(운영 MID·운영 DB·운영 도메인·production 환경 차단). 어긋나면 NICEPAY 전체 비활성(fail-closed) — 문제 항목 "이름"만 돌려준다.
  const qa = evaluateQaAuthOnly(env);
  if (qa.requested && !qa.ok) return { ok: false, reason: "qa_unsafe", missing: qa.problems };
  const missing: string[] = [];
  const family = env.NICEPAY_API_FAMILY;
  if (family !== "rest_v1" && family !== "v3_mid") missing.push("NICEPAY_API_FAMILY");
  const envName: NicepayEnvName = env.NICEPAY_ENV === "production" ? "production" : "sandbox";
  if (env.NICEPAY_ENV !== "production" && env.NICEPAY_ENV !== "sandbox") missing.push("NICEPAY_ENV");
  // 복귀 주소는 https 만 허용한다. 예외: 로컬 개발·격리 브라우저 QA 용 http://localhost[:port] — sandbox 환경에서만(production 에서는 localhost 도 거부).
  const baseOk = (v: string) => /^https:\/\/[^/\s]+$/.test(v) || (envName === "sandbox" && /^http:\/\/localhost(:\d{2,5})?$/.test(v));
  if (!present(env.NICEPAY_RETURN_BASE_URL) || !baseOk(env.NICEPAY_RETURN_BASE_URL!.trim().replace(/\/+$/, ""))) missing.push("NICEPAY_RETURN_BASE_URL");
  if (!present(env.PAYMENT_RETURN_TOKEN_SECRET)) missing.push("PAYMENT_RETURN_TOKEN_SECRET");
  if (family === "rest_v1") { if (!present(env.NICEPAY_CLIENT_ID)) missing.push("NICEPAY_CLIENT_ID"); if (!present(env.NICEPAY_SECRET_KEY)) missing.push("NICEPAY_SECRET_KEY"); }
  if (family === "v3_mid") { if (!present(env.NICEPAY_MID)) missing.push("NICEPAY_MID"); if (!present(env.NICEPAY_MERCHANT_KEY)) missing.push("NICEPAY_MERCHANT_KEY"); }
  if (missing.length) return { ok: false, reason: "incomplete", missing };
  const returnBaseUrl = env.NICEPAY_RETURN_BASE_URL!.trim().replace(/\/+$/, "");
  if (family === "rest_v1") {
    const h = REST_HOSTS[envName];
    return { ok: true, config: { family, clientId: env.NICEPAY_CLIENT_ID!.trim(), secretKey: env.NICEPAY_SECRET_KEY!.trim(), env: envName, apiBase: h.api, sdkUrl: h.sdk, returnBaseUrl } };
  }
  return { ok: true, config: { family: "v3_mid", mid: env.NICEPAY_MID!.trim(), merchantKey: env.NICEPAY_MERCHANT_KEY!.trim(), env: envName, returnBaseUrl, ...(qa.requested ? { qaAuthOnly: true as const } : {}) } };
}

/** 응답/로그에 내려도 되는 설정 상태(값 없음) */
export function describeConfig(r: ConfigResult): { active: boolean; reason?: string; missing?: string[] } {
  return r.ok ? { active: true } : { active: false, reason: r.reason, missing: r.missing };
}
