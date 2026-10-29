-- 로컬 격리 스택 전용 QA 시드(공개 승인 센터 + 만료 유형별 상품). 운영/공유 DEV 데이터 아님.
with c as (insert into centers(name, status, is_internal) values ('[QA] 심사 시험 스튜디오', 'approved', false) returning id)
insert into center_settings(center_id) select id from c;
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_days, expiry_date, rolling_month_cutoff_day, rolling_month_allow_early_use, purchase_count_selectable, description)
select c.id, v.name, v.price, v.kind, v.pt, v.cnt, v.unl, v.mode, v.days, v.dt::date, v.cut, v.early, v.sel, v.descr from (select id from centers where name='[QA] 심사 시험 스튜디오') c,
(values
 ('[QA] 10회권 · 만료일 없음',            100000,'pass','count',10,false,'none',null,null,null,false,false,'만료일이 없는 횟수권'),
 ('[QA] 8회권 · 30일',                    80000,'pass','count',8,false,'days',30,null,null,false,false,null),
 ('[QA] 기간제 3개월 · 횟수 무제한',      250000,'pass','period',null,true,'days',90,null,null,false,false,null),
 ('[QA] 12회권 · 365일',                  150000,'pass','count',12,false,'days',365,null,null,false,false,null),
 ('[QA] 20회권 · 400일 (1년 초과 시험)',  200000,'pass','count',20,false,'days',400,null,null,false,false,null),
 ('[QA] 시즌권 · 고정 만료일',            300000,'pass','count',30,false,'date',null,'2027-06-30',null,false,false,null),
 ('[QA] 월 갱신 · 매월 20일 컷오프',      120000,'pass','count',8,false,'rolling_month',null,null,20,false,false,null),
 ('[QA] 월 갱신 · 조기 이용 허용',        120000,'pass','count',8,false,'rolling_month',null,null,20,true,false,null),
 ('[QA] 대여품 · 30일',                   10000,'goods','count',1,false,'days',30,null,null,false,false,null),
 ('[QA] 횟수 선택형 · 60일',              40000,'pass','count',null,false,'days',60,null,null,false,true,null)
) as v(name,price,kind,pt,cnt,unl,mode,days,dt,cut,early,sel,descr);
insert into product_count_prices(product_id, count, price) select id, x.c, x.p from products, (values (4,40000),(8,72000)) x(c,p) where name='[QA] 횟수 선택형 · 60일';
