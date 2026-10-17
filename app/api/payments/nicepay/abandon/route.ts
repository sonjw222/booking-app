/* 승인 전(pending) NICEPAY 주문 취소 — 결제창을 닫았거나 복귀에 실패한 경우. 승인 진행 중(approving)이면 거부한다. */
import { bearerToken, createAdminClient } from "../../../../../lib/payments/server/deps";
import { buildFlowDeps, getActiveNicepayConfig } from "../../../../../lib/payments/server/nicepay/runtime";
import { handleAbandon } from "../../../../../lib/payments/server/nicepay/flow";

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
  let body: { orderId?: unknown; returnToken?: unknown };
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 올바르지 않아요" }, 400); }
  const r = await handleAbandon({ token: bearerToken(request), returnToken: body.returnToken, orderId: body.orderId }, s.deps);
  return json(r.body, r.status);
}
