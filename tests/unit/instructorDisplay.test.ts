/*
  담당 강사 표시 UI 수동 QA 발견사항 회귀 테스트(2026-08-12) — 순수 포맷 로직만 검증.

  회원 화면(app/reservation/page.tsx)과 관리자 목록(app/manager/classes/page.tsx)에
  중복돼 있던 동일 포맷 로직을 lib/instructorDisplay.ts로 추출했다. "강사 복수" 케이스는
  실제 DB에 서로 다른 계정 3명을 class_trainers로 넣어야 하는데, 그 INSERT는 RLS로
  보호돼 있어(class_trainers "매니저 강사 생성" 정책 — 그 센터 active 스태프만 대상 허용)
  service_role 관리자 클라이언트로 직접 넣을 수 없다(실측: "permission denied for table
  class_trainers", 서비스 롤에 이 테이블 GRANT가 아예 없음 — class_allowed_products와
  같은 계열의 기존 gap). 실제 계정 3명을 준비하려면 새 스태프 계정을 만들고 관리자 UI로
  하나씩 지정해야 해 이 순수 표시 문제 수정 범위에 비해 과하다 — 대신 포맷 함수 자체를
  여기서 결정적으로 검증하고, E2E(tests/e2e/reservation/class-trainer-display.spec.ts)는
  실제 DB 라운드트립이 안전한 단일 강사/강사 없음 케이스만 다룬다.
*/
import { describe, expect, it } from "vitest";
import { formatInstructorNames } from "../../lib/instructorDisplay";

describe("formatInstructorNames()", () => {
  it("강사가 없으면 null을 반환한다(구분자 없이 생략하기 위함)", () => {
    expect(formatInstructorNames([])).toBeNull();
  });

  it("강사가 1명이면 이름 그대로 반환한다", () => {
    expect(formatInstructorNames(["김이이"])).toBe("김이이");
  });

  it("강사가 2명이면 ' · '로 이어붙인다(기존 임계값 유지)", () => {
    expect(formatInstructorNames(["김이이", "박이이"])).toBe("김이이 · 박이이");
  });

  it("강사가 3명 이상이면 '첫 이름 외 N명' 형태로 줄인다(기존 임계값 유지)", () => {
    expect(formatInstructorNames(["김이이", "박이이", "최이이"])).toBe("김이이 외 2명");
    expect(formatInstructorNames(["김이이", "박이이", "최이이", "이이이"])).toBe("김이이 외 3명");
  });
});
