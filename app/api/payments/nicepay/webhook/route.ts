/* NICEPAY 결제통보(웹훅) 수신 — 서명 검증 + 분류만, 주문/수강권 상태는 바꾸지 않는다. 문서 규격: 200 + text/html "OK". 비활성이면 503. */
import { bearerToken, createAdminClient } from "../../../../../lib/payments/server/deps";
import { buildFlowDeps, getActiveNicepayConfig } from "../../../../../lib/payments/server/nicepay/runtime";
import { handleWebhook } from "../../../../../lib/payments/server/nicepay/flow";

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
  let payload: Record<string, unknown>;
  try { payload = (await request.json()) as Record<string, unknown>; } catch { return new Response("FAIL", { status: 400, headers: { "Content-Type": "text/html;charset=utf-8" } }); }
  const r = await handleWebhook(payload && typeof payload === "object" ? payload : {}, s.deps);
  return new Response(r.text, { status: r.status, headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
}
