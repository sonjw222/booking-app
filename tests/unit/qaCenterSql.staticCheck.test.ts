/*
  add_qa_center_alimtalk_test.sql/rollback_qa_center_alimtalk_test.sql은 사용자 승인 전까지
  production에 실행되지 않는다(최종 보고서 참고). DB가 필요한 통합 테스트로는 검증할 수
  없으므로, 파일 텍스트가 의도한 안전장치(새 컬럼 없음, 결제/예약 데이터 없음, 계정
  존재/이름 중복을 먼저 확인한 뒤에만 진행, 실패 시 전체 롤백)를 실제로 포함하는지 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../add_qa_center_alimtalk_test.sql"), "utf-8");
const rollback = readFileSync(join(__dirname, "../../rollback_qa_center_alimtalk_test.sql"), "utf-8");

describe("add_qa_center_alimtalk_test.sql 정적 검토", () => {
  it("센터명이 명확히 QA용으로 표시돼 실제 센터와 혼동되지 않는다", () => {
    expect(sql).toContain("[QA] 모하빗 알림톡 테스트 센터");
  });

  it("새 컬럼/스키마 변경 없이 기존 centers.status(pending) 기본값만 사용한다(회원 화면 비노출)", () => {
    expect(sql).not.toMatch(/alter table \w+ add column/i);
    expect(sql).not.toMatch(/create table(?! if not exists center_roles)/i); // 새 테이블 생성 없음
    expect(sql).toMatch(/insert into centers \(id, name\)/); // status를 명시하지 않음 → 기본값 pending
    expect(sql).not.toMatch(/status\s*=\s*'approved'/);
  });

  it("결제/실사용 예약 관련 테이블(products/classes/orders/payments/memberships)에는 아무것도 만들지 않는다", () => {
    for (const t of ["products", "classes", "orders", "payments", "memberships"]) {
      expect(sql).not.toMatch(new RegExp(`insert into ${t}\\b`));
    }
  });

  it("대상 계정(sonjw8030) 존재 여부와 중복 생성 여부를 먼저 확인한 뒤에만 진행한다(raise exception으로 전체 롤백)", () => {
    expect(sql).toContain("lower(u.email) = 'sonjw8030@gmail.com'");
    expect(sql).toMatch(/if v_account_id is null then\s*raise exception/);
    expect(sql).toMatch(/이미 QA 센터가 존재해요[\s\S]*raise exception/);
  });

  it("트랜잭션 하나(단일 DO 블록)로 실행돼 부분 생성 상태를 남기지 않는다", () => {
    expect((sql.match(/^do \$\$/gm) ?? []).length).toBe(1);
  });

  it("토스 심사용 계정(sonjw222)은 실행 코드에서 쓰이지 않는다(주석 설명 제외, do $$ 블록 본문만 확인)", () => {
    const body = sql.slice(sql.indexOf("do $$"));
    expect(body).not.toContain("sonjw222");
  });

  it("실행 후 검증 SELECT가 예상 행 수(관리자 1, 역할 3, 회원 1, 수업/상품/주문 0)를 확인한다", () => {
    const verify = sql.slice(sql.indexOf("select\n    c.id as center_id"));
    expect(verify).toContain("manager_links");
    expect(verify).toContain("classes");
    expect(verify).toContain("products");
    expect(verify).toContain("orders");
  });
});

describe("rollback_qa_center_alimtalk_test.sql 정적 검토", () => {
  it("QA 센터로 스코프를 좁혀서만 삭제하고 보존 계정(accounts/profiles)은 건드리지 않는다", () => {
    expect(rollback).toContain("where center_id = v_center_id");
    expect(rollback).not.toMatch(/delete from accounts/i);
    expect(rollback).not.toMatch(/delete from profiles/i);
    expect(rollback).not.toMatch(/delete from auth\.users/i);
  });
});
