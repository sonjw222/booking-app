-- 로컬 격리 스택 전용 UX QA 시험 데이터(운영/공유 DEV 데이터 아님, 운영 값 복사 아님). setupLocal.sh + setupRealCenter.sh 이후에 실행한다.
-- 목적: 횟수 선택형 / 사이즈 선택형 / 같은 수강권의 횟수별 변형 / 월별 수강권 / 같은 이름의 다른 수업 을 한 센터에 준비해 구매 시트·결제 화면·수강권 이름 병합을 실제 데이터로 검증한다.
do $$ begin
  if not exists (select 1 from centers where name = '[로컬] 실센터 모사') then raise exception '로컬 격리 스택이 아님(시험 센터 없음) — 중단'; end if;
  if exists (select 1 from centers where name = '[UX] 격리 UX 시험 센터') then raise exception '이미 준비됨 — 중단'; end if;
end $$;

with c as (insert into centers(name, status, is_internal) values ('[UX] 격리 UX 시험 센터', 'approved', false) returning id)
insert into center_settings(center_id) select id from c;

-- 고정 횟수 상품(같은 수강권의 횟수별 변형: "11월 수강권 1/4/8/12회권", 다른 달: "12월 수강권 4/8회권")
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_date, rolling_month_cutoff_day, rolling_month_allow_early_use, purchase_count_selectable, description, group_label)
select c.id, v.name, v.price, 'pass', 'count', v.cnt, false, 'date', v.dt::date, null, false, false, v.descr, v.grp
from (select id from centers where name = '[UX] 격리 UX 시험 센터') c,
(values
 ('[UX] 11월 수강권 1회권', 10000, 1,  '2026-12-31', '11월 1회', '11월 수강권'),
 ('[UX] 11월 수강권 4회권', 36000, 4,  '2026-12-31', '11월 4회', '11월 수강권'),
 ('[UX] 11월 수강권 8회권', 64000, 8,  '2026-12-31', '11월 8회', '11월 수강권'),
 ('[UX] 11월 수강권 12회권', 84000, 12, '2026-12-31', '11월 12회', '11월 수강권'),
 ('[UX] 12월 수강권 4회권', 36000, 4,  '2027-01-31', '12월 4회', '12월 수강권'),
 ('[UX] 12월 수강권 8회권', 64000, 8,  '2027-01-31', '12월 8회', '12월 수강권')
) as v(name, price, cnt, dt, descr, grp);

-- 횟수 선택형(가격표 1/4/8 — 1회 × 횟수가 아닌 독립 가격) + 사이즈·횟수 모두 필요한 선택형
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_date, rolling_month_cutoff_day, rolling_month_allow_early_use, purchase_count_selectable, description, sizes)
select c.id, v.name, v.price, 'pass', 'count', null, false, 'date', '2026-12-31'::date, null, false, true, v.descr, v.sizes
from (select id from centers where name = '[UX] 격리 UX 시험 센터') c,
(values
 ('[UX] 자유 선택 수강권', 10000, '1/4/8회 선택형', null::text[]),
 ('[UX] 사이즈 선택 패키지', 20000, '4/8회 선택형 + 사이즈 필수', array['S','M','L']::text[])
) as v(name, price, descr, sizes);
insert into product_count_prices(product_id, count, price) select id, x.c, x.p from products, (values (1,10000),(4,36000),(8,64000)) x(c,p) where name = '[UX] 자유 선택 수강권';
insert into product_count_prices(product_id, count, price) select id, x.c, x.p from products, (values (4,76000),(8,140000)) x(c,p) where name = '[UX] 사이즈 선택 패키지';

-- 사이즈 필수 고정 상품(대여 슈즈)
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_date, purchase_count_selectable, description, sizes)
select id, '[UX] 대여 슈즈 · 사이즈 필수', 10000, 'goods', 'count', 1, false, 'date', '2026-12-31'::date, false, '사이즈 필수 고정 상품', array['240','245','250']::text[]
from centers where name = '[UX] 격리 UX 시험 센터';

-- 수업: 같은 이름의 서로 다른 두 수업(허용 수강권 다름) + 전체 허용 수업 + 선택형 수업
insert into classes(center_id, title, start_time, end_time, capacity, pass_selection_mode)
select c.id, v.title, now() + v.d, now() + v.d + interval '1 hour', 8, v.mode
from (select id from centers where name = '[UX] 격리 UX 시험 센터') c,
(values
 ('[UX] 같은 이름 수업', interval '3 days',  'selected'),
 ('[UX] 같은 이름 수업', interval '4 days',  'selected'),
 ('[UX] 전체 수강권 수업', interval '5 days', 'all'),
 ('[UX] 선택형 수강권 수업', interval '6 days', 'selected')
) as v(title, d, mode);

with cl as (select id, row_number() over (order by start_time) rn from classes where title = '[UX] 같은 이름 수업')
insert into class_allowed_products(class_id, product_id)
select cl.id, p.id from cl join products p on p.center_id = (select id from centers where name = '[UX] 격리 UX 시험 센터')
 and ((cl.rn = 1 and p.name like '[UX] 11월 수강권 %') or (cl.rn = 2 and p.name like '[UX] 12월 수강권 %'));
insert into class_allowed_products(class_id, product_id)
select cl.id, p.id from classes cl, products p where cl.title = '[UX] 선택형 수강권 수업' and p.name = '[UX] 자유 선택 수강권';
