# TEST-002 추가 fixture 오염 수정

기존 afterAll은 이번에 새로 만든 권한 예외만 삭제했다. 이미 있던 deny 행을 beforeAll이 allow로 upsert하면 원래 deny 값이 영구히 변경됐다. read 성공 후 write 직전에 snapshot을 저장하고 cleanup에서 원래 allow/deny/null로 복구한다. 쓰기가 DB에서 성공했지만 네트워크 오류를 반환한 경우도 복구 대상으로 유지한다. 여러 restore 중 하나가 실패해도 나머지를 계속하고 실패 목록을 반환하며 재시도할 수 있다.

로컬 회귀 테스트는 기존 allow/deny 보존, 새 행 제거, 반복 변경 시 최초 snapshot 보존, write-after-mutation 오류, 읽기 실패 시 쓰기 방지, 일부 복원 실패 후 나머지 복원 및 재시도를 검증한다.

개발 DB mwhabit-ci-dev에서 ACL-003 무권한 역할 및 연결된 manager_centers/permission_key/grant_type을 조회했다. 조회 결과 0행으로 현재 이 marker 기반 삭제 대상은 없다. 기존 cleanup_acl003_test_fixture_proposed.sql은 예상1행을 요구하므로 실행하지 않았다. 운영 DB 조회·수정 없음. SQL 필요 NO.

CI는 기존 공유 live Supabase lock을 유지하고 integration 성공 이후 해당 브랜치에서만 ACL-003 단독, admin-assignment-security 단독, 두 파일 함께 각각 3회 반복한다. Production guard는 vitest.integration.config.ts의 globalSetup/loadEnv를 그대로 사용한다. 전체 integration 3회 완료는 아직 확인하지 않았으며 Issue #24는 계속 열어 둔다.
