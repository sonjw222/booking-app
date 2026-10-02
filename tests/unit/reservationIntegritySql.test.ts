/* 예약 무결성 migration 정적 계약 + F4 전제(앱의 reservations 직접 UPDATE는 member_memo 하나뿐) — 동작 검증은 tests/sql/reservation-integrity.test.mjs(PGlite) */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const code = (sql: string) => sql.replace(/--.*$/gm, "");

describe("fix_reservation_integrity_20261003.sql 계약", () => {
  const sql = code(read("fix_reservation_integrity_20261003.sql"));
  it("transaction + 서버 최종 판정에서 LIKE/override 제거, 정확 일치·pass-only 존재", () => {
    expect(sql).toMatch(/^\s*begin;/);
    expect(sql).toMatch(/commit;\s*$/);
    expect(sql).not.toMatch(/c\.title like/i);
    expect(sql).not.toMatch(/class_title[^;\n]*\blike\b/i);
    expect(sql).not.toContain("cls.pass_selection_mode = 'selected'");
    expect(sql).not.toContain("c.pass_selection_mode = 'selected'");
    expect(sql).toContain("r.class_title = c.title");
    expect(sql).toContain("pd.product_kind = 'pass'");
    expect(sql).toContain("m.product_id is null\n                or exists (select 1 from products pd");   // legacy(product_id 없음) 보존
  });
  it("회원 예약 자격 날짜는 KST 기준(current_date 제거), SECURITY DEFINER + search_path 고정 유지", () => {
    expect(sql).not.toMatch(/\bcurrent_date\b/);
    expect(sql.match(/\(now\(\) at time zone 'Asia\/Seoul'\)::date/g)!.length).toBeGreaterThanOrEqual(6);
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(5);
    expect(sql.match(/SET search_path TO 'public'/g)).toHaveLength(5);
  });
  it("F4: authenticated는 member_memo 컬럼 UPDATE만, anon 쓰기 회수, service_role/RLS 정책은 건드리지 않는다", () => {
    expect(sql).toContain("revoke update on table public.reservations from authenticated;");
    expect(sql).toContain("grant update (member_memo) on table public.reservations to authenticated;");
    expect(sql).toContain("revoke insert, update, delete, truncate on table public.reservations from anon;");
    expect(sql).not.toMatch(/service_role[^;]*reservations/);
    expect(sql).not.toMatch(/drop policy|create policy|alter policy/i);
  });
  it("권한: is_membership_eligible_for_class만 PUBLIC/anon 회수 + authenticated/service_role 명시", () => {
    expect(sql).toContain("revoke all on function public.is_membership_eligible_for_class(uuid, uuid) from public, anon;");
    expect(sql).toContain("grant execute on function public.is_membership_eligible_for_class(uuid, uuid) to authenticated, service_role;");
  });
  it("보완: reserve_class는 status='active'를 직접 강제, usable_memberships()는 NULL 만료 허용 + starts_at 검사, INSERT/DELETE 권한은 확대(회수)하지 않는다", () => {
    expect(sql).toContain("and m.status = 'active'\n      and (m.remaining_count is null or m.remaining_count > 0)\n      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)\n      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)\n      and is_membership_eligible_for_class(m.id, v_class.id)");
    expect(sql.match(/m\.expires_at is null or m\.expires_at >= \(now\(\) at time zone 'Asia\/Seoul'\)::date/g)!.length).toBeGreaterThanOrEqual(3);
    expect(sql).not.toMatch(/revoke[^;]*(insert|delete)[^;]*from authenticated/i);
    expect(sql).not.toContain("reservations_guard_pg_refund_lock");   // PG/refund 방어 트리거는 건드리지 않는다
  });
  it("rollback의 reserve_class/usable_memberships는 migration 직전 live 정의(status 조건 없음, 옛 날짜 조건)", () => {
    const rb = code(read("rollback_fix_reservation_integrity_20261003.sql"));
    const rc = rb.slice(rb.indexOf("FUNCTION public.reserve_class"), rb.indexOf("FUNCTION public.reserve_with_membership"));
    expect(rc).not.toContain("m.status = 'active'");
    expect(rc).toContain("m.expires_at >= current_date");
    const um = rb.slice(rb.indexOf("FUNCTION public.usable_memberships("), rb.indexOf("FUNCTION public.usable_memberships_for_classes"));
    expect(um).toContain("and m.expires_at >= current_date");
    expect(um).not.toContain("m.starts_at");
  });
  it("verify verdict는 모든 보안 체크의 AND(정보성 컬럼은 제외)", () => {
    const v = code(read("verify_reservation_integrity_20261003.sql"));
    const verdict = v.slice(v.indexOf("case when"), v.indexOf("end", v.indexOf("case when")));
    const oks = ["f1_exact_title_ok", "f2_no_selected_override_ok", "f3_pass_only_ok", "f5_kst_date_ok", "reserve_class_active_ok", "usable_single_dates_ok",
      "f4_auth_no_table_update_ok", "f4_auth_memo_update_ok", "f4_auth_no_other_update_columns_ok", "f4_anon_no_insert_ok", "f4_anon_no_update_ok", "f4_anon_no_delete_ok",
      "f4_anon_no_truncate_ok", "f4_auth_no_truncate_ok", "eligible_fn_anon_denied_ok", "eligible_fn_auth_ok", "eligible_fn_service_ok", "service_role_update_ok", "memo_rls_policy_ok"];
    for (const k of oks) { expect(verdict).toContain(k); expect(v).toMatch(new RegExp(`as ${k}\\b`)); }
    expect(verdict).not.toContain("info_");
    expect(v).toContain("as info_auth_reservations_insert_privilege");
    expect(v).toContain("as info_auth_reservations_delete_privilege");
  });
  it("범위 밖은 건드리지 않는다: F6(manager_grant_product)/PG·환불·정산/진도/전화 검색 함수가 없다", () => {
    for (const name of ["manager_grant_product", "refund", "settlement", "fulfill_order", "progress_categories", "search_accounts_for_member", "cancel_reservation"]) expect(sql).not.toContain(name);
  });
  it("rollback은 직전 라이브 정의(LIKE 포함)로 복원하고 권한을 되돌리며, verify는 단일 읽기 전용 SELECT", () => {
    const rb = code(read("rollback_fix_reservation_integrity_20261003.sql"));
    expect(rb).toContain("c.title like '%' || r.class_title || '%'");
    expect(rb).toContain("grant update on table public.reservations to authenticated;");
    const v = code(read("verify_reservation_integrity_20261003.sql"));
    expect(v.trim()).toMatch(/^with\b/i);
    expect(v).not.toMatch(/\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  });
});

describe("F4 전제: 클라이언트의 reservations 직접 UPDATE는 member_memo뿐(관리자/서버 동작은 RPC)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  it("app/ lib/에서 supabase.from('reservations') 체인의 update는 lib/mypage.ts의 member_memo 하나", () => {
    const hits: { file: string; text: string }[] = [];
    for (const f of [...walk("app"), ...walk("lib")]) {
      const src = read(f);
      const re = /\.from\(\s*["']reservations["']\s*\)([\s\S]{0,300}?)(?:;|\n\s*\n)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) if (/\.update\(/.test(m[1])) hits.push({ file: f, text: m[1] });
    }
    expect(hits.map((h) => h.file)).toEqual(["lib/mypage.ts"]);
    expect(hits[0].text).toMatch(/\.update\(\{\s*member_memo:/);
    expect(hits[0].text).not.toMatch(/status|class_id|membership_id|profile_id/);
  });
});
