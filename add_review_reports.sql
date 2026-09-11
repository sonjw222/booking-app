-- ============================================================
-- 센터 후기 신고 (UGC Moderation) — Release Blocker Cleanup Batch A
--
-- 배경: Apple App Store Review Guideline 1.2(UGC)는 회원이 작성해 다른 사용자에게
-- 공개되는 콘텐츠(이 앱에서는 center_reviews)에 신고 메커니즘을 요구한다. 기존에는
-- 후기 작성/조회/매니저·운영자 삭제(add_review_reply.sql)만 있었고, 회원이 부적절한
-- 후기를 신고할 방법 자체가 없었다.
--
-- 설계:
--   1) review_reports 테이블 — 신고 1건 = 이 후기(review_id)를 이 계정(reporter_
--      account_id)이 신고했다는 기록. unique(review_id, reporter_account_id)로
--      같은 사용자의 같은 후기 반복 신고를 DB 레벨에서 차단(요청 A-1/A-2).
--   2) RLS — 일반 사용자는 본인 명의로만 INSERT 가능(다른 사용자 명의 신고 불가),
--      SELECT/UPDATE 정책을 아예 안 둬서 "다른 사용자의 신고 조회 불가"/"임의 status
--      변경 불가"를 policy 부재로 자연히 보장한다(요청 A-3, service_role 우회 없음
--      — is_platform_admin()도 accounts.is_platform_admin 컬럼을 읽는 일반 SQL
--      함수일 뿐 RLS를 우회하는 게 아니다). 운영자(is_platform_admin())만 SELECT/
--      UPDATE 가능 — 기존 add_platform_admin.sql/add_account_linking.sql이 정의한
--      것과 동일한 판정 방식 재사용(요청 A-3).
--   3) 첫 출시 범위는 "신고 접수 + 운영자 검토·상태변경"까지만 — 후기 삭제 자체는
--      이미 있는 deleteReviewAsManager()/기존 매니저·운영자 DELETE 정책(add_review_
--      reply.sql)을 관리자 화면에서 그대로 재사용한다(새 삭제 경로를 안 만듦).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create table if not exists review_reports (
    id                   uuid primary key default gen_random_uuid(),
    review_id            uuid not null references center_reviews(id) on delete cascade,
    reporter_account_id  uuid not null references accounts(id) on delete cascade,
    reason               text not null check (reason in ('inappropriate', 'abuse', 'spam', 'misleading', 'privacy', 'other')),
    detail               text,
    status               text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
    created_at           timestamptz not null default now(),
    reviewed_at          timestamptz,
    reviewed_by          uuid references accounts(id),
    unique (review_id, reporter_account_id)
);

comment on table review_reports is '센터 후기 신고. 1행 = 이 계정이 이 후기를 신고했다는 기록(중복 신고는 unique 제약으로 차단).';
comment on column review_reports.status is 'pending(대기) → reviewed(운영자 확인 완료) 또는 dismissed(신고 기각). 운영자만 변경 가능.';

create index if not exists idx_review_reports_status on review_reports(status, created_at desc);
create index if not exists idx_review_reports_review on review_reports(review_id);

alter table review_reports enable row level security;

-- 본인 명의로만 신고 생성 가능(다른 사용자 명의로 신고 불가) — SELECT/UPDATE 정책은
-- 의도적으로 두지 않는다(위 설계 2번 설명 참고 — 정책이 없으면 RLS deny-by-default로
-- "본인 신고조차 조회 불가"가 되지만, 이번 배치는 신고 목록 조회 UI를 회원에게 주지
-- 않으므로 문제 없다. 나중에 "내가 신고한 목록" 화면이 필요해지면 그때 본인 것만
-- 보이는 SELECT 정책을 추가하면 된다).
drop policy if exists "후기신고 본인 생성" on review_reports;
create policy "후기신고 본인 생성"
    on review_reports for insert
    with check (reporter_account_id = my_account_id());

-- 운영자만 전체 조회
drop policy if exists "후기신고 운영자 조회" on review_reports;
create policy "후기신고 운영자 조회"
    on review_reports for select
    using (is_platform_admin());

-- 운영자만 상태 변경(reviewed_at/reviewed_by 포함) — 일반 사용자는 이 정책이 아예
-- 없어 어떤 UPDATE도 통과 못 한다.
drop policy if exists "후기신고 운영자 상태변경" on review_reports;
create policy "후기신고 운영자 상태변경"
    on review_reports for update
    using (is_platform_admin())
    with check (is_platform_admin());

-- 이 저장소에서 "새 테이블에 service_role GRANT 빠뜨림"이 이미 6차례 넘게 반복된
-- 패턴이라(가장 최근엔 account_auth_identities에서 재발 확인, 2026-09-11) 미리
-- 방어적으로 부여해둔다 — 지금 당장 이 테이블을 쓰는 Edge Function/cron은 없지만
-- 나중에 자동화(예: 신고 누적 알림)가 생겨도 이 문제를 다시 겪지 않게 한다.
grant select, insert, update, delete on review_reports to service_role;

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select tablename, rowsecurity from pg_tables where tablename = 'review_reports';
select policyname, cmd from pg_policies where tablename = 'review_reports' order by cmd;
