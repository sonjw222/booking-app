-- ============================================================
-- 수업매출 캘린더 기능 [1/4]: 스키마
--
-- [배경] "매출"(app/manager/sales)은 결제일 기준 집계만 있고, "수업이 실제로 열린
-- 날짜 기준" 매출(수업매출)을 보여주는 기능이 없다. payments에는 class_id가 없어
-- (payments.membership_id → memberships → reservations.class_id) 결제를 수업에
-- 직접 귀속시킬 방법이 없었다 — 이 배치에서 회차(session_index) 기반 귀속 모델을 새로
-- 설계한다(자세한 설계 근거는 계획 문서 참고, 요약: 횟수제는 결제금액을 총횟수로 균등
-- 분배하되 매니저가 회차별 금액을 커스터마이즈할 수 있음).
--
-- [1] membership_session_amounts: 매니저가 커스텀한 회차별 금액만 저장한다(오버라이드
-- 없으면 행이 없고, 조회 시 "결제총액 ÷ total_count" 균등분배로 대체 계산). 키는
-- session_index(회차 번호, 1-based)이지 특정 reservation_id가 아니다 — 취소/재예약으로
-- 실제 순서가 바뀌어도 "N회차는 얼마"라는 규칙 자체가 유지돼야 한다는 요구사항(사용자
-- 확인)에 따른 의도적 설계.
-- RLS: select는 pass.sales.view(매출 조회 권한)로 열어두고, insert/update/delete
-- 정책은 만들지 않는다 — 총액 검증(그 membership에 연결된 payments 합계와 일치해야
-- 함)이 단순 RLS로 표현하기 어려운 cross-row 제약이라, 쓰기는 [2]의
-- set_membership_session_amounts() RPC로만 가능하게 잠근다.
--
-- [2] center_settings.unlimited_pass_revenue_mode: 무제한/기간제 정기권(횟수 제한
--없음)은 "회당 단가" 개념이 없어 위 방식으로 귀속이 안 된다. 기본값 usage_split(기간
-- 중 실제 이용 횟수로 나눠 배분, 매 조회 시 동적 재계산)과 purchase_date_full(정기권
-- 매출은 구매일에 전액, 수업별로 안 나눔) 중 매니저가 설정에서 고를 수 있게 한다.
-- 기존 center_settings RLS(add_center_settings.sql, facility.info 권한)가 새 컬럼에도
-- 그대로 적용되므로 별도 정책 불필요.
--
-- [영향받는 기존 데이터] 없음 — 새 테이블 + center_settings에 컬럼 추가(기존 행은
-- 전부 기본값 'usage_split'으로 채워짐)뿐, 기존 로직/데이터 변경 없음.
-- [위험도] 낮음.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] membership_session_amounts
-- ------------------------------------------------------------
create table if not exists membership_session_amounts (
    id             uuid primary key default gen_random_uuid(),
    membership_id  uuid not null references memberships(id) on delete cascade,
    session_index  int not null check (session_index >= 1),
    amount         int not null check (amount >= 0),
    created_at     timestamptz not null default now(),
    unique (membership_id, session_index)
);

comment on table membership_session_amounts is
    '수업매출 캘린더: 횟수제 수강권의 회차별(session_index, 1-based) 매출 귀속 금액
     커스텀 오버라이드. 행이 없는 회차는 (그 membership에 연결된 payments.total_amount
     합계 ÷ memberships.total_count)로 균등분배 계산한다. 쓰기는 set_membership_session_
     amounts() RPC 전용(총액 검증 때문 — 직접 RLS insert/update/delete 정책 없음).';

alter table membership_session_amounts enable row level security;

drop policy if exists "수업매출 회차금액 조회" on membership_session_amounts;
create policy "수업매출 회차금액 조회"
    on membership_session_amounts for select
    using (
        membership_id in (
            select id from memberships where has_permission(center_id, 'pass.sales.view')
        )
    );

-- ------------------------------------------------------------
-- [2] center_settings.unlimited_pass_revenue_mode
-- ------------------------------------------------------------
alter table center_settings
    add column if not exists unlimited_pass_revenue_mode text
        not null default 'usage_split'
        check (unlimited_pass_revenue_mode in ('usage_split', 'purchase_date_full'));

comment on column center_settings.unlimited_pass_revenue_mode is
    '수업매출 캘린더: 무제한/기간제(pass_type=period) 정기권 매출을 어떻게 배분할지.
     usage_split(기본) = 기간 중 실제 이용 횟수로 나눠 각 수업 날짜에 배분(동적 추정,
     스냅샷 저장 안 함). purchase_date_full = 정기권 매출 전액을 구매일에 표시하고
     수업별로 안 나눔.';

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select table_name, column_name from information_schema.columns
 where table_name = 'membership_session_amounts';
select column_name, column_default, is_nullable
  from information_schema.columns
 where table_name = 'center_settings' and column_name = 'unlimited_pass_revenue_mode';
select policyname, cmd from pg_policies where tablename = 'membership_session_amounts';
