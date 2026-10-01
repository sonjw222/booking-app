/*
  add_weekday_time_fixed_memberships.sql (Batch C) — 서버 쪽 강제(C-7)가 실제로 세 함수
  모두에 들어갔는지, 기존 조건을 지우지 않고 AND로만 추가했는지, 두 발급 경로
  (fulfill_order/_issue_membership_and_record_payment) 모두 선택값을 복사하는지 검증한다.
  프로덕션 DB가 없는 이 환경에서는 SQL을 실행할 수 없어(이 프로젝트 기존 관례) 소스
  텍스트로 확인한다 — 실제 동작 확인은 마이그레이션 적용 후 integration 테스트/QA로.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../add_weekday_time_fixed_memberships.sql"), "utf-8");
const rollback = readFileSync(join(__dirname, "../../rollback_add_weekday_time_fixed_memberships.sql"), "utf-8");

describe("[1][2][3] 새 컬럼 — nullable, 기본값이 기존 동작을 안 바꿈(C-8)", () => {
  it("products.weekday_selectable/time_selectable은 not null default false", () => {
    expect(sql).toContain("alter table products add column if not exists weekday_selectable boolean not null default false;");
    expect(sql).toContain("alter table products add column if not exists time_selectable boolean not null default false;");
  });

  it("orders/memberships의 요일·시간 컬럼은 전부 nullable(기본 null = 제한 없음)", () => {
    expect(sql).toContain("alter table orders add column if not exists selected_day_of_week int;");
    expect(sql).toContain("alter table orders add column if not exists selected_start_time time;");
    expect(sql).toContain("alter table memberships add column if not exists bound_day_of_week int;");
    expect(sql).toContain("alter table memberships add column if not exists bound_start_time time;");
    // not null이 아님을 확인 — "int;"/"time;"으로 끝나야 하고 not null이 붙으면 안 됨
    expect(sql).not.toMatch(/bound_day_of_week int not null/);
    expect(sql).not.toMatch(/bound_start_time time not null/);
  });
});

describe("[4] C-7 — is_membership_eligible_for_class()에 새 AND 조건이 추가되고 기존 조건은 그대로", () => {
  const fn = sql.slice(
    sql.indexOf("create or replace function is_membership_eligible_for_class"),
    sql.indexOf("-- [5]")
  );

  it("기존 class_allowed_products/pass_selection_mode 조건이 그대로 남아있다(삭제 안 됨)", () => {
    expect(fn).toContain("c.pass_selection_mode = 'all'");
    expect(fn).toContain("c.pass_selection_mode = 'selected'");
  });

  it("기존 membership_schedule_rules 조건이 그대로 남아있다", () => {
    expect(fn).toContain("membership_schedule_rules r");
    expect(fn).toContain("r.day_of_week is null or r.day_of_week = extract(dow from");
  });

  it("새 bound_day_of_week/bound_start_time 조건이 AND로 추가됐다(OR로 느슨해지지 않음)", () => {
    // 주석 제거 후 검사 — "and (" 바로 다음이 새 조건이어야 한다(괄호 블록을 or로 잇지 않음).
    const code = fn.replace(/--.*$/gm, "");
    expect(code).toMatch(/\)\s*and\s*\(\s*m\.bound_day_of_week is null/);
    expect(code).toContain("m.bound_day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int");
    expect(code).toMatch(/and\s*\(\s*m\.bound_start_time is null/);
    expect(code).toContain("m.bound_start_time = (c.start_time at time zone 'Asia/Seoul')::time");
  });

  it("보안 속성(security definer, set search_path = public)이 유지된다", () => {
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public");
  });
});

describe("[5] 화면 표시용 함수(usable_memberships/usable_memberships_for_classes)도 같은 조건을 받는다 — 화면과 실제 예약 허용 여부가 어긋나지 않음", () => {
  it("usable_memberships()에 bound_day_of_week/bound_start_time 조건이 추가됐다", () => {
    const fn = sql.slice(sql.indexOf("create or replace function usable_memberships(p_class_id"), sql.indexOf("create or replace function usable_memberships_for_classes"));
    expect(fn).toContain("m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow");
    expect(fn).toContain("m.bound_start_time is null or m.bound_start_time = cls.ltime");
  });

  it("usable_memberships_for_classes()에도 동일 조건이 추가됐다", () => {
    const fn = sql.slice(sql.indexOf("create or replace function usable_memberships_for_classes"), sql.indexOf("-- [6]"));
    expect(fn).toContain("m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow");
    expect(fn).toContain("m.bound_start_time is null or m.bound_start_time = cls.ltime");
  });
});

describe("[6] 주문 → 수강권 발급 두 경로(fulfill_order/_issue_membership_and_record_payment) 모두 선택값을 복사한다", () => {
  it("fulfill_order()가 memberships insert에 bound_day_of_week/bound_start_time 컬럼을 포함하고 orders의 선택값을 그대로 넣는다", () => {
    const fn = sql.slice(sql.indexOf("create or replace function fulfill_order"), sql.indexOf("create or replace function _issue_membership_and_record_payment"));
    expect(fn).toContain("bound_day_of_week, bound_start_time");
    expect(fn).toContain("v_order.selected_day_of_week, v_order.selected_start_time");
  });

  it("_issue_membership_and_record_payment()도 동일하게 복사한다", () => {
    const fn = sql.slice(sql.indexOf("create or replace function _issue_membership_and_record_payment"), sql.length);
    expect(fn).toContain("bound_day_of_week, bound_start_time");
    expect(fn).toContain("p_order.selected_day_of_week, p_order.selected_start_time");
  });

  it("두 함수 모두 나머지 기존 로직(운영설정 가드, 쿠폰/포인트 검증, rolling_month 계산)은 그대로다(회귀 없음)", () => {
    const f1 = sql.slice(sql.indexOf("create or replace function fulfill_order"), sql.indexOf("create or replace function _issue_membership_and_record_payment"));
    expect(f1).toContain("has_permission(v_order.center_id, 'pass.payment.create')");
    expect(f1).toContain("calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day)");
    const f2 = sql.slice(sql.indexOf("create or replace function _issue_membership_and_record_payment"), sql.length);
    expect(f2).toContain("v_verified_discount := case p_order.coupon_code");
    expect(f2).toContain("point_transactions");
  });
});

describe("C-12 — bound_day_of_week/bound_start_time은 특정 class 행에 FK로 묶이지 않는다(수업 삭제와 무관)", () => {
  it("memberships 컬럼 정의에 references classes(...) 같은 FK가 없다(순수 값 저장, 자동 변경 없음)", () => {
    const block = sql.slice(sql.indexOf("alter table memberships add column if not exists bound_day_of_week"), sql.indexOf("-- [4]"));
    expect(block).not.toMatch(/references classes/);
  });
});

describe("롤백 파일 — 세 함수 모두 새 조건 없이 이전 정의로 되돌리고, 컬럼 삭제는 기본 비활성", () => {
  it("is_membership_eligible_for_class 롤백 정의에는 bound_day_of_week 조건이 없다", () => {
    const fn = rollback.slice(rollback.indexOf("create or replace function is_membership_eligible_for_class"), rollback.indexOf("create or replace function usable_memberships"));
    expect(fn).not.toContain("bound_day_of_week");
  });

  it("컬럼 DROP 문은 주석 처리돼 기본적으로 실행되지 않는다", () => {
    expect(rollback).toContain("-- alter table memberships drop column if exists bound_day_of_week;");
  });
});
