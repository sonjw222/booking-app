// ACL-003 서버 측 재검증에서 작성한 SQL 초안(fix_account_center_permissions_select_draft_proposed.sql)이
// 실제로 실행되기 전까지는 tests/integration/acl-003-permission-read.test.ts로 검증할 수 없다(DB 필요).
// 대신 이 정적 테스트는 파일 텍스트 자체를 검사해, 초안이 의도한 두 조건(본인 것 / facility.role_permission
// 보유자)을 모두 포함하고, 예전의 취약했던 조건("같은 센터 소속이면 누구나")으로 되돌아가지 않았는지 확인한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(
  resolve(__dirname, "../../fix_account_center_permissions_select_draft_proposed.sql"),
  "utf-8"
);

describe("fix_account_center_permissions_select_draft_proposed.sql 정적 검토", () => {
  it("실행 금지(DO NOT RUN) 경고를 포함한다", () => {
    expect(sql).toMatch(/DO NOT RUN/);
    expect(sql).toMatch(/DRAFT/);
  });

  it("본인 것(manager_center_id account_id = my_account_id) 조건을 포함한다", () => {
    expect(sql).toMatch(/account_id\s*=\s*my_account_id\(\)/);
  });

  it("facility.role_permission 권한 보유자 조건을 포함한다", () => {
    expect(sql).toMatch(/has_permission\(mc\.center_id,\s*'facility\.role_permission'\)/);
  });

  it("예전의 취약했던 '같은 센터 소속이면 누구나' 조건(my_managed_center_ids만 사용)으로 되돌아가지 않았다", () => {
    // 취약했던 원본 정책은 이 정확한 문자열 패턴이었다 — 새 정책 본문에는 나타나면 안 된다.
    const vulnerablePattern = /manager_center_id in \(\s*select id from manager_centers\s*where center_id in \(select my_managed_center_ids\(\)\)\s*\)/;
    // 이 파일에는 "문제" 설명 섹션에 예전 정책이 주석으로 인용되어 있으므로, 그 인용을 제외한
    // 실제 실행 SQL(마지막 "create policy" 블록) 안에서만 검사한다.
    const createPolicyBlock = sql.slice(sql.lastIndexOf("create policy"));
    expect(createPolicyBlock).not.toMatch(vulnerablePattern);
  });
});
