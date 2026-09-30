/*
  app/manager/alimtalk/send/page.tsx — 즉시 발송 화면의 변수 자동/수동 채움 UI(2026-10-01,
  A-4/A-5/A-6). 핵심 치환 로직 자체(lib/members.ts sendAlimtalkToMembers)는
  tests/unit/sendAlimtalkToMembers.test.ts가 실제 호출로 검증하므로, 여기서는 이 화면이
  그 로직에 필요한 값(centerName, 대상의 passName/remainingCount/expiresAt, 수동 입력값)을
  빠짐없이 넘기고 발송 버튼을 올바르게 막는지만 소스 텍스트로 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/manager/alimtalk/send/page.tsx"), "utf-8");

describe("A-5 — 자동으로 알 수 없는 변수만 입력창을 보여준다", () => {
  it("ALIMTALK_AUTO_VARIABLE_NAMES에 없는 변수만 manualVarNames로 뽑는다", () => {
    expect(source).toContain("const manualVarNames = extractTemplateVariables(composerContent).filter(");
    expect(source).toContain("(v) => !ALIMTALK_AUTO_VARIABLE_NAMES.includes(v)");
  });

  it("각 manualVarNames마다 입력창을 렌더한다", () => {
    const block = source.slice(source.indexOf("manualVarNames.length > 0 && ("), source.indexOf("manualVarNames.length > 0 && (") + 1000);
    expect(block).toContain("manualVarNames.map((v) =>");
    expect(block).toContain("onChange={(e) => setManualVars((prev) => ({ ...prev, [v]: e.target.value }))}");
  });
});

describe("A-6 — 변수가 다 채워지기 전엔 발송 버튼이 막힌다", () => {
  it("manualVarsFilled는 모든 manualVarNames가 채워졌는지 확인한다", () => {
    expect(source).toContain("const manualVarsFilled = manualVarNames.every((v) => manualVars[v]?.trim());");
  });

  it("발송 버튼 disabled 조건에 !manualVarsFilled가 포함된다", () => {
    expect(source).toContain("disabled={sending || !hasAlimtalkContent(blocks) || !manualVarsFilled}");
  });

  it("handleSend 맨 앞에서도 manualVarsFilled를 다시 확인한다(버튼 우회 방어)", () => {
    const fn = source.slice(source.indexOf("async function handleSend()"), source.indexOf("async function handleSend()") + 200);
    expect(fn).toContain("!manualVarsFilled) return;");
  });

  it("다 채우지 않으면 어떤 변수가 빠졌는지 한글로 안내한다", () => {
    expect(source).toContain("을(를) 입력해 주세요.");
  });
});

describe("A-4 — 대상별 자동 변수를 위해 회원 정보를 그대로 넘긴다(이름/전화만 넘기던 예전 회귀 없음)", () => {
  it("sendAlimtalkToMembers 호출 시 passName/remainingCount/expiresAt을 포함한 대상 배열을 만든다", () => {
    const fn = source.slice(source.indexOf("const result = await sendAlimtalkToMembers("), source.indexOf("const result = await sendAlimtalkToMembers(") + 400);
    expect(fn).toContain("passName: m.passName");
    expect(fn).toContain("remainingCount: m.remainingCount");
    expect(fn).toContain("expiresAt: m.expiresAt");
  });

  it("centerName과 commonVariables(수동 입력값)를 옵션으로 넘긴다", () => {
    const fn = source.slice(source.indexOf("const result = await sendAlimtalkToMembers("), source.indexOf("const result = await sendAlimtalkToMembers(") + 400);
    expect(fn).toContain("{ centerName, commonVariables: manualVars }");
  });

  it("발송 결과 토스트에 unresolved(변수 미입력으로 건너뜀) 건수도 보여준다", () => {
    expect(source).toContain("변수 미입력으로 건너뜀");
  });
});

describe("템플릿/시트 전환 시 manualVars가 초기화된다(이전 템플릿의 입력값이 새 템플릿에 잘못 남지 않음)", () => {
  it("템플릿 select onChange에서 setManualVars({})를 호출한다", () => {
    const block = source.slice(source.indexOf("템플릿 불러오기 (선택)") - 600, source.indexOf("템플릿 불러오기 (선택)"));
    expect(block).toContain("setManualVars({});");
  });

  it("closeComposer도 manualVars를 초기화한다", () => {
    const fn = source.slice(source.indexOf("function closeComposer()"), source.indexOf("function closeComposer()") + 200);
    expect(fn).toContain("setManualVars({});");
  });
});
