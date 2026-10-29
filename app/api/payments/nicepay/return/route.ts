/* NICEPAY 결제창 인증 결과 수신(returnUrl POST) — 서버 승인 후 결과 화면으로 303. 이 경로에 도달한 것만으로는 어떤 상태도 "성공"이 아니다. 비활성이면 503(승인/취소 호출 없음). */
import { bearerToken, createAdminClient } from "../../../../../lib/payments/server/deps";
import { buildFlowDeps, getActiveNicepayConfig } from "../../../../../lib/payments/server/nicepay/runtime";
import { handleReturnPost } from "../../../../../lib/payments/server/nicepay/flow";
import { readNicepayForm } from "../../../../../lib/payments/server/nicepay/formBody";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

// 활성 조건(코드 상수 + NICEPAY_CHECKOUT_ENABLED + 계열/키/URL 설정)이 모두 맞지 않으면 어떤 NICEPAY 처리도 하지 않고 503으로 거부한다(fail-closed).
function setup() {
  const a = getActiveNicepayConfig();
  if (!a.active) return { error: json(a.body, a.status) } as const;
  const admin = createAdminClient();
  const secret = process.env.PAYMENT_RETURN_TOKEN_SECRET;
  if (!admin || !secret) return { error: json({ error: "결제 서버 설정이 없어요", code: "nicepay_not_active" }, 503) } as const;
  return { deps: buildFlowDeps(admin, a.config, secret) } as const;
}

export async function POST(request: Request) {
  const s = setup(); if ("error" in s) return s.error;
  const rt = new URL(request.url).searchParams.get("rt");
  const form: Record<string, unknown> = await readNicepayForm(request);   // EUC-KR/UTF-8 모두 처리(첫 값만 사용)
  const { location } = await handleReturnPost(form, rt, s.deps);
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
