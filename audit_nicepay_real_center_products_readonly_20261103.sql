-- 읽기 전용 점검(SELECT 만) — 운영 SQL Editor 에서 사용자가 실행해 "NICEPAY 심사관에게 보여 줄 실제 센터"의 상품이 실제로 제공 가능한 상태인지 확인한다.
-- 데이터를 바꾸지 않는다. 센터 이름만 바꿔 쓰면 된다(UUID 하드코딩 없음). Claude 는 운영 DB 에 접근하지 않았으므로 이 점검은 사용자가 실행한다.
with c as (select id, name, status, is_internal, is_nicepay_review from centers where name = 'A10TION 피겨팀')
select 'center' as section, c.name, c.status::text, c.is_internal::text, c.is_nicepay_review::text from c;

-- 1) 상품: 판매 상태·공개 범위·만료 규칙·구매 가능 여부(만료일이 오늘(KST) 이전이면 목록 제외 대상)
select 'product' as section, p.name, p.price, p.product_kind, p.pass_type, p.total_count, p.purchase_count_selectable,
       p.is_active, p.is_on_sale, p.visibility_type, p.expiry_mode, p.expiry_date, p.expiry_days, p.max_quantity,
       (p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date) as already_expired
from products p join centers c on c.id = p.center_id where c.name = 'A10TION 피겨팀' order by p.name;

-- 2) 횟수 선택형 가격표(표시 가격 대조용)
select 'count_price' as section, p.name, t.count, t.price
from product_count_prices t join products p on p.id = t.product_id join centers c on c.id = p.center_id
where c.name = 'A10TION 피겨팀' order by p.name, t.count;

-- 3) 수업 연결: 수강권이 어떤 수업에 쓰일 수 있는지(class_allowed_products) / 요일 고정 규칙(membership_schedule_rules) / 앞으로 열릴 수업 수
select 'class_link' as section, p.name,
       (select count(*) from class_allowed_products cap join classes cl on cl.id = cap.class_id where cap.product_id = p.id and cl.start_time >= now() and cl.status = 'open') as upcoming_open_classes_allowing_this_product,
       (select count(*) from membership_schedule_rules r where r.product_id = p.id) as weekday_rules
from products p join centers c on c.id = p.center_id where c.name = 'A10TION 피겨팀' order by p.name;
select 'center_classes' as section, count(*) filter (where cl.start_time >= now() and cl.status = 'open') as upcoming_open, count(*) as total
from classes cl join centers c on c.id = cl.center_id where c.name = 'A10TION 피겨팀';

-- 4) 기존 회원·판매 이력(참고: 이번 변경이 건드리지 않는 데이터의 규모)
select 'sales' as section, p.name, count(m.id) as memberships, count(m.id) filter (where m.status <> 'refunded') as not_refunded
from products p join centers c on c.id = p.center_id left join memberships m on m.product_id = p.id where c.name = 'A10TION 피겨팀' group by p.name order by p.name;
