import { test } from "@playwright/test";

/*
  Issue #210 Batch C — 관리자 권한 분리 E2E "가능 여부 감사" 결과를 실행 가능한 형태(test.fixme)로 남긴다.
  이 이슈에서는 직원 권한 생성·RLS/SQL 변경을 하지 않으므로, 아래는 전용 fixture가 생기기 전까지 실행하지 않는다.

  저장소에서 확인한 사실:
  - e2e auth.setup.ts/authFiles.ts의 계정은 MANAGER(owner, 센터 소유자), MEMBER(user-a), MEMBER_B(user-b)뿐이다.
    "비오너 직원(center_roles.is_owner=false 이면서 role_permissions가 제한된 스태프)" 계정은 e2e fixture에 없다.
  - 따라서 MANAGER_B 또는 USER_B를 "직원"으로 간주해 권한 거부를 검증하면 안 된다(센터 소속 자체가 없는 계정을
    검증하는 것이라 '비오너 직원의 권한 제한'을 증명하지 못한다).
  - 서버 측 권한 거부(has_permission / RLS)의 기존 검증은 tests/integration/manager-permission-gating.test.ts,
    acl-003-permission-read.test.ts, admin-assignment-security.test.ts, manager-centers-privilege-escalation.test.ts 쪽이다.

  전용 fixture 요구사항(후속 승인 Issue에서 DEV Supabase에만 생성, PROD 금지):
  1) QA 소유 센터 C1의 비오너 스태프 계정 STAFF_C1: center_roles.is_owner=false, role_permissions에 'customer.member.view'만 부여.
  2) 타센터 C2(다른 owner) 와 그 소속 회원 USER_C2.
  3) e2e 로그인용 storageState(staff-c1.json)와 TestUser meta 저장(auth.setup.ts 확장) — 서비스 롤 키는 Node 측에서만 사용.
  검증 시나리오: (a) STAFF_C1이 C1 수업 생성/삭제 RPC 호출 시 거부 (b) STAFF_C1이 C2 회원 조회 시 0건/거부
  (c) MANAGER_A(owner)는 C1 허용·C2 거부 (d) 일반 회원(USER_A)이 /manager 진입·관리자 RPC 호출 시 거부.
*/

test.describe("Batch C — 관리자 권한 분리 (fixture 필요, 미실행)", () => {
  test.fixme("비오너 직원은 수업 생성/삭제 RPC가 서버에서 거부된다 — 비오너 직원 fixture 없음", async () => {});
  test.fixme("비오너 직원은 타센터 회원 데이터에 접근할 수 없다 — 타센터(C2)/직원 fixture 없음", async () => {});
  test.fixme("MANAGER_A(owner)는 자기 센터만 허용, 타센터 거부 — 타센터 소유 fixture 없음", async () => {});
  test.fixme("일반 회원은 관리자 화면/RPC가 거부된다 — 서버 거부 응답 기준 확정 후 작성", async () => {});
});
