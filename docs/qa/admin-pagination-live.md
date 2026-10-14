# 관리자 페이지네이션 실제 DEV 검증

기존 GitHub TEST_MANAGER_B_EMAIL/PASSWORD를 Node fixture와 브라우저 로그인에 재사용한다. 별도 관리자 Secret은 필요 없다. manager A의 비관리자 접근 거부 검증은 유지한다.

전용 E2E 4 후속 단계에서 승인된 DEV project jdglfvwdnkjnraqdxuuj만 허용한다. B의 기존 is_platform_admin 값을 저장한 뒤 임시 true로 변경하고 상태별 임시 센터 31개(총 93개)를 생성한다. 실행 전 UUID ledger를 기록한다. CI always() 정리는 준비 단계가 부분 실패해도 원래 권한을 복구하고 ledger UUID만 삭제한다. 두 정리 작업을 모두 시도하고 재조회로 확인하며, 실패하면 CI를 실패시킨다. 강제 runner 종료 시 ledger 복구가 필요할 수 있다.

전용 ON 서버에서 8개 시나리오를 실행한다. 필수 계정·페이지 경계 데이터 누락은 성공으로 건너뛰지 않고 실패한다. 기본 E2E의 선택적 skip과 전용 실행의 실제 통과 여부를 구분한다. OFF 모드 회귀는 기존 기본 경로에서 검증하며 이 8개 전용 실행은 ON 모드다.

SQL 필요: NO. 마이그레이션/RLS/운영 DB SQL 변경 없음. 기존 DEV admin_list_centers_page RPC 필요. 임시 권한·센터 데이터 변경은 fixture REST 호출이며 운영에서는 실행 불가.
