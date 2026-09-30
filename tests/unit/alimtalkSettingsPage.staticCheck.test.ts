/*
  app/manager/alimtalk/settings/page.tsx — 실제 MWHABIT 운영 구조에 맞는 안내로 교체(2026-09-30).
  센터 관리자는 Aligo 가입/사업자 인증/카카오 채널 개설/발신프로필 등록/API key 입력을 전혀
  하지 않는다(플랫폼 공용 send-alimtalk → Oracle 고정 IP 프록시 → 단일 Aligo 계정 구조) —
  그 절차를 안내하던 기존 UX를 제거했는지, 내부 인프라 정보가 새로 노출되지 않는지 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/manager/alimtalk/settings/page.tsx"), "utf-8");

describe("2-A. 기존 '연결 준비 1~5' 안내 제거", () => {
  const jsxOnly = source.slice(source.indexOf("return (\n    <div className=\"app-shell\">"));

  it("알리고 가입/사업자 인증/카카오 채널 개설/발신프로필 등록/운영자 연결 확인 요청 문구가 화면(JSX)에 없다", () => {
    expect(jsxOnly).not.toMatch(/알리고에 가입/);
    expect(jsxOnly).not.toMatch(/사업자 인증/);
    expect(jsxOnly).not.toMatch(/카카오톡 채널을 개설/);
    expect(jsxOnly).not.toMatch(/발신프로필을 등록/);
    expect(jsxOnly).not.toMatch(/운영자에게 연결 확인을 요청/);
  });

  it("단계별 순서 목록(<ol>, connection-steps)을 더 이상 쓰지 않는다", () => {
    expect(source).not.toContain("<ol");
    expect(source).not.toContain("connection-steps");
  });
});

describe("2-B. 새 안내 — 센터 관리자가 알아야 할 정보만", () => {
  it("모하빗 공용 발송 서비스라는 사실과 템플릿 등록 안내, 문자 대체 발송 가능성을 전달한다", () => {
    expect(source).toMatch(/모하빗 알림톡/);
    expect(source).toMatch(/템플릿 관리/);
    expect(source).toMatch(/문자로 대체 발송/);
  });

  it("절대 표시하지 말아야 할 내부 인프라/시크릿 관련 단어가 사용자 화면(JSX)에는 없다(코드 설명 주석 제외)", () => {
    // 파일 상단 주석은 왜 이렇게 바꿨는지 설명하려고 내부 구조(Oracle 프록시 등)를 언급할 수 있다
    // (개발자만 보는 코드 주석) — 실제 화면에 렌더되는 JSX(return 문 이후)에만 없으면 된다.
    const jsx = source.slice(source.indexOf("return (\n    <div className=\"app-shell\">"));
    const forbidden = ["API key", "API 키", "sender key", "ALIGO_USER_ID", "sender phone", "Oracle", "proxy", "프록시", "Supabase secret", "service_role", "SUPABASE_SERVICE_ROLE_KEY"];
    for (const word of forbidden) expect(jsx).not.toContain(word);
  });
});

describe("2-C. 연결 상태 — 기존 로직/Edge Function 호출 유지", () => {
  it("status 액션 호출과 connected 상태 판정 로직을 그대로 재사용한다(백엔드 미수정)", () => {
    expect(source).toContain('body: { action: "status" }');
    expect(source).toContain('"send-alimtalk"');
    expect(source).toContain("setConnected(data.connected)");
  });

  it("표현이 '센터가 직접 연동했다'는 뉘앙스가 아니라 플랫폼 공용 서비스로 읽힌다", () => {
    expect(source).not.toMatch(/센터가 (직접 )?(알리고|Aligo)를? ?연동/);
  });
});
