/*
  Privacy Release Blocker Batch #2 (2026-09-20, P1) — 정적 검증.

  이 배치의 두 수정은 둘 다 "실제 Supabase(배포된 Edge Function / 적용된 SQL 함수)"가 있어야
  런타임 검증이 가능하다(tests/integration/account-deletion-anonymization.test.ts,
  tests/integration/marketing-consent.test.ts). 그런데 그 통합테스트는 SQL을 적용하고
  `supabase functions deploy delete-account`를 한 뒤에야 통과하므로, 소스 자체가 의도한
  조건을 갖고 있는지(그리고 나중에 조용히 되돌아가지 않는지)는 여기서 파일 텍스트로 지킨다 —
  tests/unit/acl003SqlFix.staticCheck.test.ts와 같은 방식.
*/
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf-8");

const deleteAccountSrc = read("supabase/functions/delete-account/index.ts");
const fanoutSql = read("fix_marketing_consent_fanout.sql");

// delete-account의 profiles UPDATE 페이로드만 잘라낸다(주석/설명 문구에 같은 단어가
// 나와도 오탐하지 않도록 실제 실행 코드 블록에서만 검사).
function profilesUpdatePayload(): string {
  const anchor = deleteAccountSrc.indexOf('.from("profiles")\n    .update({');
  expect(anchor).toBeGreaterThan(-1);
  const start = deleteAccountSrc.indexOf("{", anchor);
  const end = deleteAccountSrc.indexOf("})", start);
  expect(end).toBeGreaterThan(start);
  return deleteAccountSrc.slice(start, end);
}

// evaluate_notification_rules()의 trigger_type 분기 한 개 본문만 잘라낸다.
function ruleBranch(triggerType: string): string {
  const marker = `rule.trigger_type = '${triggerType}'`;
  const start = fanoutSql.indexOf(marker);
  expect(start, `${triggerType} 분기를 찾지 못했습니다`).toBeGreaterThan(-1);
  // 다음 분기(elsif) 또는 분기문 종료(end if)까지가 이 분기의 본문.
  const rest = fanoutSql.slice(start + marker.length);
  const nextElsif = rest.indexOf("elsif rule.trigger_type");
  const endIf = rest.indexOf("end if;");
  const stop = nextElsif === -1 ? endIf : Math.min(nextElsif, endIf === -1 ? nextElsif : endIf);
  return rest.slice(0, stop === -1 ? rest.length : stop);
}

describe("계정 탈퇴 익명화 범위 (delete-account Edge Function)", () => {
  const payload = profilesUpdatePayload();

  it("profiles UPDATE가 기존 개인정보 컬럼을 계속 비운다 (회귀)", () => {
    for (const field of ["nickname", "phone", "address", "avatar_url", "memo", "birth_date", "label"]) {
      expect(payload, `${field}가 익명화에서 빠졌습니다`).toMatch(
        new RegExp(`${field}:\\s*null`)
      );
    }
    expect(payload).toMatch(/name:\s*ANON_NAME/);
  });

  it("profiles UPDATE가 gender/shoe_size/cloth_size도 비운다 (이번 배치 수정 대상)", () => {
    expect(payload).toMatch(/gender:\s*null/);
    expect(payload).toMatch(/shoe_size:\s*null/);
    expect(payload).toMatch(/cloth_size:\s*null/);
  });

  it("profiles 행 자체나 구조 컬럼(id/account_id/is_primary)은 건드리지 않는다 — 보존 기록의 FK가 깨지면 안 된다", () => {
    expect(payload).not.toMatch(/account_id:/);
    expect(payload).not.toMatch(/\bid:/);
    expect(payload).not.toMatch(/is_primary:/);
    // 익명화만 하고 행을 지우지 않는 기존 정책 유지
    expect(deleteAccountSrc).not.toMatch(/\.from\("profiles"\)\s*\n\s*\.delete\(\)/);
  });

  it("푸시 토큰/웹푸시 구독 삭제 동작이 그대로 남아 있다 (P0-1 회귀)", () => {
    expect(deleteAccountSrc).toMatch(/deleteAllTokensFor\(admin,\s*"native_push_tokens",\s*account\.id\)/);
    expect(deleteAccountSrc).toMatch(/deleteAllTokensFor\(admin,\s*"push_subscriptions",\s*account\.id\)/);
    expect(deleteAccountSrc).toMatch(/\.from\(table\)\.delete\(\)\.eq\("account_id",\s*accountId\)/);
  });

  it("보존 대상 테이블(reservations/memberships/payments)을 삭제하지 않는다", () => {
    for (const table of ["reservations", "memberships", "payments", "progress_records", "center_members"]) {
      expect(deleteAccountSrc, `${table}에 대한 삭제/수정이 추가되었습니다`).not.toMatch(
        new RegExp(`\\.from\\("${table}"\\)`)
      );
    }
  });
});

