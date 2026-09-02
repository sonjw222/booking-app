-- ============================================================
-- 자동 발송 규칙 — 트리거 타입당 여러 개(상품별로) 만들 수 있게 (버그 수정, 2026-09-01)
--
-- add_notification_rule_product_filter.sql로 product_id를 추가했는데, 정작
-- unique(center_id, trigger_type) 제약은 그대로 남아있어서 "10회권 잔여 2회 이하" 규칙을
-- 하나 만들면 "20회권 잔여 3회 이하" 같은 같은 트리거 타입의 두 번째 규칙을 절대 못 만들었다
-- (사용자 리포트 — "새로 만들기" 드롭다운에서 이미 만든 트리거 타입이 통째로 빠짐).
--
-- unique(center_id, trigger_type)를 unique(center_id, trigger_type, product_id)로 바꾼다.
-- product_id가 NULL(전체 수강권 대상)인 경우는 Postgres가 NULL끼리 다른 값으로 취급해
-- 일반 unique 제약으로는 중복을 못 막으므로, "전체 수강권" 대상은 부분 유니크 인덱스로 따로
-- 하나만 허용한다.
-- ============================================================

do $$
declare
    con record;
begin
    for con in
        select constraint_name from information_schema.table_constraints
         where table_name = 'notification_rules' and constraint_type = 'UNIQUE'
    loop
        execute format('alter table notification_rules drop constraint %I', con.constraint_name);
    end loop;
end $$;

create unique index if not exists notification_rules_unique_all_products
    on notification_rules (center_id, trigger_type) where product_id is null;
create unique index if not exists notification_rules_unique_per_product
    on notification_rules (center_id, trigger_type, product_id) where product_id is not null;

-- ============================================================
-- 확인 — 위 두 인덱스가 보이고, 기존 unique 제약(...key)은 더 이상 없어야 함
-- ============================================================
select indexname from pg_indexes where tablename = 'notification_rules';
