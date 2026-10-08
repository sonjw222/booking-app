// 알리고(Aligo) 공용 모듈.
// 모든 Aligo API 호출은 고정 egress IP를 가진 Oracle 프록시를 통해 수행한다.
//
// 필요한 Supabase Edge Function secrets:
//   ALIGO_PROXY_URL   — 예: https://aligo-proxy.mwhabit.com
//   ALIGO_PROXY_TOKEN — Oracle 프록시 인증용 Bearer token
//
// Aligo 계정/API 키/발신프로필 키/발신번호는 Oracle 서버에만 저장하고
// Supabase Edge Function에서는 직접 사용하지 않는다.

const ALIGO_PROXY_URL = (Deno.env.get("ALIGO_PROXY_URL") ?? "").replace(/\/+$/, "");
const ALIGO_PROXY_TOKEN = Deno.env.get("ALIGO_PROXY_TOKEN") ?? "";

export type SendResult = {
  status: "sent" | "failed";
  providerMessageId?: string;
  message?: string;
  // 재시도하면 성공할 수 있는 실패(프록시 타임아웃/네트워크/5xx/429)이면 true. 제공자가 명시적으로 거절한 경우(잘못된 번호/템플릿 등)는 false.
  // 큐 디스패처(send-alimtalk)가 "다시 시도할지, 실패로 확정할지"를 판단하는 근거다(2026-10-08).
  retryable?: boolean;
};

// 외부(Oracle 프록시) 호출이 멈추면 Edge Function 전체가 매달려 다음 분 cron과 겹쳐 중복 발송을 부른다 — 반드시 타임아웃을 둔다.
export const ALIGO_TIMEOUT_MS = 10_000;

// 재시도 가능한 오류(네트워크/타임아웃/HTTP 5xx·429)를 구분하는 표식.
class AligoTransientError extends Error {}

function isProxyConfigured(): boolean {
  return !!(ALIGO_PROXY_URL && ALIGO_PROXY_TOKEN);
}

// 발신 설정 화면(app/manager/alimtalk/settings)의 연결 상태 조회용.
// 비밀값 자체는 절대 반환하지 않는다.
export function isAligoConfigured(): boolean {
  return isProxyConfigured();
}

async function callAligoProxy(
  path: string,
  payload: Record<string, unknown>,
): Promise<any> {
  if (!isProxyConfigured()) {
    throw new Error(
      "알리고 프록시가 아직 연동되지 않았어요 (ALIGO_PROXY_URL / ALIGO_PROXY_TOKEN 미등록)",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${ALIGO_PROXY_URL}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ALIGO_PROXY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ALIGO_TIMEOUT_MS),
    });
  } catch {
    // 타임아웃/연결 실패 — 본문이나 URL을 오류 메시지에 싣지 않는다.
    throw new AligoTransientError("알리고 프록시에 연결하지 못했어요(시간 초과 또는 네트워크 오류)");
  }

  const resJson = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = resJson?.provider?.message ??
      resJson?.error ??
      `알리고 프록시 요청 실패 (HTTP ${res.status})`;
    if (res.status >= 500 || res.status === 429) throw new AligoTransientError(message);
    throw new Error(message);
  }

  return resJson?.provider ?? {};
}

// 알리고에 등록된(카카오 사전심사까지 거친) 템플릿 목록.
export type AligoTemplateInfo = {
  templtCode: string;
  templtName: string;
  templtContent: string;
  inspStatus: "REG" | "REQ" | "APR" | "REJ" | string;
};

export async function fetchAligoTemplateList(): Promise<AligoTemplateInfo[]> {
  const provider = await callAligoProxy("/v1/template/list", {});

  if (Number(provider?.code) !== 0) {
    throw new Error(provider?.message ?? "템플릿 목록 조회 실패");
  }

  return provider?.list ?? [];
}

// 우리 앱의 [[변수]] 표기를 알리고/카카오 공식 표기 #{변수}로 바꾼다.
export function toAligoVariableSyntax(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_m, v) => `#{${v}}`);
}

export type AligoTemplateCreateResult = {
  templtCode: string;
  templtName: string;
  templtContent: string;
  inspStatus: string;
};

// 신규 템플릿 생성(카카오 승인 신청 전 단계).
export async function createAligoTemplate(
  tplName: string,
  tplContent: string,
): Promise<AligoTemplateCreateResult> {
  const provider = await callAligoProxy("/v1/template/add", {
    name: tplName,
    content: toAligoVariableSyntax(tplContent),
  });

  if (Number(provider?.code) !== 0) {
    throw new Error(provider?.message ?? "템플릿 생성 실패");
  }

  return provider?.data;
}

// 생성된 템플릿을 카카오 사전심사에 올린다.
export async function requestAligoTemplateApproval(
  tplCode: string,
): Promise<void> {
  const provider = await callAligoProxy("/v1/template/request", {
    templateCode: tplCode,
  });

  if (Number(provider?.code) !== 0) {
    throw new Error(provider?.message ?? "승인 신청 실패");
  }
}

