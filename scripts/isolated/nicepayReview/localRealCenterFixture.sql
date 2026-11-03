-- 로컬 격리 스택 전용 시험 데이터 — 운영의 "실제 판매 센터(A10TION 피겨팀 형태)"를 모사한다. 운영/공유 DEV 데이터가 아니며 이름·가격은 시험용이다(운영 값 복사 아님).
-- 실제 센터와 같은 "형태"만 맞춘다: 승인·비내부·비심사 센터 + 날짜 만료(expiry_mode='date') 상품 3종(횟수 선택형 2 + 단일 횟수 1) + 이미 만료된 상품 1개 + 미래 수업 1개.
with c as (insert into centers(name, status, is_internal) values ('[로컬] 실센터 모사', 'approved', false) returning id)
insert into center_settings(center_id) select id from c;

insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_days, expiry_date, rolling_month_cutoff_day, rolling_month_allow_early_use, purchase_count_selectable, description)
select c.id, v.name, v.price, 'pass', 'count', v.cnt, false, 'date', null, v.dt::date, null, false, v.sel, v.descr
from (select id from centers where name='[로컬] 실센터 모사') c,
(values
 ('[로컬] 11월 스케줄링 수강권', 80000, null::int, true,  '2026-11-28', '1~12회 선택형'),
 ('[로컬] 11월 요일고정 수강권', 280000, null::int, true,  '2026-11-28', '4/8/12회 선택형'),
 ('[로컬] 11월 4주완성 수강권', 320000, 4,         false, '2026-11-28', '4회 단일'),
 ('[로컬] 10월 수강권(만료)',    70000, 4,         false, '2026-10-31', '이미 만료된 고정일 상품 — 목록·신규 주문에서 제외되어야 함')
) as v(name, price, cnt, sel, dt, descr);
insert into product_count_prices(product_id, count, price) select id, x.c, x.p from products, (values (1,80000),(12,720000)) x(c,p) where name='[로컬] 11월 스케줄링 수강권';
insert into product_count_prices(product_id, count, price) select id, x.c, x.p from products, (values (4,280000),(8,520000),(12,600000)) x(c,p) where name='[로컬] 11월 요일고정 수강권';

insert into classes(center_id, title, start_time, end_time, capacity)
select id, '[로컬] 실센터 모사 수업', now() + interval '3 days', now() + interval '3 days 1 hour', 8 from centers where name='[로컬] 실센터 모사';
