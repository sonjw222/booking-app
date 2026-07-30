-- ============================================================
-- 버그 수정: "사용 가능한 수강권" 목록에 구매용 상품(goods)이 섞여 보임
--
-- 원인:
--   usable_memberships() / usable_memberships_for_classes()
--   (fix_usable_memberships_shared.sql)가 memberships를 조회할 때
--   products.product_kind를 전혀 확인하지 않았습니다.
--   상품 구매(product_kind='goods', 예: 대여용품)도 memberships 행으로
--   발급되기 때문에(fulfill_order/confirm_test_payment 모두 동일),
--   status='active' + remaining_count>0 + expires_at 조건만 통과하면
--   goods 상품도 "사용 가능한 수강권" 목록과 예약 확인 팝업의 수강권
--   선택 목록에 그대로 노출됐습니다.
--
--   추가로 remaining_count > 0 조건이 NULL(무제한/기간권)을 잘못 제외하고
--   있어서 함께 바로잡습니다 (lib/reservations.ts의 fetchMyGoodsByCenter가
--   이미 올바르게 처리하는 것과 동일한 null-safe 조건으로 통일).
--
-- 영향 범위: 이 두 함수의 반환값을 그대로 쓰는 화면은 모두 동일하게 고쳐집니다.
--   - 예약 화면의 "사용 가능한 수강권" 목록 (app/reservation/page.tsx)
--   - 예약 확인 팝업의 수강권 선택 목록 (같은 파일, 같은 데이터 소스)
--   프론트엔드 코드 변경은 필요하지 않습니다 — RPC만 정확해지면 됩니다.
--
-- 여러 번 실행해도 안전 (create or replace).
-- ============================================================

create or replace function usable_memberships(p_class_id uuid, p_profile_id uuid)
returns table (
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,
    is_mine         boolean
)
language sql
security definer
as $$
    with cls as (
        select c.*,
               (c.start_time at time zone 'Asia/Seoul')::date as ldate,
               (c.start_time at time zone 'Asia/Seoul')::time as ltime,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as ldow
        from classes c where c.id = p_class_id
    )
    select
        m.id,
        m.product_name,
        m.remaining_count,
        m.expires_at,
        coalesce(p.name, ''),
        (m.profile_id = p_profile_id)
    from memberships m
    join cls on true
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.center_id = cls.center_id
      and m.status = 'active'
      and pd.product_kind = 'pass'   -- 구매용 상품(goods)은 제외, 실제 예약용 수강권만
      and (m.remaining_count is null or m.remaining_count > 0)
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = cls.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = cls.ldow)
                  and (r.start_time is null or r.start_time = cls.ltime)
                  and (r.class_title is null or r.class_title = cls.title)
            )
      )
    order by (m.profile_id = p_profile_id) desc, m.expires_at asc;
$$;


create or replace function usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
returns table (
    class_id        uuid,
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,
    is_mine         boolean
)
language sql
security definer
as $$
    with cls as (
        select c.id, c.center_id, c.title,
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
        (m.profile_id = p_profile_id)
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
            not exists (select 1 from class_allowed_products cap where cap.class_id = cls.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            m.product_id is null
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

-- ============================================================
-- 완료. usable_memberships / usable_memberships_for_classes 모두
-- product_kind='pass'만 반환하며, remaining_count가 NULL(기간권/무제한)인
-- 경우도 더 이상 잘못 제외되지 않습니다.
-- ============================================================