function renderTemplate(
  content: string,
  variables?: Record<string, string>,
): string {
  if (!variables) return content;

  let out = content;
  for (const [k, v] of Object.entries(variables)) {
    // 2026-10-01(A-3) — [[변수]]가 DB 내부 표준이지만, 정규화(lib/alimtalk.ts의
    // fromTemplateRow/createAlimtalkTemplate 정규화-on-write)를 거치지 않고 들어온 원문이
    // 방어적으로 섞여 있을 수 있어 #{변수}도 같이 치환한다(lib/alimtalk.ts의
    // renderAlimtalkVariables와 동일 로직 — Deno 런타임이라 그 파일을 import할 수 없어
    // 여기 복제해 둠, 로직을 바꿀 때는 양쪽 다 같이 고쳐야 함).
    out = out.split(`[[${k}]]`).join(v).split(`#{${k}}`).join(v);
  }
  return out;
}

// 최종 발송 직전 방어(A-6, 서버 쪽) — 치환 안 된 [[변수]] 또는 #{변수} placeholder가
// 하나라도 남아있으면 true. lib/alimtalk.ts의 hasUnresolvedAlimtalkVariables와 동일 로직
// (클라이언트도 같은 판정으로 미리 막지만, 서버도 독립적으로 다시 확인 — 클라이언트를
// 우회한 직접 호출까지 막기 위함).
function hasUnresolvedVariables(content: string): boolean {
  return /\[\[([^\]]+)\]\]|#\{([^}]+)\}/.test(content);
}

// 알리고 실발송.
// templateCode가 있으면 알림톡(+ Aligo SMS failover), 없으면 SMS로 발송한다.
export async function sendViaAligo(input: {
  to: string;
  content: string;
  templateCode?: string;
  templateVariables?: Record<string, string>;
}): Promise<SendResult> {
  if (!isProxyConfigured()) {
    return {
      status: "failed",
      message:
        "알리고 프록시가 아직 연동되지 않았어요 (ALIGO_PROXY_URL / ALIGO_PROXY_TOKEN 미등록)",
    };
  }

  try {
    if (input.templateCode) {
      const rendered = renderTemplate(input.content, input.templateVariables);

      // A-6(서버 방어) — 치환 안 된 [[변수]]/#{변수}가 남아있으면 실제 Aligo API를
      // 호출하지 않는다. 클라이언트(app/manager/alimtalk/send, app/manager/members)가
      // 이미 막지만, 이 Edge Function을 클라이언트 밖에서 직접 호출하는 경로(예: 향후
      // 다른 내부 호출)까지 대비한 독립적인 마지막 방어선이다. OTP 발송(send-phone-otp,
      // templateVariables: { code })처럼 실제로 모든 변수가 채워지는 정상 호출은 렌더 후
      // placeholder가 남지 않아 이 분기를 타지 않는다(회귀 없음).
      if (hasUnresolvedVariables(rendered)) {
        return {
          status: "failed",
          message: "템플릿에 채워지지 않은 변수가 있어 발송할 수 없어요",
        };
      }

      const provider = await callAligoProxy("/v1/alimtalk/send", {
        to: input.to,
        message: rendered,
        templateCode: input.templateCode,
        // 2026-10-01(A-7) — 예전에는 원문(input.content, [[변수]] placeholder가 그대로
        // 남아있는 문구)을 대체발송 문구로 그대로 보냈다. 카카오톡 발송 실패 시 Aligo가
        // 이 fallbackMessage로 SMS 대체발송을 하므로, 회원이 "[[회원명]]님의 예약이…"처럼
        // 치환 안 된 문자를 그대로 받는 문제가 있었다 — 알림톡과 동일하게 렌더링된 최종
        // 문구를 쓴다.
        fallbackMessage: rendered,
      });

      if (Number(provider?.code) !== 0) {
        return {
          status: "failed",
          message: provider?.message ?? "알림톡 발송 실패",
        };
      }

      return {
        status: "sent",
        providerMessageId: provider?.info?.mid ?? undefined,
      };
    }

    // A-6 — SMS 경로(템플릿 없이 자유 문장 발송)도 같은 마지막 방어선을 적용한다.
    if (hasUnresolvedVariables(input.content)) {
      return {
        status: "failed",
        message: "템플릿에 채워지지 않은 변수가 있어 발송할 수 없어요",
      };
    }

    const provider = await callAligoProxy("/v1/sms/send", {
      to: input.to,
      message: input.content,
    });

    if (String(provider?.result_code) !== "1") {
      return {
        status: "failed",
        message: provider?.message ?? "SMS 발송 실패",
      };
    }

    return {
      status: "sent",
      providerMessageId: provider?.msg_id
        ? String(provider.msg_id)
        : undefined,
    };
  } catch (err) {
    return {
      status: "failed",
      message: err instanceof Error
        ? err.message
        : "발송 중 알 수 없는 오류",
      retryable: err instanceof AligoTransientError,
    };
  }
}
