/* NICEPAY 결제창 호출 파라미터 발급 — 로그인(Bearer) + 본인 주문 + pending + 게이트. 금액은 DB 주문 금액이다(요청의 금액은 받지 않는다). 설정 불완전/비활성이면 503. */
import { bearerToken, createAdminClient } from "../../../../../lib/payments/server/deps";
import { buildFlowDeps, getActiveNicepayConfig } from "../../../../../lib/payments/server/nicepay/runtime";
import { handlePrepare } from "../../../../../lib/payments/server/nicepay/flow";

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
  let body: { orderId?: unknown; orderName?: unknown };
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 올바르지 않아요" }, 400); }
  const r = await handlePrepare({ token: bearerToken(request), orderId: body.orderId, orderName: body.orderName }, s.deps);
  return json(r.body, r.status);
}
