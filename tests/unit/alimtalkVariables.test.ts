/*
  lib/alimtalk.ts — 알림톡 변수 문법 정규화/추출/자동 채움/렌더링(2026-10-01, Batch A).
  실제 승인된 Aligo 템플릿(UL_2071)은 #{변수} 문법을 쓰는데 앱 내부 표준은 [[변수]]라
  치환이 전혀 안 되던 문제(A-1)를 고친 핵심 로직들을 순수 함수 단위로 검증한다.
*/
import { describe, expect, it } from "vitest";
import {
  fromAligoVariableSyntax, extractTemplateVariables, hasUnresolvedAlimtalkVariables,
  renderAlimtalkVariables, resolveKnownAlimtalkVariables, ALIMTALK_AUTO_VARIABLE_NAMES,
} from "../../lib/alimtalk";

describe("fromAligoVariableSyntax — #{변수} → [[변수]] (A-2)", () => {
  it("실제 UL_2071 문구(#{고객명}/#{수업명}/#{센터명}/#{예약일시})를 모두 변환한다", () => {
    const aligo = "[모하빗 예약 완료]\n#{고객명}님의 예약이 완료되었습니다.\n수업명: #{수업명}\n센터명: #{센터명}\n예약일시: #{예약일시}";
    const out = fromAligoVariableSyntax(aligo);
    expect(out).toContain("[[고객명]]");
    expect(out).toContain("[[수업명]]");
    expect(out).toContain("[[센터명]]");
    expect(out).toContain("[[예약일시]]");
    expect(out).not.toMatch(/#\{/);
  });

  it("고정 문구/줄바꿈/마침표는 전혀 바뀌지 않는다(변수 부분만 치환)", () => {
    const aligo = "[모하빗 예약 완료]\n#{고객명}님의 예약이 완료되었습니다.\n감사합니다.\n모하빗";
    const out = fromAligoVariableSyntax(aligo);
    expect(out).toBe("[모하빗 예약 완료]\n[[고객명]]님의 예약이 완료되었습니다.\n감사합니다.\n모하빗");
  });

  it("이미 [[...]]인 텍스트는 그대로다(멱등 — 여러 번 적용해도 안전)", () => {
    const already = "[[회원명]]님, [[수강권명]] 잔여횟수가 [[수강권 잔여횟수]]회 남았어요.";
    expect(fromAligoVariableSyntax(already)).toBe(already);
    expect(fromAligoVariableSyntax(fromAligoVariableSyntax(already))).toBe(already);
  });
});

describe("extractTemplateVariables — [[...]]와 #{...} 둘 다 인식(A-3, 레거시 호환 방어)", () => {
  it("[[...]] 문법에서 변수를 뽑는다(기존 동작)", () => {
    expect(extractTemplateVariables("[[회원명]]님, [[수강권명]] 확인")).toEqual(["회원명", "수강권명"]);
  });

  it("#{...} 레거시 문법에서도 변수를 뽑는다", () => {
    expect(extractTemplateVariables("#{고객명}님의 예약이 완료되었습니다. 수업명: #{수업명}")).toEqual(["고객명", "수업명"]);
  });

  it("같은 이름이 두 문법에 섞여 나와도 중복 제거된다", () => {
    expect(extractTemplateVariables("[[회원명]] ... #{회원명}")).toEqual(["회원명"]);
  });

  it("변수가 없으면 빈 배열", () => {
    expect(extractTemplateVariables("안녕하세요, 모하빗입니다.")).toEqual([]);
  });
});

describe("hasUnresolvedAlimtalkVariables — 발송 직전 최종 방어(A-6)", () => {
  it("치환 안 된 [[...]]가 남아있으면 true", () => {
    expect(hasUnresolvedAlimtalkVariables("[[회원명]]님 안녕하세요")).toBe(true);
  });
  it("치환 안 된 #{...}가 남아있으면 true", () => {
    expect(hasUnresolvedAlimtalkVariables("#{고객명}님 안녕하세요")).toBe(true);
  });
  it("전부 치환됐으면 false", () => {
    expect(hasUnresolvedAlimtalkVariables("김모하빗님 안녕하세요")).toBe(false);
  });
});

describe("renderAlimtalkVariables — 두 문법 모두 치환", () => {
  it("[[...]]를 치환한다", () => {
    expect(renderAlimtalkVariables("[[회원명]]님 반가워요", { 회원명: "김모하빗" })).toBe("김모하빗님 반가워요");
  });
  it("#{...}도 치환한다(정규화 전 원문이 섞여 들어와도 방어)", () => {
    expect(renderAlimtalkVariables("#{고객명}님 반가워요", { 고객명: "김모하빗" })).toBe("김모하빗님 반가워요");
  });
  it("values에 없는 변수는 그대로 남는다(hasUnresolvedAlimtalkVariables가 이어서 잡음)", () => {
    const out = renderAlimtalkVariables("[[회원명]]님, [[수업명]] 수업", { 회원명: "김모하빗" });
    expect(out).toBe("김모하빗님, [[수업명]] 수업");
    expect(hasUnresolvedAlimtalkVariables(out)).toBe(true);
  });
});

describe("resolveKnownAlimtalkVariables — 자동으로 알 수 있는 변수만 채움(A-4)", () => {
  it("회원명/고객명은 둘 다 alias로 대상 이름이 들어간다", () => {
    const r = resolveKnownAlimtalkVariables(["회원명", "고객명"], "모하빗 테스트센터", { name: "김모하빗" });
    expect(r).toEqual({ 회원명: "김모하빗", 고객명: "김모하빗" });
  });

  it("센터명은 전달된 센터 이름으로 채워진다", () => {
    expect(resolveKnownAlimtalkVariables(["센터명"], "모하빗 테스트센터", { name: "김모하빗" })).toEqual({ 센터명: "모하빗 테스트센터" });
  });

  it("수강권명/잔여횟수는 recipient 값이 있을 때만 채워진다", () => {
    const r = resolveKnownAlimtalkVariables(
      ["수강권명", "수강권 잔여횟수"], "센터",
      { name: "김모하빗", passName: "10회권", remainingCount: 3 }
    );
    expect(r).toEqual({ 수강권명: "10회권", "수강권 잔여횟수": "3" });
  });

  it("recipient 값이 없으면(null) 그 변수는 결과에서 빠진다 — 원문 불명확값을 억지로 채우지 않음", () => {
    const r = resolveKnownAlimtalkVariables(["수강권명", "수강권 잔여횟수"], "센터", { name: "김모하빗" });
    expect(r).toEqual({});
  });

  it("수강권 잔여일은 expiresAt로부터 오늘 기준 남은 일수를 계산한다", () => {
    const in5days = new Date(); in5days.setHours(0, 0, 0, 0); in5days.setDate(in5days.getDate() + 5);
    const r = resolveKnownAlimtalkVariables(["수강권 잔여일"], "센터", { name: "김모하빗", expiresAt: in5days.toISOString() });
    expect(r["수강권 잔여일"]).toBe("5");
  });

  it("자동으로 알 수 없는 변수(예: 수업명/예약일시)는 결과에서 빠진다 — 호출부가 수동 입력 UI로 구분(A-5)", () => {
    const r = resolveKnownAlimtalkVariables(["수업명", "예약일시"], "센터", { name: "김모하빗" });
    expect(r).toEqual({});
  });

  it("ALIMTALK_AUTO_VARIABLE_NAMES 목록과 실제 자동 처리 대상이 일치한다(화면의 입력창 노출 판단 기준과 실제 로직이 같아야 함)", () => {
    const r = resolveKnownAlimtalkVariables(
      ALIMTALK_AUTO_VARIABLE_NAMES, "센터",
      { name: "김모하빗", passName: "10회권", remainingCount: 3, expiresAt: new Date().toISOString() }
    );
    expect(Object.keys(r).sort()).toEqual([...ALIMTALK_AUTO_VARIABLE_NAMES].sort());
  });
});

describe("실제 UL_2071 시나리오 종단 — normalize → extract → resolve → render → 발송 가능 여부", () => {
  it("자동 변수(고객명/센터명)만 있는 문구는 전부 자동으로 채워져 발송 가능하다", () => {
    const raw = "[모하빗 예약 완료]\n#{고객명}님의 예약이 완료되었습니다.\n센터명: #{센터명}\n감사합니다.\n모하빗";
    const normalized = fromAligoVariableSyntax(raw);
    const vars = extractTemplateVariables(normalized);
    const known = resolveKnownAlimtalkVariables(vars, "모하빗 테스트센터", { name: "김모하빗" });
    const rendered = renderAlimtalkVariables(normalized, known);
    expect(hasUnresolvedAlimtalkVariables(rendered)).toBe(false);
    expect(rendered).toContain("김모하빗님의 예약이 완료되었습니다.");
    expect(rendered).toContain("센터명: 모하빗 테스트센터");
  });

  it("자동으로 모르는 변수(수업명/예약일시)가 있으면 수동 입력 없이는 여전히 미해결 상태다(원문 그대로 발송 금지)", () => {
    const raw = "[모하빗 예약 완료]\n#{고객명}님의 예약이 완료되었습니다.\n수업명: #{수업명}\n예약일시: #{예약일시}";
    const normalized = fromAligoVariableSyntax(raw);
    const vars = extractTemplateVariables(normalized);
    const known = resolveKnownAlimtalkVariables(vars, "센터", { name: "김모하빗" });
    const rendered = renderAlimtalkVariables(normalized, known);
    expect(hasUnresolvedAlimtalkVariables(rendered)).toBe(true); // 수업명/예약일시가 안 채워짐
    // 수동 입력(commonVariables)을 마저 채우면 그제서야 발송 가능해진다.
    const withManual = renderAlimtalkVariables(rendered, { 수업명: "필라테스 기초반", 예약일시: "10월 3일 16:00" });
    expect(hasUnresolvedAlimtalkVariables(withManual)).toBe(false);
  });
});
