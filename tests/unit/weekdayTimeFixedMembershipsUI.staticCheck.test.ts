/*
  Batch C UI 배선 — 체크아웃 선택 차단(C-9), 매니저 상품 설정 토글(C-3), 수강권 복제
  (C-15~C-17), 관리자 수동 발급 선택(C-10). 실제 치환/계산 로직은 이미 실제 함수 호출로
  검증했으므로(computeSelectableSchedule.test.ts 등) 여기서는 각 화면이 그 함수/상태를
  올바른 곳에 연결했는지만 소스 텍스트로 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const checkout = readFileSync(join(__dirname, "../../app/checkout/page.tsx"), "utf-8");
const membershipRules = readFileSync(join(__dirname, "../../app/manager/membership-rules/page.tsx"), "utf-8");
const members = readFileSync(join(__dirname, "../../app/manager/members/page.tsx"), "utf-8");

describe("C-9 — 체크아웃: 요일/시간 선택 없이는 결제를 막는다", () => {
  it("handlePay()가 weekdaySelectable 상품의 미선택을 막는다(직접결제/PG 결제 둘 다 이 체크를 거친 뒤 분기)", () => {
    const fn = checkout.slice(checkout.indexOf("async function handlePay()"), checkout.indexOf("async function handlePay()") + 1200);
    expect(fn).toContain("product.weekdaySelectable && selectedScheduleDay === null");
    expect(fn).toContain("이용할 요일을 선택해 주세요.");
    expect(fn).toContain("product.weekdaySelectable && product.timeSelectable && !selectedScheduleTime");
    expect(fn).toContain("이용할 시간을 선택해 주세요.");
  });

  it("두 결제 경로(직접결제/PG) 모두 selectedDayOfWeek/selectedStartTime을 createOrder에 넘긴다", () => {
    const occurrences = checkout.match(/selectedDayOfWeek: product\.weekdaySelectable \? selectedScheduleDay : undefined,/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("선택 후보는 fetchPurchaseScheduleOptions(기존 membership_schedule_rules 재사용)로 계산한다 — 새 API 없음", () => {
    expect(checkout).toContain("fetchPurchaseScheduleOptions(found.id)");
  });

  it("시간 선택 chip은 요일을 먼저 고른 뒤에만 나타난다(순서: 요일 → 시간)", () => {
    const start = checkout.indexOf("{product.weekdaySelectable && (");
    const end = checkout.indexOf("product.sizes && product.sizes.length > 0 && (", start);
    const block = checkout.slice(start, end);
    expect(block).toContain("product.timeSelectable && selectedScheduleDay !== null");
  });
});

describe("C-3 — 매니저 상품 설정: 구매 시 요일/시간 선택 토글", () => {
  it("weekdaySelectable/timeSelectable 상태가 createProduct/updateProduct 양쪽에 전달된다", () => {
    const fn = membershipRules.slice(membershipRules.indexOf("async function handleCreateProduct"), membershipRules.indexOf("async function handleDeleteProduct"));
    expect(fn).toContain("weekdaySelectable: pWeekdaySelectable");
    expect(fn).toContain("timeSelectable: pWeekdaySelectable && pTimeSelectable");
  });

  it("시간 선택 토글은 요일 선택이 꺼지면 같이 숨는다(의미 없는 조합 방지)", () => {
    const start = membershipRules.indexOf("시간도 함께 선택");
    const before = membershipRules.slice(Math.max(0, start - 200), start);
    expect(before).toContain("{pWeekdaySelectable && (");
  });

  it("선택 후보를 새로 입력받지 않고 기존 예약조건(rulesByProduct)에서 computeSelectableSchedule로 계산한다", () => {
    expect(membershipRules).toContain("computeSelectableSchedule(candidateRules)");
    expect(membershipRules).toContain("const candidateRules = editingId ? (rulesByProduct[editingId] ?? []) : [];");
  });
});

describe("C-15~C-17 — 수강권 복제", () => {
  it("openDuplicateSheet는 기존 수정 프리필을 재사용하고 editingId를 null로 바꿔 '새로 만들기' 경로를 태운다", () => {
    const fn = membershipRules.slice(membershipRules.indexOf("async function openDuplicateSheet"), membershipRules.indexOf("async function openDuplicateSheet") + 400);
    expect(fn).toContain("await openEditSheet(p);");
    expect(fn).toContain("setEditingId(null);");
    expect(fn).toContain("setDuplicateFromId(p.id);");
  });

  it("복제 시점엔 DB insert가 없다 — openDuplicateSheet에 await로 실제 생성 호출이 없음(저장 버튼을 눌러야 생성)", () => {
    const fn = membershipRules.slice(membershipRules.indexOf("async function openDuplicateSheet"), membershipRules.indexOf("async function openDuplicateSheet") + 400);
    expect(fn).not.toContain("createProduct(");
  });

  it("id/생성일/판매량은 복사하지 않는다 — 새 상품 이름에 원본 id를 그대로 쓰지 않고 새 createProduct insert를 그대로 탄다", () => {
    expect(membershipRules).toContain("setPName(`${p.name} 복제`);");
  });

  it("예약조건(membership_schedule_rules)도 원본에서 복사한다(C-16)", () => {
    const fn = membershipRules.slice(membershipRules.indexOf("if (duplicateFromId && made)"), membershipRules.indexOf("if (duplicateFromId && made)") + 400);
    expect(fn).toContain("rulesByProduct[duplicateFromId]");
    expect(fn).toContain("addRule(made.id, r.dayOfWeek, r.startTime, r.classTitle)");
  });

  it("시트 제목이 복제/수정/추가를 구분해서 보여준다", () => {
    expect(membershipRules).toContain('{duplicateFromId ? "수강권 복제" : editingId ? "수강권 수정" : "수강권 추가"}');
  });
});

describe("C-10 — 관리자 수동 발급도 요일/시간 선택 없이는 막는다(구매 플로우와 동일 원칙)", () => {
  it("handleGrant가 weekdaySelectable 상품의 미선택을 막는다", () => {
    const fn = members.slice(members.indexOf("async function handleGrant"), members.indexOf("async function handleGrant") + 1200);
    // 2026-10-01 — 검증은 lib/memberGrant.grantBlockReason(요일/시간/사이즈 공통, tests/unit/memberGrantProduct.test.ts에서 실제 실행)으로 모았다.
    expect(fn).toContain("grantBlockReason({ product, price: grantPrice, selectedSize: grantSize, scheduleDay: grantScheduleDay, scheduleTime: grantScheduleTime })");
    const lib = readFileSync(join(__dirname, "../../lib/memberGrant.ts"), "utf-8");
    expect(lib).toContain("product.kind !== \"goods\" && product.weekdaySelectable && input.scheduleDay === null");
    expect(lib).toContain("product.weekdaySelectable && product.timeSelectable && !input.scheduleTime");
  });

  it("grantProductToMember에 boundDayOfWeek/boundStartTime을 넘긴다", () => {
    const fn = members.slice(members.indexOf("await grantProductToMember({"), members.indexOf("await grantProductToMember({") + 500);
    expect(fn).toContain("boundDayOfWeek: product.kind !== \"goods\" && product.weekdaySelectable ? grantScheduleDay : undefined");
    expect(fn).toContain("boundStartTime: product.kind !== \"goods\" && product.weekdaySelectable && product.timeSelectable ? grantScheduleTime : undefined");
  });

  it("지급하기 버튼은 선택 미완료 시 비활성화된다", () => {
    const block = members.slice(members.indexOf('className="add-profile-actions">\n              <button className="ghost-btn" disabled={granting} onClick={() => setGrantTarget(null)}'), members.indexOf("지급 중..."));
    expect(block).toContain("grantBlockReason({");
    expect(block).toContain("scheduleDay: grantScheduleDay");
  });
});

describe("기존 상품/기존 memberships 호환(C-8) — 새 옵션을 켜지 않은 화면 동작은 그대로", () => {
  it("weekdaySelectable이 false면 체크아웃/발급 화면 어디에도 선택 UI가 뜨지 않는다(조건부 렌더)", () => {
    expect(checkout).toContain("{product.weekdaySelectable && (");
    expect(members).toContain("if (!product?.weekdaySelectable) return null;");
  });
});
