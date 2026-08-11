-- ============================================================
-- 담당 강사 복수 지정 Batch 후속 수정: 회원이 강사 이름을 볼 수 있게 하는 RPC 추가
--
-- [발견 경위]
--   add_class_trainers_pass_selection_mode_draft_proposed.sql 적용 후 CI 통합 테스트
--   (tests/integration/class-trainers-and-pass-selection-mode.test.ts)에서 실측 발견:
--   lib/reservations.ts의 fetchMonthData()가
--     supabase.from("class_trainers").select("class_id, accounts(name)").in("class_id", ids)
--   로 회원 세션에서 강사 이름을 조회하는데, class_trainers 테이블 자체의 SELECT 정책은
--   "인증 사용자 전체 허용"이라 문제없지만, PostgREST 임베드 조인이 함께 딸려오는
--   accounts.name은 accounts 테이블 자신의 SELECT RLS("계정 조회" 정책,
--   reservation_functions.sql/fix_staff_search.sql)를 그대로 통과해야 한다. 그 정책은
--     - 본인 계정
--     - 내가 관리하는 센터의 스태프 계정
--     - 내가 관리하는 센터 "회원"의 계정
--     - 스태프 초대 권한이 있는 경우의 검색 대상
--   네 경우만 허용하고, "그냥 그 센터 회원인 나"가 "그 센터 강사"의 이름을 보는 경우는
--   어디에도 해당하지 않는다 — 그래서 항상 빈 값으로 조용히 필터링돼(에러 없이) 실제
--   운영에서도 회원 화면에 강사 이름이 절대 뜨지 않았을 것이다(CI가 아니었다면 조용히
--   묻힐 뻔한 버그).
--
-- [해결 방식 — accounts RLS를 넓히지 않고 전용 RPC로 좁게 해결]
--   accounts 테이블은 과거 무한 재귀 버그(fix_staff_search.sql)를 겪은 민감한 정책이라,
--   이 한 가지 새 용도를 위해 그 정책 자체를 다시 건드리는 대신 이 목적 하나만을 위한
--   security definer RPC를 추가한다(이 프로젝트에서 이미 my_account_id() 등에 쓰는
--   동일한 패턴) — class_trainers에 실제로 등록된 계정의 id/name만, 그것도 요청된
--   class_id에 한해서만 반환하므로 accounts 테이블 전체를 여는 것보다 노출 범위가 훨씬
--   좁다. accounts/class_trainers의 기존 RLS 정책은 이 파일에서 절대 수정하지 않는다.
--
-- [권한 최소화 — 2026-08-11 사용자 리뷰 반영]
--   PostgreSQL은 함수를 새로 만들면 기본적으로 PUBLIC(=모든 role, anon 포함)에게 EXECUTE
--   권한을 암묵적으로 부여한다. security definer 함수는 이 권한만으로 accounts 테이블의
--   RLS를 완전히 우회해 호출되므로, 명시적으로 PUBLIC과 anon의 EXECUTE 권한을 걷어내고
--   authenticated에만 부여한다(create or replace만으로는 기존 함수의 권한이 자동으로
--   재설정되지 않으므로, 재실행 시에도 항상 의도한 최종 상태가 되도록 매번 revoke부터
--   다시 한다 — 이 파일을 여러 번 실행해도 안전).
--   추가로 함수 본문 WHERE절에 auth.uid() is not null 조건을 넣어, 혹시라도 인증되지
--   않은 세션(예: service_role의 관리 스크립트가 실수로 사용자 컨텍스트 없이 호출하는
--   경우)에서 호출되면 무조건 빈 결과만 반환하도록 방어한다(anon 권한 제거로 이미 막히는
--   경로지만, 이중 방어).
--
-- 여러 번 실행해도 안전(create or replace, revoke/grant 전부 멱등).
-- ============================================================

create or replace function class_trainer_names(p_class_ids uuid[])
returns table (class_id uuid, account_id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
    select ct.class_id, ct.account_id, a.name
    from class_trainers ct
    join accounts a on a.id = ct.account_id
    where ct.class_id = any(p_class_ids)
      and auth.uid() is not null;
$$;

revoke all on function class_trainer_names(uuid[]) from public;
revoke all on function class_trainer_names(uuid[]) from anon;
grant execute on function class_trainer_names(uuid[]) to authenticated;

-- ============================================================
-- 완료. class_trainer_names(uuid[]) RPC 추가 + 권한 최소화.
--   - accounts 테이블의 기존 SELECT RLS 정책은 전혀 손대지 않음(스태프 검색/회원관리
--     등 기존 흐름에 영향 없음).
--   - class_trainers 테이블의 기존 RLS 정책도 전혀 손대지 않음.
--   - 반환 컬럼은 class_id/account_id/name 세 개뿐 — accounts의 다른 필드(전화번호 등)는
--     이 함수를 통해서도 절대 노출되지 않는다.
--   - EXECUTE 권한: public·anon 명시적 차단, authenticated만 허용. 함수 본문에도
--     auth.uid() is not null 이중 방어.
-- lib/reservations.ts의 fetchMonthData()가 이 RPC를 쓰도록 코드도 함께 준비해뒀음(이
-- SQL 실행 전까지는 fetchMonthData()가 여전히 예전 방식대로 동작하다가, 이 SQL을
-- 실행하면 코드 재배포 없이도 다음 배포부터 정상 동작 — 단, 두 변경을 같은 배포에
-- 묶는 것을 권장).
-- ============================================================
