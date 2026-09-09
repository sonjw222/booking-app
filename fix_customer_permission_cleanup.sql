-- ============================================================
-- P2-31 (Category C) — 회원/고객 권한 카탈로그 중 순수 중복 키 3개 삭제
--
-- customer.progress.view / customer.progress.manage:
--   add_new_permissions.sql에서 새로 만들었지만 실제 진도표 RLS는 처음부터 있던
--   단일 키 customer.progress(schema.sql:184)로만 걸려있다(add_progress_categories.sql,
--   reservation_functions.sql 확인). 이 두 키는 앱/lib 코드 어디서도 참조되지 않는다
--   (grep 확인) — 기능 손실 없이 삭제 가능.
--
-- customer.detail:
--   add_new_permissions.sql에서 "회원 상세 조회(수강권·예약·결제·입력정보)"로 새로
--   만들었지만, 이미 같은 범위를 담당하는 customer.member.pass_detail(schema.sql:182,
--   "수강권 상세정보 조회·수정, 포인트 및 결제내역 조회")과 완전히 중복된다. 이 키도
--   앱/lib 코드 어디서도 참조되지 않는다(grep 확인) — 삭제 가능.
--   (customer.member.pass_detail 자체는 지금까지 라이브에 연결 안 돼 있었다 — 별도
--   파일 fix_customer_member_pass_detail_permission.sql에서 처리한다.)
--
-- 카탈로그 UI는 permissions 테이블을 그대로 읽어 렌더링하므로(lib/roles.ts) 이 삭제만으로
-- 체크박스도 자동으로 없어진다. TS 변경 불필요.
--
-- 여러 번 실행해도 안전.
-- ============================================================

delete from role_permissions
where permission_key in ('customer.progress.view', 'customer.progress.manage', 'customer.detail');

delete from permissions
where key in ('customer.progress.view', 'customer.progress.manage', 'customer.detail');

-- ============================================================
-- 확인 (0행이 나와야 정상)
-- ============================================================
select key from permissions
where key in ('customer.progress.view', 'customer.progress.manage', 'customer.detail');
