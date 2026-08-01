-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN ⚠️
-- RLS Gap Batch C — 회원·시설 기능
-- 대상: lockers, locker_assignments, membership_transfers, class_types
-- 짝 파일: rollback_rls_gap_batch_c.sql
-- 재사용 헬퍼: my_account_id(), my_managed_center_ids(), has_permission(), is_platform_admin()
-- ============================================================


-- ------------------------------------------------------------
-- class_types — PII 없음. 로그인 사용자 조회.
--
-- [ACL-003 재검증 이후 강화] 원안은 쓰기(INSERT/UPDATE/DELETE)를 my_managed_center_ids()만으로
-- 허용했다 — "센터 소속이면 누구나 쓰기 가능"은 ACL-003에서 발견한 것과 동일한 과다 권한
-- 패턴이므로, 수업 구분은 "운영정보 설정"의 일부로 보고 facility.operation 권한을 요구하도록
-- 좁힌다(카탈로그에 "수업 구분" 전용 키는 없어 가장 근접한 기존 키를 사용 — TODO P2-11에 기록).
-- ------------------------------------------------------------
alter table class_types enable row level security;

drop policy if exists "로그인 사용자 수업구분 조회" on class_types;
create policy "로그인 사용자 수업구분 조회"
    on class_types for select using (auth.role() = 'authenticated');

drop policy if exists "센터 스태프 수업구분 생성" on class_types;
create policy "권한 보유 스태프 수업구분 생성"
    on class_types for insert
    with check (has_permission(center_id, 'facility.operation'));
drop policy if exists "센터 스태프 수업구분 수정" on class_types;
create policy "권한 보유 스태프 수업구분 수정"
    on class_types for update
    using (has_permission(center_id, 'facility.operation'))
    with check (has_permission(center_id, 'facility.operation'));
drop policy if exists "센터 스태프 수업구분 삭제" on class_types;
create policy "권한 보유 스태프 수업구분 삭제"
    on class_types for delete
    using (has_permission(center_id, 'facility.operation'));


-- ------------------------------------------------------------
-- lockers / locker_assignments
--
-- [ACL-003 재검증 이후 강화] 원안은 lockers 쓰기와 locker_assignments 쓰기 모두
-- my_managed_center_ids()만으로 허용했다(과다 권한 패턴, 위 class_types와 동일 문제).
-- lockers는 시설 설정의 일부로 보아 facility.operation, locker_assignments(회원에게
-- 락커를 배정하는 행위)는 회원 정보 변경에 가까우므로 customer.member.update로 좁힌다.
-- ------------------------------------------------------------
alter table lockers enable row level security;

drop policy if exists "로그인 사용자 락커 조회" on lockers;
create policy "로그인 사용자 락커 조회"
    on lockers for select using (auth.role() = 'authenticated');

drop policy if exists "센터 스태프 락커 생성" on lockers;
create policy "권한 보유 스태프 락커 생성"
    on lockers for insert with check (has_permission(center_id, 'facility.operation'));
drop policy if exists "센터 스태프 락커 수정" on lockers;
create policy "권한 보유 스태프 락커 수정"
    on lockers for update
    using (has_permission(center_id, 'facility.operation'))
    with check (has_permission(center_id, 'facility.operation'));
drop policy if exists "센터 스태프 락커 삭제" on lockers;
create policy "권한 보유 스태프 락커 삭제"
    on lockers for delete using (has_permission(center_id, 'facility.operation'));

alter table locker_assignments enable row level security;

drop policy if exists "본인 또는 센터 스태프 락커배정 조회" on locker_assignments;
create policy "본인 또는 권한 보유 스태프 락커배정 조회"
    on locker_assignments for select
    using (
        profile_id in (select id from profiles where account_id = my_account_id())
        or exists (
            select 1 from lockers l
            where l.id = locker_id and has_permission(l.center_id, 'customer.member.view')
        )
    );

drop policy if exists "센터 스태프 락커배정 생성" on locker_assignments;
create policy "권한 보유 스태프 락커배정 생성"
    on locker_assignments for insert
    with check (
        exists (select 1 from lockers l where l.id = locker_id and has_permission(l.center_id, 'customer.member.update'))
    );
drop policy if exists "센터 스태프 락커배정 수정" on locker_assignments;
create policy "권한 보유 스태프 락커배정 수정"
    on locker_assignments for update
    using (
        exists (select 1 from lockers l where l.id = locker_id and has_permission(l.center_id, 'customer.member.update'))
    )
    with check (
        exists (select 1 from lockers l where l.id = locker_id and has_permission(l.center_id, 'customer.member.update'))
    );
drop policy if exists "센터 스태프 락커배정 삭제" on locker_assignments;
create policy "권한 보유 스태프 락커배정 삭제"
    on locker_assignments for delete
    using (
        exists (select 1 from lockers l where l.id = locker_id and has_permission(l.center_id, 'customer.member.update'))
    );


-- ------------------------------------------------------------
-- membership_transfers — 이력은 불변. 조회만 정책 부여, 발급은 RPC 권장.
-- customer.member.pass_detail 권한 기준(카탈로그 그대로, 변경 없음 — 원안부터
-- 이미 permission 기반으로 설계돼 있었음).
-- ------------------------------------------------------------
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
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부.
-- 양도는 잔여횟수 원자적 갱신이 필요하므로 반드시 RPC(security definer)로 처리할 것.
