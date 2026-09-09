-- ============================================================
-- P2-31 (Category C) — customer.member.pass_detail 권한 라이브 연결
--
-- customer.member.pass_detail("회원의 수강권 상세정보 조회 및 수정 — 포인트 및
-- 결제내역 조회", schema.sql:182)가 카탈로그에 있지만 지금까지 어떤 RLS에도
-- 연결돼 있지 않았다. 이미 작성돼 있던 초안(proposed_rls_gap_batch_c.sql:106-121)에서
-- 이 권한 키를 실제로 쓰는 부분만 그대로 뽑아온 것 — 그 파일의 다른 항목(lockers/
-- locker_assignments 등, customer.member.view/update 기준)은 이 배치 범위 밖이라
-- 포함하지 않았다.
--
-- ⚠ 범위가 좁다는 점 주의: 이 정책은 membership_transfers(수강권 양도 이력) 테이블의
-- 조회(SELECT)만 커버한다. 카탈로그 라벨이 말하는 "수강권 상세정보 수정"이나 "포인트·
-- 결제내역 조회" 자체를 담당하는 별도 RLS/RPC는 이 파일 범위에 없다(그런 화면들이
-- 지금 무엇으로 보호되는지는 이번 조사 범위 밖 — 확인 필요하면 후속으로 남겨야 함).
-- 이 파일은 딱 "양도 이력 조회"라는 한 조각만 완성한다.
--
-- membership_transfers는 지금까지 RLS 자체가 비활성 상태였다(schema.sql:722 테이블
-- 생성 이후 어떤 파일도 RLS를 켜지 않음, grep 확인) — 순수 신규 추가, 기존 정책과
-- 충돌 없음. INSERT/UPDATE/DELETE는 의도적으로 정책 없이 비워둔다(원안 설계대로,
-- 이력은 불변이어야 하고 양도는 원자적 갱신이 필요해 반드시 RPC로 처리해야 하기
-- 때문 — 이 파일은 그 RPC를 새로 만들지 않는다).
--
-- 여러 번 실행해도 안전.
-- ============================================================

alter table membership_transfers enable row level security;

drop policy if exists "당사자 또는 권한 보유 스태프 양도이력 조회" on membership_transfers;
create policy "당사자 또는 권한 보유 스태프 양도이력 조회"
    on membership_transfers for select
    using (
        from_profile_id in (select id from profiles where account_id = my_account_id())
        or to_profile_id in (select id from profiles where account_id = my_account_id())
        or exists (
            select 1 from memberships m
            where m.id = membership_id
              and has_permission(m.center_id, 'customer.member.pass_detail')
        )
        or is_platform_admin()
    );

-- ============================================================
-- 확인
-- ============================================================
select tablename, rowsecurity from pg_tables where tablename = 'membership_transfers';
select policyname, cmd from pg_policies where tablename = 'membership_transfers';