describe("fix_marketing_consent_fanout.sql — 광고성 팬아웃 수신 동의 게이트", () => {
  it("실행용 마이그레이션 파일의 기본 요건(멱등 재정의)을 갖춘다", () => {
    expect(fanoutSql).toMatch(/create or replace function create_marketing_message_safe/);
    expect(fanoutSql).toMatch(/create or replace function evaluate_notification_rules/);
    // 테이블/컬럼/정책을 건드리지 않는 최소 변경이어야 한다.
    expect(fanoutSql).not.toMatch(/drop\s+table/i);
    expect(fanoutSql).not.toMatch(/alter\s+table/i);
    expect(fanoutSql).not.toMatch(/drop\s+policy/i);
  });

  it("플랫폼 마케팅 발송 대상이 동의자 + 미탈퇴 계정으로 제한된다", () => {
    const fnStart = fanoutSql.indexOf("create or replace function create_marketing_message_safe");
    const fnEnd = fanoutSql.indexOf("comment on function create_marketing_message_safe");
    const body = fanoutSql.slice(fnStart, fnEnd);
    // 기존(취약) 형태: `select id from accounts where is_member = true` 뒤에 아무 조건도 없음
    expect(body).toMatch(/is_member\s*=\s*true[\s\S]{0,200}marketing_consent is true/);
    expect(body).toMatch(/deactivated_at is null/);
    // `= true`가 아니라 `is true`여야 NULL(미설정)도 미동의로 취급된다(opt-in).
    expect(body).not.toMatch(/marketing_consent\s*=\s*true/);
  });

  it("광고성 규칙(birthday / expired_rebuy)만 marketing_consent 게이트를 갖는다", () => {
    for (const t of ["birthday", "expired_rebuy"]) {
      const branch = ruleBranch(t);
      expect(branch, `${t} 분기에 accounts 조인이 없습니다`).toMatch(
        /join accounts a on a\.id = pr\.account_id/
      );
      expect(branch, `${t} 분기에 동의 조건이 없습니다`).toMatch(/a\.marketing_consent is true/);
      expect(branch).not.toMatch(/marketing_consent\s*=\s*true/);
    }
  });

  it("필수 운영 알림(count_low / membership_expiring / pause_ending)은 동의 게이트가 없다 (회귀)", () => {
    for (const t of ["count_low", "membership_expiring", "pause_ending"]) {
      const branch = ruleBranch(t);
      expect(branch, `${t}는 필수 운영 알림인데 동의 조건이 붙었습니다`).not.toMatch(/marketing_consent/);
      expect(branch, `${t}에 accounts 조인이 추가되었습니다`).not.toMatch(/join accounts/);
      // 기존 대상 선정 조건은 그대로여야 한다.
      expect(branch).toMatch(/join profiles pr on pr\.id = m\.profile_id/);
      expect(branch).toMatch(/m\.center_id = rule\.center_id/);
    }
  });

  it("필수 운영 알림 함수들(공지/예약임박/수강권만료)은 이 파일에서 재정의되지 않는다", () => {
    for (const fn of ["create_announcement", "notify_upcoming_reservations", "notify_expiring_passes", "push_notification"]) {
      expect(fanoutSql, `${fn}이 재정의되어 필수 알림에 영향을 줄 수 있습니다`).not.toMatch(
        new RegExp(`create or replace function ${fn}`)
      );
    }
  });

  it("알림톡 템플릿 코드 저장(fix_notification_rule_alimtalk_template_code.sql) 동작을 되돌리지 않는다", () => {
    // 5개 분기 전부가 aligo_template_code를 계속 저장해야 한다.
    const inserts = fanoutSql.match(/insert into messages \([^)]*aligo_template_code\)/g) ?? [];
    expect(inserts.length).toBe(5);
  });
});

describe("add_marketing_notifications.sql — 재실행 시 수정이 되돌아가는 것에 대한 경고", () => {
  it("원본 마이그레이션에 후속 수정 파일 안내가 남아 있다", () => {
    const original = read("add_marketing_notifications.sql");
    expect(original).toMatch(/fix_marketing_consent_fanout\.sql/);
  });
});
