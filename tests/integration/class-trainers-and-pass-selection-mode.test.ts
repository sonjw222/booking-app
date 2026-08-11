/*
  담당 강사 복수 지정(class_trainers) + 수강권 허용 정책 변경(classes.pass_selection_mode) —
  add_class_trainers_pass_selection_mode_draft_proposed.sql 회귀 테스트.

  이 SQL이 아직 Supabase에 적용되지 않은 상태에서 실행하면:
  - pass_selection_mode 관련 테스트(컬럼 자체가 없음)와 스케줄 복사 테스트는 전부 실패한다
    (예상된 실패 — 최종 보고서 "SQL 필요 여부"에 기록).
  - class_trainers CRUD는 테이블 자체가 이미 라이브 DB에 존재하므로 통과해야 한다.
  - "센터 스태프가 아닌 계정을 담당 강사로 지정하면 거부된다" 테스트만 새 RLS 정책이
    필요해 실패한다(예상된 실패) — 나머지 class_trainers 테스트는 기존(느슨한) RLS로도 통과.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  fetchClasses, createClass, updateClassPassSelectionMode,
  fetchClassTrainers, setClassTrainers, setClassTrainersBulk,
  fetchClassProducts, setClassProducts,
  copyByDate, type CopyDateItem,
} from "../../lib/classes";
import { fetchMonthData } from "../../lib/reservations";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  getFixtureAdminClient,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

let managerA: TestUser;
let memberA: TestUser;
let centerAId: string;

const cleanupClassIds: string[] = [];

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asMemberA() { await switchToTestUser(MEMBER_A.email, MEMBER_A.password); }

// createClass()(관리자 UI가 실제 쓰는 함수)는 date/start/end 문자열을 받으므로, hoursFromNow
// 기반으로 그 형식을 만들어준다(createFutureTestClass의 KST 무관 raw insert와 달리, 여기선
// toKstIso 변환을 거치는 실제 저장 경로를 그대로 태워야 하기 때문).
function futureYmdHm(hoursFromNow: number): { date: string; start: string; end: string } {
  const startD = new Date(Date.now() + hoursFromNow * 3600 * 1000);
  const endD = new Date(startD.getTime() + 60 * 60 * 1000);
  const kst = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000);
  const ks = kst(startD);
  const ke = kst(endD);
  const date = `${ks.getUTCFullYear()}-${String(ks.getUTCMonth() + 1).padStart(2, "0")}-${String(ks.getUTCDate()).padStart(2, "0")}`;
  const start = `${String(ks.getUTCHours()).padStart(2, "0")}:${String(ks.getUTCMinutes()).padStart(2, "0")}`;
  const end = `${String(ke.getUTCHours()).padStart(2, "0")}:${String(ke.getUTCMinutes()).padStart(2, "0")}`;
  return { date, start, end };
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);
}, 30000);

afterAll(async () => {
  await asManagerA();
  for (const id of cleanupClassIds) {
    await supabase.from("reservations").delete().eq("class_id", id);
    await supabase.from("class_trainers").delete().eq("class_id", id);
    await supabase.from("class_allowed_products").delete().eq("class_id", id);
    await supabase.from("classes").delete().eq("id", id);
  }
  await signOutTestSession();
}, 30000);

beforeEach(async () => {
  await asManagerA();
});

describe("class_trainers: 담당 강사 복수 지정(lib/classes.ts)", () => {
  it("setClassTrainers로 지정한 강사가 fetchClassTrainers로 조회된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "강사배정-단건", hoursFromNow: 900 });
    cleanupClassIds.push(cls.id);
    await setClassTrainers(cls.id, [managerA.accountId]);
    expect(await fetchClassTrainers(cls.id)).toEqual([managerA.accountId]);
  });

  it("setClassTrainers를 다시 호출하면 이전 지정을 통째로 교체한다(빈 배열로 전원 해제 가능)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "강사배정-교체", hoursFromNow: 901 });
    cleanupClassIds.push(cls.id);
    await setClassTrainers(cls.id, [managerA.accountId]);
    expect(await fetchClassTrainers(cls.id)).toEqual([managerA.accountId]);
    await setClassTrainers(cls.id, []);
    expect(await fetchClassTrainers(cls.id)).toEqual([]);
  });

  it("setClassTrainersBulk로 여러 수업에 같은 강사 목록을 한 번에 지정할 수 있다", async () => {
    const cls1 = await createFutureTestClass(centerAId, { title: "강사배정-벌크1", hoursFromNow: 902 });
    const cls2 = await createFutureTestClass(centerAId, { title: "강사배정-벌크2", hoursFromNow: 903 });
    cleanupClassIds.push(cls1.id, cls2.id);
    await setClassTrainersBulk([cls1.id, cls2.id], [managerA.accountId]);
    expect(await fetchClassTrainers(cls1.id)).toEqual([managerA.accountId]);
    expect(await fetchClassTrainers(cls2.id)).toEqual([managerA.accountId]);
  });

  it("[신규 RLS] 그 센터의 active 스태프가 아닌 계정을 담당 강사로 지정하려 하면 거부된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "강사배정-RLS차단", hoursFromNow: 904 });
    cleanupClassIds.push(cls.id);
    // memberA는 회원 계정이지 centerA의 manager_centers 스태프가 아니다.
    const { error } = await supabase.from("class_trainers").insert({ class_id: cls.id, account_id: memberA.accountId });
    expect(error).not.toBeNull();
  });
});

describe("fetchMonthData()의 instructorNames — 회원 화면에 담당 강사 이름 노출", () => {
  it("담당 강사가 지정된 수업은 instructorNames에 이름이 채워진다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "강사노출-확인", hoursFromNow: 905 });
    cleanupClassIds.push(cls.id);
    await setClassTrainers(cls.id, [managerA.accountId]);

    const { data: acc } = await supabase.from("accounts").select("name").eq("id", managerA.accountId).maybeSingle();
    const expectedName = (acc as any)?.name;
    expect(expectedName).toBeTruthy();

    await asMemberA();
    const start = new Date(cls.startTime);
    const monthData = await fetchMonthData(start.getFullYear(), start.getMonth() + 1, memberA.accountId);
    const found = monthData.classes.find((c) => c.id === cls.id);
    expect(found).toBeDefined();
    expect(found!.instructorNames).toContain(expectedName);
  });

  it("담당 강사가 없는 수업은 instructorNames가 빈 배열이다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "강사노출-미지정", hoursFromNow: 906 });
    cleanupClassIds.push(cls.id);

    await asMemberA();
    const start = new Date(cls.startTime);
    const monthData = await fetchMonthData(start.getFullYear(), start.getMonth() + 1, memberA.accountId);
    const found = monthData.classes.find((c) => c.id === cls.id);
    expect(found).toBeDefined();
    expect(found!.instructorNames).toEqual([]);
  });
});

describe("classes.pass_selection_mode 저장/조회(lib/classes.ts) — 관리자 UI가 실제 쓰는 함수", () => {
  it("createClass에 passSelectionMode를 안 넘기면 기본값 'all'로 저장된다(대조군)", async () => {
    const { date, start, end } = futureYmdHm(24 * 40);
    const id = await createClass(centerAId, { title: "정책기본값", date, start, end, capacity: 8, allowGoods: true });
    cleanupClassIds.push(id);
    const list = await fetchClasses(centerAId, date, date);
    expect(list.find((c) => c.id === id)?.passSelectionMode).toBe("all");
  });

  it("createClass에 passSelectionMode: 'selected'를 넘기면 그대로 저장된다", async () => {
    const { date, start, end } = futureYmdHm(24 * 41);
    const id = await createClass(centerAId, {
      title: "정책선택", date, start, end, capacity: 8, allowGoods: true, passSelectionMode: "selected",
    });
    cleanupClassIds.push(id);
    const list = await fetchClasses(centerAId, date, date);
    expect(list.find((c) => c.id === id)?.passSelectionMode).toBe("selected");
  });

  it("updateClassPassSelectionMode()는 다른 필드를 건드리지 않고 정책 컬럼만 바꾼다(반복 그룹 일괄적용 경로용 좁은 setter)", async () => {
    const { date, start, end } = futureYmdHm(24 * 42);
    const id = await createClass(centerAId, { title: "정책단독변경", date, start, end, capacity: 8, allowGoods: true });
    cleanupClassIds.push(id);
    await updateClassPassSelectionMode(id, "selected");
    const list = await fetchClasses(centerAId, date, date);
    const found = list.find((c) => c.id === id);
    expect(found?.passSelectionMode).toBe("selected");
    expect(found?.title).toBe("정책단독변경");
    expect(found?.start).toBe(start);
  });
});

describe("copyByDate(): 스케줄 복사 시 수강권 정책·담당 강사도 함께 복사된다", () => {
  it("selected 모드 + 특정 수강권 + 담당 강사가 지정된 수업을 복사하면 새 수업에 그대로 반영된다", async () => {
    const admin = getFixtureAdminClient();
    const { data: existingProduct } = await admin
      .from("products").select("id").eq("center_id", centerAId).eq("product_kind", "pass").limit(1).maybeSingle();
    let productId = (existingProduct as any)?.id as string | undefined;
    if (!productId) {
      const { data, error } = await admin.from("products").insert({
        center_id: centerAId, name: "강사복사테스트-패스", product_kind: "pass", pass_type: "count",
        total_count: 999, is_on_sale: true, is_active: true,
      }).select("id").single();
      if (error || !data) throw new Error(`상품 생성 실패: ${error?.message ?? "no data"}`);
      productId = data.id;
    }
    if (!productId) throw new Error("테스트용 pass 상품을 찾거나 만들지 못했어요");

    const { date: srcDate, start, end } = futureYmdHm(24 * 45);
    const srcId = await createClass(centerAId, {
      title: "강사복사-원본", date: srcDate, start, end, capacity: 8, allowGoods: true, passSelectionMode: "selected",
    });
    cleanupClassIds.push(srcId);
    await setClassProducts(srcId, [productId]);
    await setClassTrainers(srcId, [managerA.accountId]);

    const [ty, tm, td] = srcDate.split("-").map(Number);
    // 원본보다 1년 뒤 같은 달/일로 복사 — 휴무일이 있더라도 같은 날짜라 원본 생성 시점에
    // 이미 그 날짜가 유효했다는 사실과 독립적으로, 공유 테스트센터에 등록된 휴무일과
    // 우연히 겹칠 여지를 최소화하기 위해 아주 먼 미래를 그대로 유지한다.
    const toMonth = `${ty + 1}-${String(tm).padStart(2, "0")}`;
    const item: CopyDateItem = {
      key: "k1", title: "강사복사-원본", date: srcDate, day: td, start, end, capacity: 8,
      roomId: null, cancelDeadlineMin: 0, classId: srcId,
    };
    const created = await copyByDate(centerAId, toMonth, [item]);
    expect(created).toBe(1);

    const toDate = `${toMonth}-${String(td).padStart(2, "0")}`;
    const list = await fetchClasses(centerAId, toDate, toDate);
    const copied = list.find((c) => c.title === "강사복사-원본" && c.id !== srcId);
    expect(copied).toBeDefined();
    cleanupClassIds.push(copied!.id);

    expect(copied!.passSelectionMode).toBe("selected");
    expect(await fetchClassProducts(copied!.id)).toEqual([productId]);
    expect(await fetchClassTrainers(copied!.id)).toEqual([managerA.accountId]);
  });
});
