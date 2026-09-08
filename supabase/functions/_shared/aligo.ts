// 알리고(Aligo) 발송 공용 모듈 — send-alimtalk와 send-phone-otp가 함께 쓴다.
// 원래 send-alimtalk/index.ts 안에만 있던 sendViaAligo()를 그대로 옮긴 것(로직 변경 없음).
//
// 필요한 환경변수(호출하는 Edge Function 각각에 `supabase secrets set`으로 등록):
//   ALIGO_USER_ID, ALIGO_API_KEY       — 알리고 가입 후 발급
//   ALIGO_SENDER_KEY                   — 카카오 알림톡 발신프로필 키(카카오 채널 연결 후 발급)
//   ALIGO_SENDER_PHONE                 — SMS 대체발송용 발신번호(사전 등록된 번호)
//
// ⚠️ 알리고 실제 계정을 발급받는 시점에 아래 요청 필드명을 최신 API 문서와 한 번 더
//    대조해야 한다(작성 시점엔 계정이 없어 문서 대조가 불가능했음).

const ALIGO_USER_ID = Deno.env.get("ALIGO_USER_ID") ?? "";
const ALIGO_API_KEY = Deno.env.get("ALIGO_API_KEY") ?? "";
const ALIGO_SENDER_KEY = Deno.env.get("ALIGO_SENDER_KEY") ?? "";
const ALIGO_SENDER_PHONE = Deno.env.get("ALIGO_SENDER_PHONE") ?? "";

export type SendResult = { status: "sent" | "failed"; providerMessageId?: string; message?: string };

// 발신 설정 화면(app/manager/alimtalk/settings)의 연결 상태 조회용 — 키 값 자체는 절대 반환하지 않음.
export function isAligoConfigured(): boolean {
  return !!(ALIGO_USER_ID && ALIGO_API_KEY && ALIGO_SENDER_KEY && ALIGO_SENDER_PHONE);
}

// 알리고에 등록된(카카오 사전심사까지 거친) 템플릿 목록 — 필드명은 알리고 공식 문서
// (smartsms.aligo.in/alimapi.html)와 실제 구현체(github.com/esinx/aligo-kakao-api)로
// 2026-09-08에 대조 확인함. senderkey 하나로 조회하는 계정 전체 목록이라 우리 DB의
// center_id 구분은 없다 — 여러 센터 템플릿이 한 목록에 섞여 나오므로 이름으로 구분해야 함.
export type AligoTemplateInfo = {
  templtCode: string;
  templtName: string;
  templtContent: string;
  inspStatus: "REG" | "REQ" | "APR" | "REJ" | string; // 등록/심사요청/승인/반려
};

export async function fetchAligoTemplateList(): Promise<AligoTemplateInfo[]> {
  if (!ALIGO_USER_ID || !ALIGO_API_KEY || !ALIGO_SENDER_KEY) {
    throw new Error("알리고 계정/발신프로필이 아직 연동되지 않았어요");
  }
  const body = new URLSearchParams({
    apikey: ALIGO_API_KEY,
    userid: ALIGO_USER_ID,
    senderkey: ALIGO_SENDER_KEY,
  });
  const res = await fetch("https://kakaoapi.aligo.in/akv10/template/list", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const resJson = await res.json().catch(() => ({}));
  if (!res.ok || resJson?.code !== 0) {
    throw new Error(resJson?.message ?? `템플릿 목록 조회 실패 (HTTP ${res.status})`);
  }
  return resJson?.list ?? [];
}

// 우리 앱의 [[변수]] 표기를 알리고/카카오 공식 표기 #{변수}로 바꾼다 — 알리고 문서
// (template/add 예제)와 실제 구현체(esinx/aligo-kakao-api의 replaceAllTokens)가 공통으로
// #{...}를 쓰는 걸 확인함(2026-09-08). 우리 DB(alimtalk_templates.content)에는 항상
// [[...]] 형태로 저장해두고, 알리고로 나가는 시점에만 이 함수로 변환한다.
export function toAligoVariableSyntax(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_m, v) => `#{${v}}`);
}

export type AligoTemplateCreateResult = {
  templtCode: string;
  templtName: string;
  templtContent: string;
  inspStatus: string; // 생성 직후엔 항상 REG
};

