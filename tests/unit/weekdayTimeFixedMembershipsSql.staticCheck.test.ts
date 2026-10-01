/*
  add_weekday_time_fixed_memberships.sql (Batch C) — 서버 쪽 강제(C-7)가 다섯 함수에 들어갔는지,
  기존 조건을 지우지 않고 AND로만 추가했는지 검증한다. 프로덕션 DB가 없는 환경이라 SQL을
  실행하지 않고 소스 텍스트로 확인한다(이 프로젝트 기존 관례).

  [2026-10-01 재작성] 이 파일의 첫 버전은 저장소의 옛 migration 파일을 기준으로 함수를 다시 써서
  라이브 DB와 어긋났다(실행 시 42P13: usable_memberships_for_classes에 라이브에만 있던
  issued_at 반환 컬럼 누락. 그대로 적용됐다면 쿠폰 검증/사용 처리, 구매 자격 재검증,
  pass_selection_mode 정책이 옛 버전으로 되돌아갔을 것). 그래서 지금은 라이브 DB에서 읽은
  실제 정의를 기준으로 추가분만 넣었고, 아래 "라이브 로직 보존" 검사가 그 회귀를 막는다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../add_weekday_time_fixed_memberships.sql"), "utf-8");
const rollback = readFileSync(join(__dirname, "../../rollback_add_weekday_time_fixed_memberships.sql"), "utf-8");

// pg_get_functiondef 형식("CREATE OR REPLACE FUNCTION public.<name>( ... $function$;")으로 한 함수 블록을 뽑는다.
function fnBlock(text: string, name: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} 정의가 있어야 함`).toBeGreaterThan(-1);
  const end = text.indexOf("$function$;", text.indexOf("AS $function$", start) + 5);
  return text.slice(start, end + "$function$;".length);
}
const stripComments = (s: string) => s.replace(/--.*$/gm, "");

const FIVE = [
  "is_membership_eligible_for_class", "usable_memberships", "usable_memberships_for_classes",
  "fulfill_order", "_issue_membership_and_record_payment",
];

describe("[1][2][3] 새 컬럼 — nullable/기본 false라 기존 동작을 안 바꿈(C-8)", () => {
  it("products.weekday_selectable/time_selectable은 not null default false", () => {
    expect(sql).toContain("alter table products add column if not exists weekday_selectable boolean not null default false;");
    expect(sql).toContain("alter table products add column if not exists time_selectable boolean not null default false;");
  });

  it("orders/memberships의 요일·시간 컬럼은 전부 nullable(null = 제한 없음)", () => {
    expect(sql).toContain("alter table orders add column if not exists selected_day_of_week int;");
    expect(sql).toContain("alter table orders add column if not exists selected_start_time time;");
    expect(sql).toContain("alter table memberships add column if not exists bound_day_of_week int;");
    expect(sql).toContain("alter table memberships add column if not exists bound_start_time time;");
    expect(sql).not.toMatch(/bound_day_of_week int not null/);
    expect(sql).not.toMatch(/bound_start_time time not null/);
  });
});

describe("[4] C-7 — is_membership_eligible_for_class()에 새 AND 조건, 기존 조건은 그대로", () => {
  const fn = fnBlock(sql, "is_membership_eligible_for_class");
  const code = stripComments(fn);

  it("기존 class_allowed_products/pass_selection_mode, membership_schedule_rules 조건이 남아있다", () => {
    expect(code).toContain("c.pass_selection_mode = 'all'");
    expect(code).toContain("c.pass_selection_mode = 'selected'");
    expect(code).toContain("membership_schedule_rules r");
    expect(code).toContain("r.day_of_week is null or r.day_of_week = extract(dow from");
  });

  it("새 조건이 AND로 추가됐다(OR로 느슨해지지 않음)", () => {
    expect(code).toMatch(/\)\s*and\s*\(\s*m\.bound_day_of_week is null/);
    expect(code).toContain("m.bound_day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int");
    expect(code).toMatch(/and\s*\(\s*m\.bound_start_time is null/);
    expect(code).toContain("m.bound_start_time = (c.start_time at time zone 'Asia/Seoul')::time");
  });

  it("보안 속성(SECURITY DEFINER, search_path public)이 라이브 그대로 유지된다", () => {
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("SET search_path TO 'public'");
  });
});

describe("[5] 화면 표시용 함수도 같은 조건 — 화면 목록과 실제 예약 허용 여부가 어긋나지 않음", () => {
  it("usable_memberships()", () => {
    const fn = fnBlock(sql, "usable_memberships");
    expect(fn).toContain("m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow");
    expect(fn).toContain("m.bound_start_time is null or m.bound_start_time = cls.ltime");
  });

  it("usable_memberships_for_classes()", () => {
    const fn = fnBlock(sql, "usable_memberships_for_classes");
    expect(fn).toContain("m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow");
    expect(fn).toContain("m.bound_start_time is null or m.bound_start_time = cls.ltime");
  });
});

describe("[6] 두 발급 경로 모두 선택값을 memberships로 복사한다", () => {
  it("fulfill_order()", () => {
    const fn = fnBlock(sql, "fulfill_order");
    expect(fn).toContain("bound_day_of_week, bound_start_time");
    expect(fn).toContain("v_order.selected_day_of_week, v_order.selected_start_time");
  });

  it("_issue_membership_and_record_payment()", () => {
    const fn = fnBlock(sql, "_issue_membership_and_record_payment");
    expect(fn).toContain("bound_day_of_week, bound_start_time");
    expect(fn).toContain("p_order.selected_day_of_week, p_order.selected_start_time");
  });
});

describe("라이브 로직 보존 — 옛 migration 파일 기준으로 되돌리는 회귀 방지(42P13/쿠폰 소실 사고)", () => {
  it("usable_memberships_for_classes는 라이브 반환 컬럼 issued_at과 starts_at 조건, pass_selection_mode를 유지한다", () => {
    const fn = fnBlock(sql, "usable_memberships_for_classes");
    expect(fn).toContain("is_mine boolean, issued_at date)");
    expect(fn).toContain("m.issued_at");
    expect(fn).toContain("(m.starts_at is null or m.starts_at <= current_date)");
    expect(fn).toContain("cls.pass_selection_mode = 'all'");
  });

  it("usable_memberships는 pass_selection_mode 정책(허용 수강권 'all'/'selected')을 유지한다", () => {
    const fn = fnBlock(sql, "usable_memberships");
    expect(fn).toContain("cls.pass_selection_mode = 'all'");
    expect(fn).toContain("cls.pass_selection_mode = 'selected'");
  });

  it("_issue_membership_and_record_payment는 쿠폰 검증/사용 처리, 구매 자격 재검증, payments.order_id를 유지한다", () => {
    const fn = fnBlock(sql, "_issue_membership_and_record_payment");
    expect(fn).toContain("member_can_purchase_product(p_order.product_id, p_order.profile_id)");
    expect(fn).toContain("p_order.member_coupon_id is not null");
    expect(fn).toContain("set status = 'used', used_at = now(), order_id = p_order.id");
    expect(fn).toContain("center_id, profile_id, membership_id, order_id,");
    expect(fn).toContain("coupon_eligible");
    expect(fn).toContain("v_expected_amount");
    expect(fn).toContain("calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day)");
  });

  it("fulfill_order는 권한 체크/금액 검증/auto_book/rolling_month 계산을 유지한다", () => {
    const fn = fnBlock(sql, "fulfill_order");
    expect(fn).toContain("has_permission(v_order.center_id, 'pass.payment.create')");
    expect(fn).toContain("auto_book_membership(v_membership_id)");
    expect(fn).toContain("calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day)");
  });

  it("라이브에 없던 보안 속성을 임의로 바꾸지 않았다(_issue_membership_and_record_payment는 search_path 미지정 그대로)", () => {
    expect(fnBlock(sql, "_issue_membership_and_record_payment")).not.toContain("search_path");
  });

  it("옛 소문자 스타일('create or replace function usable_memberships' 등)로 다시 쓴 흔적이 없다", () => {
    expect(sql).not.toMatch(/create or replace function (usable_memberships|fulfill_order|_issue_membership)/);
  });
});

describe("C-12 — 귀속 값은 특정 class 행에 FK로 묶이지 않는다(수업 삭제와 무관)", () => {
  it("memberships 컬럼 정의에 references classes(...)가 없다", () => {
    const block = sql.slice(sql.indexOf("alter table memberships add column if not exists bound_day_of_week"), sql.indexOf("-- [4]"));
    expect(block).not.toMatch(/references classes/);
  });
});

describe("롤백 파일 — 다섯 함수를 '적용 전 라이브 정의'로 되돌리고 컬럼 삭제는 기본 비활성", () => {
  it("다섯 함수 모두 복원하고 어느 것에도 bound_day_of_week가 없다", () => {
    for (const n of FIVE) expect(stripComments(fnBlock(rollback, n))).not.toContain("bound_day_of_week");
  });

  it("라이브 로직(issued_at, 쿠폰 처리)을 포함한 정의로 복원한다", () => {
    expect(fnBlock(rollback, "usable_memberships_for_classes")).toContain("issued_at");
    expect(fnBlock(rollback, "_issue_membership_and_record_payment")).toContain("member_coupon_id");
  });

  it("컬럼 DROP 문은 주석 처리돼 기본적으로 실행되지 않는다", () => {
    expect(rollback).toContain("-- alter table memberships drop column if exists bound_day_of_week;");
  });
});
