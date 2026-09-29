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
};

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

  const res = await fetch(`${ALIGO_PROXY_URL}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ALIGO_PROXY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const resJson = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      resJson?.provider?.message ??
        resJson?.error ??
        `알리고 프록시 요청 실패 (HTTP ${res.status})`,
    );
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
    out = out.split(`[[${k}]]`).join(v);
  }
  return out;
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
      const provider = await callAligoProxy("/v1/alimtalk/send", {
        to: input.to,
        message: renderTemplate(input.content, input.templateVariables),
        templateCode: input.templateCode,
        // 기존 동작과 동일하게 대체발송 문구는 input.content를 사용한다.
        fallbackMessage: input.content,
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
    };
  }
}
