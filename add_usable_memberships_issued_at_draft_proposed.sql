-- ============================================================
-- UX 감사 A-8: 이름·만료일이 완전히 같은 수강권을 회원이 구분할 방법이 없음
--
-- [재현 확인] 한 프로필이 같은 상품(이름 동일)을 여러 번 구매하면 memberships 행이
-- 여러 개 생기고, 그중 일부는 만료일(expires_at)까지 우연히 같을 수 있다(실제로
-- 라이브 데이터에서 재현됨 — 이름·만료일 동일, remaining_count만 다른 4개 케이스).
-- 예약 확인 화면의 수강권 선택 목록(app/reservation/page.tsx의 .pass-pick-list)은
-- 지금 product_name/remaining_count/expires_at만 보여줘서, 이런 경우 어떤 걸 골라도
-- 겉보기엔 구분이 안 된다.
--
-- [이 migration이 하는 일] usable_memberships_for_classes()의 RETURNS TABLE에
-- issued_at(발급일, memberships.issued_at — 이미 존재하는 컬럼, 새 컬럼 추가 아님)만
-- 추가한다. WHERE 절(예약 자격 판정 로직)은 단 한 글자도 바꾸지 않는다 — 순수하게
-- 출력 컬럼 하나 더 얹는 것뿐이라 예약 가능/불가능 판정 자체에는 영향이 없다.
--
-- [현재 라이브 정의 근거] add_class_trainers_pass_selection_mode_draft_proposed.sql
-- (2026-08-11, 커밋 메시지 "SQL 적용 완료"로 확정)의 본문이 이 함수의 마지막 전체
-- 재정의이고, 그 이후 fix_security_definer_hardening_search_path_execute_draft_proposed.sql
-- (2026-08-13, 적용 완료)이 본문 변경 없이 search_path 고정 + EXECUTE를 authenticated로만
-- 제한했다(anon/service_role 둘 다 차단 — 이번 조사 중 service_role로 직접 호출해 동일한
-- "permission denied for function" 에러로 실측 재확인함). 아래 본문은 그 두 파일의 최종
-- 상태를 그대로 유지하면서 컬럼 하나만 추가한 것 — WHERE절은 원문과 완전히 동일.
--
-- [적용 안전성] CREATE OR REPLACE FUNCTION은 시그니처(uuid[], uuid)가 그대로면 기존
-- GRANT/REVOKE를 초기화하지 않는다 — 그래도 이 SEC 하드닝 의도를 명시적으로 지키기 위해
-- search_path를 본문에 다시 명시했다. EXECUTE 권한은 별도로 재부여하지 않아도 유지되지만,
-- 적용 후 아래 "적용 후 확인" 쿼리로 authenticated만 남아있는지 재확인 권장.
-- ============================================================

create or replace function usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
returns table (
    class_id        uuid,
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,
    is_mine         boolean,
    issued_at       date
)
language sql
security definer
set search_path = public
as $$
    with cls as (
        select c.id, c.center_id, c.title, c.pass_selection_mode,
               (c.start_time at time zone 'Asia/Seoul')::time as ltime,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as ldow
        from classes c
        where c.id = any(p_class_ids)
    )
    select
        cls.id,
        m.id,
        m.product_name,
        m.remaining_count,
        m.expires_at,
        coalesce(p.name, ''),
        (m.profile_id = p_profile_id),
        m.issued_at
    from cls
    join memberships m on m.center_id = cls.center_id
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            (
                cls.pass_selection_mode = 'selected'
                and exists (
                    select 1 from class_allowed_products cap
                    where cap.class_id = cls.id and cap.product_id = m.product_id
                )
            )
            or m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = cls.ldow)
                  and (r.start_time is null or r.start_time = cls.ltime)
                  and (r.class_title is null or r.class_title = cls.title)
            )
      );
$$;

-- ------------------------------------------------------------
-- 적용 후 확인 (read-only, 아래 두 쿼리 결과를 보고해주시면 확정 보고하겠습니다)
-- ------------------------------------------------------------
-- 1) 함수 본문이 issued_at을 포함해 정상 교체됐는지
select pg_get_functiondef('usable_memberships_for_classes(uuid[], uuid)'::regprocedure);

-- 2) EXECUTE 권한이 authenticated만 남아있는지(SEC-116/117 하드닝 유지 확인)
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'usable_memberships_for_classes';
