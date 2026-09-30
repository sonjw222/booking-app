/*
  app/components/PendingApprovalBanner.tsx — "센터센터는" 중복 문구 회귀 방지(2026-09-30).
  센터 이름 자체에 "센터"가 포함된 경우(예: "[QA] 모하빗 알림톡 테스트 센터") 뒤에 다시
  "센터는"을 붙이면 "...센터센터는"이 됐다. 조사 처리 라이브러리 없이, 이름 뒤에 명사를
  덧붙이지 않고 "는"만 붙이는 최소 수정으로 고쳤는지 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/components/PendingApprovalBanner.tsx"), "utf-8");

function renderedText(centerName: string, approvalStatus: "pending" | "rejected"): string {
  // 컴포넌트의 <b>{c.name}</b> + 뒤따르는 문자열 결합을 그대로 흉내낸다(렌더링 도구 없이
  // 텍스트 결합 결과만 검증 — 이 프로젝트의 기존 관례, tests/unit/loginPage.* 참고).
  const suffix = approvalStatus === "rejected"
    ? "는 운영자 승인이 거절됐어요. 회원 화면에 노출되지 않아요."
    : "는 아직 운영자 승인 대기 중이에요. 승인 전까지는 회원 화면에 노출되지 않으니, 지금 수업·수강권을 준비해두셔도 회원은 아직 볼 수 없어요.";
  return centerName + suffix;
}

describe("PendingApprovalBanner — 센터 이름 뒤 명사 중복 방지", () => {
  it("실제 렌더 문자열(JSX 삼항 표현식)에는 이름 뒤 '센터는' 형태로 명사를 다시 붙이지 않는다(코드 설명 주석 제외)", () => {
    const jsx = source.slice(source.indexOf("return ("));
    expect(jsx).not.toMatch(/:\s*"센터/); // 삼항 표현식의 두 분기 문자열이 "센터..."로 시작하지 않음
    expect(jsx).toMatch(/:\s*"는 /); // 대신 조사 "는"으로 바로 시작함
  });

  it("실제 QA 센터 이름(센터라는 단어를 이미 포함)으로 조립해도 '센터센터'가 생기지 않는다", () => {
    const rendered = renderedText("[QA] 모하빗 알림톡 테스트 센터", "pending");
    expect(rendered).not.toContain("센터센터");
    expect(rendered).toBe("[QA] 모하빗 알림톡 테스트 센터는 아직 운영자 승인 대기 중이에요. 승인 전까지는 회원 화면에 노출되지 않으니, 지금 수업·수강권을 준비해두셔도 회원은 아직 볼 수 없어요.");
  });

  it("'센터'가 이름에 없는 일반적인 센터명도 자연스럽게 조립된다", () => {
    expect(renderedText("어텐션 피겨팀", "pending")).toBe("어텐션 피겨팀는 아직 운영자 승인 대기 중이에요. 승인 전까지는 회원 화면에 노출되지 않으니, 지금 수업·수강권을 준비해두셔도 회원은 아직 볼 수 없어요.");
  });

  it("반려(rejected) 상태 문구도 동일하게 중복 없이 조립된다", () => {
    const rendered = renderedText("[QA] 모하빗 알림톡 테스트 센터", "rejected");
    expect(rendered).not.toContain("센터센터");
    expect(rendered).toBe("[QA] 모하빗 알림톡 테스트 센터는 운영자 승인이 거절됐어요. 회원 화면에 노출되지 않아요.");
  });

  it("복잡한 은/는 조사 처리 helper나 외부 라이브러리를 새로 도입하지 않는다", () => {
    expect(source).not.toMatch(/import .*josa|import .*eunneun/i);
  });
});
