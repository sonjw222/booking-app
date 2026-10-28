// send-alimtalk 호출자 권한 판정과 즉시 발송 경로(순수, Deno/네트워크 의존 없음 — 의존성은 deps 로 주입해 vitest 에서 직접 테스트한다).
//
// 배경(관리자 QA #239): 예전에는 "대상 센터의 활성 매니저인가"만 확인해서, 메뉴(message.alimtalk.view)만 가려 둔 직원이 함수를 직접 호출해 유료 발송을 할 수 있었다.
// 규칙(순서 중요, 하나라도 못 넘으면 발송 제공자(sendViaAligo/알리고 프록시)는 한 번도 호출되지 않는다):
//   1) Authorization 헤더 없음 → 401
//   2) service_role 키 → 통과(dispatch-alimtalk cron 같은 신뢰된 내부 호출)
//   3) 사용자 JWT 검증 실패(만료·위조) → 401   ※ 401 은 "유효한 로그인이 아님"이고, 로그인은 유효하지만 권한이 없는 경우(403)와 다르다
//   4) 계정 없음 → 403, 플랫폼 운영자 → 통과
//   5) 대상 센터의 활성 매니저가 아님 → 403
//   6) 호출자 본인 JWT 로 message.alimtalk.view 권한 조회 — 권한 없음 → 403, 조회 오류(예외·null) → 500(fail-closed)

export const ALIMTALK_PERMISSION = "message.alimtalk.view";

export interface AuthzDeps {
  serviceRoleKey: string;
  /** JWT 를 검증해 사용자 id 를 돌려준다. 유효하지 않으면 null. */
  getUserId(authHeader: string): Promise<string | null>;
  resolveAccount(userId: string): Promise<{ id: string; is_platform_admin: boolean } | null>;
  isActiveManager(accountId: string, centerId: string): Promise<boolean>;
  /** 호출자 본인 JWT 로 has_permission 을 조회한다. 조회 오류면 null(또는 throw). */
  hasPermission(authHeader: string, centerId: string, permissionKey: string): Promise<boolean | null>;
}

export type AuthzResult =
  | { ok: true; via: "service_role" | "platform_admin" | "permission" }
  | { ok: false; status: 401 | 403 | 500; message: string };

export async function authorizeAlimtalkCaller(deps: AuthzDeps, authHeader: string | null, centerId: string): Promise<AuthzResult> {
  if (!authHeader) return { ok: false, status: 401, message: "로그인이 필요해요" };
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token === deps.serviceRoleKey) return { ok: true, via: "service_role" };
  const userId = await deps.getUserId(authHeader);
  if (!userId) return { ok: false, status: 401, message: "로그인이 유효하지 않아요" };
  const account = await deps.resolveAccount(userId);
  if (!account) return { ok: false, status: 403, message: "이 센터에 대한 권한이 없어요" };
  if (account.is_platform_admin) return { ok: true, via: "platform_admin" };
  if (!centerId || !(await deps.isActiveManager(account.id, centerId))) return { ok: false, status: 403, message: "이 센터에 대한 권한이 없어요" };
  let allowed: boolean | null;
  try { allowed = await deps.hasPermission(authHeader, centerId, ALIMTALK_PERMISSION); } catch { allowed = null; }
  if (allowed === null) return { ok: false, status: 500, message: "권한을 확인하지 못했어요. 잠시 후 다시 시도해 주세요" };
  if (allowed !== true) return { ok: false, status: 403, message: "알림톡을 보낼 권한이 없어요" };
  return { ok: true, via: "permission" };
}

export type ImmediateSendBody = { to?: string; content?: string; centerId?: string; templateCode?: string; templateVariables?: Record<string, string> };
export interface ImmediateSendDeps {
  authz: AuthzDeps;
  isAddonEnabled(centerId: string): Promise<boolean>;
  /** 외부 발송 제공자(알리고 프록시). 권한 검사·애드온 확인을 모두 통과한 뒤에만 호출된다. */
  send(input: { to: string; content: string; templateCode?: string; templateVariables?: Record<string, string> }): Promise<{ status: "sent" | "failed"; message?: string }>;
}

/** 경로 1(매니저 화면 즉시 발송) — { status, body } 를 돌려준다. */
export async function handleImmediateSend(deps: ImmediateSendDeps, body: ImmediateSendBody, authHeader: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!body.to || !body.content || !body.centerId) return { status: 400, body: { error: "to, content, centerId가 필요해요" } };
  const a = await authorizeAlimtalkCaller(deps.authz, authHeader, body.centerId);
  if (!a.ok) return { status: a.status, body: { error: a.message } };
  // 알림톡 애드온 미신청 센터는 SMS 대체발송도 막는다(경로 2와 동일한 이유).
  if (!(await deps.isAddonEnabled(body.centerId))) return { status: 402, body: { status: "failed", message: "이 센터는 카카오 알림톡/SMS 발송 애드온을 신청하지 않았어요" } };
  const result = await deps.send({ to: body.to, content: body.content, templateCode: body.templateCode, templateVariables: body.templateVariables });
  return { status: result.status === "sent" ? 200 : 502, body: result as unknown as Record<string, unknown> };
}
