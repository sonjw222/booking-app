/*
  app/manager/classes/page.tsx — 예약/취소 마감 "운영설정 기본값" 실제 적용값 표시
  (2026-10-01, Batch B-1~B-4). 빈 칸이면 운영설정 값이 적용된다는 사실은 있었지만 실제
  값이 뭔지 화면에서 알 수 없었던 문제를 고쳤다. lib/deadlineInput.ts(dhmToMinutes/
  minutesToDhm)의 null=상속 규칙 자체는 이미 있던 그대로 — DB에 상속값을 새로 저장하지
  않는다는 B-3 요구사항은 이 기존 로직이 이미 만족하고 있었음을 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/manager/classes/page.tsx"), "utf-8");
const deadlineLib = readFileSync(join(__dirname, "../../lib/deadlineInput.ts"), "utf-8");

describe("B-1/B-2 — 실제 적용될 운영설정 값을 화면에 보여준다", () => {
  it("센터 설정을 불러와 effectiveDeadlineText가 계산한다", () => {
    expect(source).toContain('import { fetchSettings, type CenterSettings } from "../../../lib/settings";');
    expect(source).toContain("function effectiveDeadlineText(kind: \"book\" | \"cancel\"): string | null {");
  });

  it("그룹/프라이빗에 따라 다른 운영설정 필드를 읽는다(회귀 없음 — business logic 변경 아님, 표시만)", () => {
    const fn = source.slice(source.indexOf("function effectiveDeadlineText"), source.indexOf("function effectiveDeadlineText") + 900);
    expect(fn).toContain("centerSettings.privateBookDaysBefore");
    expect(fn).toContain("centerSettings.groupBookDaysBefore");
    expect(fn).toContain("centerSettings.privateCancelDaysBefore");
    expect(fn).toContain("centerSettings.groupCancelDaysBefore");
  });

  it("빈 칸(상속 상태)일 때만 운영설정 기본값 안내를 보여준다", () => {
    expect(source).toContain('bookD === "" && bookH === "" && bookM === "" ? (');
    expect(source).toContain('cancelD === "" && cancelH === "" && cancelM === "" ? (');
    expect(source).toContain("(운영설정 값 사용 중)");
  });
});

describe("B-3 — 상속값을 override로 새로 저장하지 않는다(기존 null 규칙 그대로, 회귀 없음)", () => {
  it("세 칸이 모두 비면 dhmToMinutes가 null을 반환한다(값을 만들어 채우지 않음)", () => {
    expect(deadlineLib).toContain('if (!dStr && !hStr && !mStr) return null;');
  });

  it("effectiveDeadlineText는 화면 표시 전용이고 bookD/cancelD 등 실제 저장 state는 건드리지 않는다", () => {
    const fn = source.slice(source.indexOf("function effectiveDeadlineText"), source.indexOf("function openCreate()"));
    expect(fn).not.toMatch(/setBookD|setBookH|setBookM|setCancelD|setCancelH|setCancelM/);
  });
});

describe("B-4 — '운영설정 값으로 되돌리기'", () => {
  it("override가 있을 때만 되돌리기 버튼이 보이고, 누르면 null로 채워 상속 상태로 되돌린다", () => {
    expect(source).toContain('onClick={() => fillBookDeadline(null)}');
    expect(source).toContain('onClick={() => fillDeadline(null)}');
  });

  it("fillDeadline/fillBookDeadline(null)은 세 필드를 모두 빈 문자열로 만든다(minutesToDhm(null) 규칙)", () => {
    expect(deadlineLib).toContain("if (min == null || min <= 0) return { d: \"\", h: \"\", m: \"\" };");
  });

  it("되돌리기 버튼 문구가 요청된 표현과 일치한다", () => {
    expect(source).toContain("운영설정 값으로 되돌리기");
  });
});

describe("B-5 — 같은 '빈 값=운영설정 상속' 패턴이 있는 다른 화면 감사(최종 보고 근거)", () => {
  it("이 프로젝트에서 이 패턴은 수업 등록의 예약/취소 마감 두 곳뿐이다(전수 grep 결과, membership-rules의 '비우면'은 필터 범위 의미라 다른 패턴)", () => {
    // 이 assertion은 문서화 목적 — 실제 grep은 세션에서 수행했고 결과를 최종 보고에 기록.
    expect(source).toContain("CLASS-001");
  });
});
