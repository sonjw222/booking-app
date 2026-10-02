/*
  토스페이먼츠 전자결제 심사 준비(2026-10-01) — 공개 판매상품/사업자 표시/약관 정정.
  1) BUSINESS_INFO(상호=모하빗, 대표자=손장욱 구분)
  2) fetchCenterProducts의 로그인/비로그인 분기(실제 호출, supabase 목)
  3) 공개 RPC SQL 계약(승인 센터·활성·판매중·전체공개만, 최소 컬럼, 권한)
  4) 홈 footer, 공개 /products 페이지, legal 문구
  SQL은 프로덕션 DB 없이 실행할 수 없어 소스 텍스트로 계약을 검증한다(이 프로젝트 기존 관례).
  실제 anon 동작은 SQL 적용 후 PostgREST로 재확인(최종 보고 QA 항목).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const stripSqlComments = (s: string) => s.replace(/--.*$/gm, "");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("1. BUSINESS_INFO — 상호와 대표자를 구분", () => {
  it("serviceName/companyName=모하빗, ceoName=손장욱", async () => {
    const { BUSINESS_INFO } = await import("../../lib/businessInfo");
    expect(BUSINESS_INFO.serviceName).toBe("모하빗");
    expect(BUSINESS_INFO.companyName).toBe("모하빗");
    expect(BUSINESS_INFO.ceoName).toBe("손장욱");
    expect(BUSINESS_INFO.businessRegNo).toBe("589-77-00451");
    expect(BUSINESS_INFO.mailOrderRegNo).toBe("제2026-성남분당B-0866호");
  });

  it("사업자 정보 페이지는 같은 BUSINESS_INFO를 그대로 쓴다(별도 하드코딩 없음)", () => {
    const src = stripComments(read("app/legal/business/page.tsx"));
    expect(src).toContain("BUSINESS_INFO.serviceName");
    expect(src).toContain("BUSINESS_INFO.companyName");
    expect(src).toContain("BUSINESS_INFO.ceoName");
    expect(src).not.toMatch(/>\s*(모하빗|손장욱)\s*</);
  });
});

describe("2. fetchCenterProducts — 비로그인은 공개 RPC, 로그인은 기존 회원 RPC", () => {
  const publicRows = [
    { id: "p1", center_id: "c1", center_name: "A센터", name: "10회권", price: 100000, product_kind: "pass",
      description: "설명", total_count: 10, unlimited: false, unlimited_pass: false, group_label: null, remaining: null },
  ];
  const memberRows = [
    { id: "m1", name: "회원전용권", price: 50000, product_kind: "pass", total_count: 5, unlimited: false,
      description: null, sizes: null, auto_book_days: null, group_label: null, max_quantity: null, coupon_eligible: true },
  ];
  let session: unknown;
  let rpcCalls: string[];
  let memberError: { code: string; message: string } | null;

  beforeEach(() => {
    vi.resetModules();
    rpcCalls = [];
    memberError = null;
    session = null;
    vi.doMock("../../lib/supabaseClient", () => ({
      supabase: {
        auth: { getSession: () => Promise.resolve({ data: { session } }) },
        rpc: (name: string) => {
          rpcCalls.push(name);
          if (name === "fetch_public_storefront_products") return Promise.resolve({ data: publicRows, error: null });
          return { select: () => Promise.resolve(memberError ? { data: null, error: memberError } : { data: memberRows, error: null }) };
        },
        from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }),
      },
    }));
    vi.doMock("../../lib/authAccount", () => ({ getMyAccountId: () => Promise.resolve(null) }));
  });

  it("비로그인: 공개 RPC만 호출하고 회원 RPC는 호출하지 않는다", async () => {
    const { fetchCenterProducts } = await import("../../lib/center");
    const products = await fetchCenterProducts("c1");
    expect(rpcCalls).toEqual(["fetch_public_storefront_products"]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ id: "p1", name: "10회권", price: 100000, kind: "pass", totalCount: 10, couponEligible: true, sizes: null });
  });

  it("로그인: 기존 fetch_purchasable_products(회원별 구매 가능 상품)만 호출한다(공개 RPC 미사용)", async () => {
    session = { user: { id: "u1" } };
    const { fetchCenterProducts } = await import("../../lib/center");
    const products = await fetchCenterProducts("c1");
    expect(rpcCalls).toEqual(["fetch_purchasable_products"]);
    expect(products[0].name).toBe("회원전용권");
  });

  it("로그인했지만 토큰 만료로 회원 RPC가 권한 오류(42501)면 공개 목록으로 대체한다", async () => {
    session = { user: { id: "u1" } };
    memberError = { code: "42501", message: "permission denied for function fetch_purchasable_products" };
    const { fetchCenterProducts } = await import("../../lib/center");
    const products = await fetchCenterProducts("c1");
    expect(rpcCalls).toEqual(["fetch_purchasable_products", "fetch_public_storefront_products"]);
    expect(products[0].name).toBe("10회권");
  });

  it("로그인 상태의 그 외 오류는 공개 목록으로 숨기지 않고 그대로 던진다", async () => {
    session = { user: { id: "u1" } };
    memberError = { code: "XX000", message: "boom" };
    const { fetchCenterProducts } = await import("../../lib/center");
    await expect(fetchCenterProducts("c1")).rejects.toThrow("상품을 불러오지 못했어요");
    expect(rpcCalls).toEqual(["fetch_purchasable_products"]);
  });

  it("groupPublicProductsByCenter: 센터별로 묶고 순서를 유지하며 빈 그룹을 만들지 않는다", async () => {
    const { groupPublicProductsByCenter } = await import("../../lib/center");
    const mk = (id: string, centerId: string, centerName: string) => ({
      id, centerId, centerName, name: id, price: 1, kind: "pass" as const, description: null,
      totalCount: null, unlimited: false, unlimitedPass: false, groupLabel: null, remaining: null,
    });
    const groups = groupPublicProductsByCenter([mk("a", "c1", "A"), mk("b", "c1", "A"), mk("c", "c2", "B")]);
    expect(groups.map((g) => [g.centerName, g.items.length])).toEqual([["A", 2], ["B", 1]]);
    expect(groupPublicProductsByCenter([])).toEqual([]);
  });
});

describe("3. 공개 RPC SQL 계약 — add_public_storefront_products.sql", () => {
  const sql = read("add_public_storefront_products.sql");
  const code = stripSqlComments(sql);
  const fn = code.slice(code.indexOf("create or replace function fetch_public_storefront_products"), code.indexOf("comment on function"));

  it("공개 조건 4개를 모두 AND로 요구한다(승인 센터·활성·판매중·전체공개)", () => {
    expect(fn).toContain("c.status = 'approved'");
    expect(fn).toMatch(/and p\.is_active\b/);
    expect(fn).toMatch(/and p\.is_on_sale\b/);
    expect(fn).toContain("p.visibility_type = 'all'");
    expect(fn).not.toMatch(/\bor\b[^\n]*visibility_type/); // 공개 범위를 OR로 넓히지 않는다
  });

  it("등급 전용/지정 회원 전용 상품 테이블을 아예 참조하지 않는다(회원별 판정 경로와 분리)", () => {
    expect(fn).not.toContain("membership_product_grades");
    expect(fn).not.toContain("membership_product_members");
    expect(fn).not.toContain("my_profile_ids");
  });

  it("SECURITY DEFINER + set search_path = public 패턴을 지킨다", () => {
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public");
  });

  it("반환 컬럼은 최소 공개 필드뿐이다(회원/연락처/매출/내부 정보 없음)", () => {
    const returns = fn.slice(fn.indexOf("returns table"), fn.indexOf("language sql"));
    for (const col of ["id", "center_id", "center_name", "name", "price", "product_kind", "description", "total_count", "unlimited", "unlimited_pass", "group_label", "remaining"]) {
      expect(returns).toMatch(new RegExp(`\\b${col}\\b`));
    }
    for (const forbidden of ["phone", "email", "account", "profile", "owner", "sales", "revenue", "billing", "visibility", "address"]) {
      expect(returns).not.toContain(forbidden);
    }
  });

  it("남은 수량은 product_sale_counts 뷰(authenticated 전용)를 anon에게 열지 않고 함수 안에서 계산한다", () => {
    expect(fn).toContain("m.status <> 'refunded'");
    expect(code).not.toMatch(/grant select on product_sale_counts/i);
  });

  it("anon/authenticated execute를 명시적으로 관리한다(PUBLIC은 revoke)", () => {
    expect(code).toContain("revoke all on function fetch_public_storefront_products(uuid) from public;");
    expect(code).toContain("grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;");
  });

  it("기존 회원용 fetch_purchasable_products는 수정/권한 변경하지 않는다", () => {
    expect(code).not.toMatch(/create or replace function fetch_purchasable_products/);
    expect(code).not.toMatch(/grant execute on function fetch_purchasable_products/);
    expect(code).not.toMatch(/alter function fetch_purchasable_products/);
  });

  it("롤백은 공개 RPC만 제거한다", () => {
    const rb = stripSqlComments(read("rollback_add_public_storefront_products.sql")).trim();
    expect(rb).toBe("drop function if exists fetch_public_storefront_products(uuid);");
  });
});

describe("4. 홈 footer — 사업자 정보 직접 표시", () => {
  const home = stripComments(read("app/page.tsx"));
  const footer = home.slice(home.indexOf('<div className="home-footer">'));

  it("상호·대표자·사업자등록번호·통신판매업 신고번호·고객센터를 BUSINESS_INFO에서 표시한다", () => {
    expect(footer).toContain("{BUSINESS_INFO.companyName} · 대표 {BUSINESS_INFO.ceoName}");
    expect(footer).toContain("사업자등록번호 {BUSINESS_INFO.businessRegNo}");
    expect(footer).toContain("통신판매업 신고번호 {BUSINESS_INFO.mailOrderRegNo}");
    expect(footer).toContain("고객센터 {BUSINESS_INFO.customerServicePhone}");
  });

  it("주소/이메일은 홈 footer에 노출하지 않는다(자택 주소 최소 노출 정책 유지)", () => {
    expect(footer).not.toContain("BUSINESS_INFO.address");
    expect(footer).not.toContain("BUSINESS_INFO.email");
  });

  it("기존 법적 링크 4개를 유지하고 '판매 상품' 링크가 추가됐다", () => {
    for (const href of ["/legal/terms", "/legal/privacy", "/legal/business", "/legal/refund"]) expect(footer).toContain(`href="${href}"`);
    expect(footer).toMatch(/<(a|Link) href="\/products"( prefetch=\{false\})?>판매 상품<\/(a|Link)>/);   // 2026-10-02: 내부 이동은 Link(prefetch 끔)
  });

  it("값을 홈에서 하드코딩하지 않는다", () => {
    expect(footer).not.toContain("589-77-00451");
    expect(footer).not.toContain("010-6505-8700");
  });
});

describe("5. 공개 /products 페이지", () => {
  const page = stripComments(read("app/products/page.tsx"));

  it("로그인/세션 확인 없이 공개 RPC만으로 렌더한다", () => {
    expect(page).toContain("fetchPublicStorefrontProducts()");
    expect(page).not.toMatch(/getSession|getUser|appConfirm|router\.push\(["']\/login/);
  });

  it("센터명·상품명·가격을 보여주고 센터 링크는 /center/{id}?buy=1이다", () => {
    expect(page).toContain("{g.centerName}");
    expect(page).toContain("{p.name}");
    expect(page).toContain("won(p.price)");
    expect(page).toContain("href={`/center/${g.centerId}?buy=1`}");
    expect(page).toContain("센터에서 보기");
  });

  it("그룹은 groupPublicProductsByCenter 결과만 그려 빈 센터를 렌더하지 않고, 이미지/내부 용어를 쓰지 않는다", () => {
    expect(page).toContain("groupPublicProductsByCenter(products)");
    expect(page).not.toMatch(/<img|Image\b|placeholder/i);
    expect(page).not.toMatch(/QA|테스트|토스 심사|review/i);
  });

  it("직접 checkout을 만들지 않는다(구매는 센터 화면 → 로그인 후 기존 흐름)", () => {
    expect(page).not.toContain("/checkout");
    expect(page).not.toContain("createOrder");
  });
});

describe("6. legal — 브랜드/상호/대표자 정정", () => {
  const terms = read("app/legal/terms/page.tsx");
  const privacy = read("app/legal/privacy/page.tsx");
  const refund = read("app/legal/refund/page.tsx");
  const all = [terms, privacy, refund, read("app/legal/business/page.tsx"), read("app/legal/page.tsx")].join("\n");

  it("옛 서비스명 '우리동네 클래스'가 없다", () => {
    expect(all).not.toContain("우리동네");
  });

  it("일본어 문자열(センター 등)이 없다", () => {
    expect(all).not.toMatch(/[぀-ヿ]/);
    expect(terms).toContain("센터의 귀책사유");
  });

  it("약관 제1조: 상호=모하빗(대표자 손장욱), 서비스=모하빗을 구분해 쓴다", () => {
    expect(terms).toContain('모하빗(대표자 손장욱, 이하 "회사")');
    expect(terms).toContain('웹사이트 "모하빗"(이하 "서비스")');
  });

  it("개인정보처리방침: 상호(대표자) 표기로 통일하고 개인정보 보호책임자 성명(손장욱)은 유지한다", () => {
    expect(privacy).toContain('모하빗(대표자 손장욱, 이하 "회사")이 운영하는 "모하빗"');
    expect(privacy).toContain("<tr><th>성명</th><td>손장욱</td></tr>");
  });

  it("상호 의미로 손장욱만 단독 표기한 곳이 남아있지 않다", () => {
    expect(all).not.toMatch(/손장욱\(이하 "회사"\)/);
  });

  it("PG 비활성 문구는 사실 그대로 유지한다(PG를 켜기 전이므로 '운영 중'으로 바꾸지 않음)", () => {
    expect(privacy).toContain("현재 일반 회원용 온라인 PG 결제는 비활성화되어");
  });
});
