/*
  supabase/functions/_shared/aligo.ts — 알림톡 발송 직전 최종 방어(A-6) + SMS 대체발송
  문구 렌더링(A-7). Deno 런타임 전용 파일(Deno.env.get 등)이라 Vitest(Node)에서 직접
  import/실행할 수 없어(이 프로젝트 기존 관례, Edge Function은 항상 소스 텍스트로 검증)
  소스 텍스트로 검증한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../supabase/functions/_shared/aligo.ts"), "utf-8");
const otpSource = readFileSync(join(__dirname, "../../supabase/functions/send-phone-otp/index.ts"), "utf-8");

describe("A-6 — 서버 쪽 최종 방어: 미해결 변수가 있으면 실제 Aligo API를 호출하지 않는다", () => {
  it("hasUnresolvedVariables 헬퍼가 [[...]]와 #{...} 둘 다 검사한다", () => {
    const fn = source.slice(source.indexOf("function hasUnresolvedVariables"), source.indexOf("function hasUnresolvedVariables") + 200);
    expect(fn).toContain("\\[\\[");
    expect(fn).toContain("#\\{");
  });

  it("알림톡 발송 직전(templateCode 분기)에 렌더링된 메시지를 검사한다", () => {
    const fn = source.slice(source.indexOf("export async function sendViaAligo"), source.length);
    const alimtalkBranch = fn.slice(fn.indexOf("if (input.templateCode)"), fn.indexOf("const provider = await callAligoProxy(\"/v1/sms/send\""));
    expect(alimtalkBranch).toContain("const rendered = renderTemplate(input.content, input.templateVariables);");
    expect(alimtalkBranch).toMatch(/if \(hasUnresolvedVariables\(rendered\)\)/);
    // 검사가 실제 Aligo 호출(callAligoProxy) 코드보다 앞에 있어야 한다.
    expect(alimtalkBranch.indexOf("hasUnresolvedVariables(rendered)")).toBeLessThan(alimtalkBranch.indexOf('callAligoProxy("/v1/alimtalk/send"'));
  });

  it("SMS 경로(템플릿 없음)도 같은 방어를 거친다", () => {
    const fn = source.slice(source.indexOf("export async function sendViaAligo"), source.length);
    const smsBranch = fn.slice(fn.indexOf('callAligoProxy("/v1/sms/send"') - 300, fn.indexOf('callAligoProxy("/v1/sms/send"'));
    expect(smsBranch).toMatch(/if \(hasUnresolvedVariables\(input\.content\)\)/);
  });
});

describe("A-7 — SMS 대체발송(fallbackMessage)이 원문이 아니라 렌더링된 최종 문구를 쓴다", () => {
  it("fallbackMessage에 rendered(치환 완료된 문구)를 쓴다 — 예전처럼 input.content(원문)를 그대로 쓰지 않음", () => {
    const fn = source.slice(source.indexOf("export async function sendViaAligo"), source.length);
    const alimtalkCall = fn.slice(fn.indexOf('callAligoProxy("/v1/alimtalk/send"'), fn.indexOf('callAligoProxy("/v1/alimtalk/send"') + 900);
    expect(alimtalkCall).toContain("fallbackMessage: rendered,");
    expect(alimtalkCall).not.toContain("fallbackMessage: input.content,");
  });

  it("renderTemplate이 [[...]]와 #{...} 둘 다 치환한다(레거시 #{...} 행 방어)", () => {
    const fn = source.slice(source.indexOf("function renderTemplate"), source.indexOf("function renderTemplate") + 700);
    expect(fn).toContain("out.split(`[[${k}]]`).join(v).split(`#{${k}}`).join(v)");
  });
});

describe("OTP 발송 회귀 없음 — templateVariables: { code } 흐름은 그대로", () => {
  it("send-phone-otp는 여전히 templateVariables: { code }로 sendViaAligo를 호출한다(이 배치에서 건드리지 않음)", () => {
    expect(otpSource).toContain("templateVariables: { code }");
  });
});