// 신규 템플릿 생성(카카오 승인 신청 전 단계) — POST /akv10/template/add/.
// tplName은 호출하는 쪽에서 센터명 등을 이미 접두사로 붙여서 넘겨야 한다(여러 센터가
// 같은 알리고 계정을 공유해서, 알리고 쪽 목록에서 이름으로 구분해야 하기 때문).
export async function createAligoTemplate(tplName: string, tplContent: string): Promise<AligoTemplateCreateResult> {
  if (!ALIGO_USER_ID || !ALIGO_API_KEY || !ALIGO_SENDER_KEY) {
    throw new Error("알리고 계정/발신프로필이 아직 연동되지 않았어요");
  }
  const body = new URLSearchParams({
    apikey: ALIGO_API_KEY,
    userid: ALIGO_USER_ID,
    senderkey: ALIGO_SENDER_KEY,
    tpl_name: tplName,
    tpl_content: toAligoVariableSyntax(tplContent),
  });
  const res = await fetch("https://kakaoapi.aligo.in/akv10/template/add/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const resJson = await res.json().catch(() => ({}));
  if (!res.ok || resJson?.code !== 0) {
    throw new Error(resJson?.message ?? `템플릿 생성 실패 (HTTP ${res.status})`);
  }
  return resJson?.data;
}

// 생성된 템플릿을 카카오 사전심사에 올린다 — POST /akv10/template/request/.
// 심사 결과(4-5일 소요)는 fetchAligoTemplateList()로 나중에 다시 조회해서 확인해야 한다
// (이 API는 "요청 접수" 응답만 주고 즉시 심사가 끝나는 게 아님).
export async function requestAligoTemplateApproval(tplCode: string): Promise<void> {
  if (!ALIGO_USER_ID || !ALIGO_API_KEY || !ALIGO_SENDER_KEY) {
    throw new Error("알리고 계정/발신프로필이 아직 연동되지 않았어요");
  }
  const body = new URLSearchParams({
    apikey: ALIGO_API_KEY,
    userid: ALIGO_USER_ID,
    senderkey: ALIGO_SENDER_KEY,
    tpl_code: tplCode,
  });
  const res = await fetch("https://kakaoapi.aligo.in/akv10/template/request/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const resJson = await res.json().catch(() => ({}));
  if (!res.ok || resJson?.code !== 0) {
    throw new Error(resJson?.message ?? `승인 신청 실패 (HTTP ${res.status})`);
  }
}

function renderTemplate(content: string, variables?: Record<string, string>): string {
  if (!variables) return content;
  let out = content;
  for (const [k, v] of Object.entries(variables)) out = out.split(`[[${k}]]`).join(v);
  return out;
}

// 알리고 실발송 — 계정 미준비 상태(키 없음)면 명시적으로 실패 반환(조용히 성공한 척 안 함).
export async function sendViaAligo(input: {
  to: string;
  content: string;
  templateCode?: string;
  templateVariables?: Record<string, string>;
}): Promise<SendResult> {
  if (!ALIGO_USER_ID || !ALIGO_API_KEY) {
    return { status: "failed", message: "알리고 계정이 아직 연동되지 않았어요 (ALIGO_* 시크릿 미등록)" };
  }

  try {
    if (input.templateCode) {
      // 알림톡 템플릿 발송 — 실패 시 SMS 대체발송(failover)
      const body = new URLSearchParams({
        apikey: ALIGO_API_KEY,
        userid: ALIGO_USER_ID,
        senderkey: ALIGO_SENDER_KEY,
        tpl_code: input.templateCode,
        sender: ALIGO_SENDER_PHONE,
        receiver_1: input.to,
        message_1: renderTemplate(input.content, input.templateVariables),
        failover: "Y",
        fsubject_1: "안내",
        fmessage_1: input.content,
      });
      const res = await fetch("https://kakaoapi.aligo.in/akv10/alimtalk/send/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const resJson = await res.json().catch(() => ({}));
      if (!res.ok || resJson?.code !== 0) {
        return { status: "failed", message: resJson?.message ?? `알림톡 발송 실패 (HTTP ${res.status})` };
      }
      return { status: "sent", providerMessageId: resJson?.info?.mid ?? undefined };
    }

    // 템플릿 없음(자유 문장) — SMS로 바로 발송
    const body = new URLSearchParams({
      apikey: ALIGO_API_KEY,
      userid: ALIGO_USER_ID,
      sender: ALIGO_SENDER_PHONE,
      receiver: input.to,
      msg: input.content,
    });
    const res = await fetch("https://apis.aligo.in/send/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const resJson = await res.json().catch(() => ({}));
    if (!res.ok || resJson?.result_code !== "1") {
      return { status: "failed", message: resJson?.message ?? `SMS 발송 실패 (HTTP ${res.status})` };
    }
    return { status: "sent", providerMessageId: resJson?.msg_id ? String(resJson.msg_id) : undefined };
  } catch (err) {
    return { status: "failed", message: err instanceof Error ? err.message : "발송 중 알 수 없는 오류" };
  }
}
