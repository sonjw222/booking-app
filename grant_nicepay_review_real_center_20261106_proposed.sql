-- NICEPAY 심사 계정(niceqa)에게 실제 센터(A10TION 피겨팀) 상품 "조회 + 카드 결제창 확인(승인 없음)" 허용 — 제안(2026-11-06), ⚠ 실행하지 않았다. 사용자 승인 후 SQL Editor 에서 실행.
-- 선행 조건: ① 센터 운영자(A10TION)의 동의 ② add_nicepay_review_real_center_grants_20261103.sql 적용 + verify 통과 ③ audit_nicepay_review_path_readonly_20261106.sql 결과 확인.
-- 변경: nicepay_review_center_grants 에 정확히 1행 INSERT (account=niceqa 계정, center=A10TION, can_purchase=false). 다른 테이블·행은 바꾸지 않는다. 조회 전용이라 주문·장바구니·구매신청·예약은 서버가 거부하고, 카드 결제 승인은 열리지 않는다.
-- 효과: 심사관의 홈·검색은 허용 센터(A10TION)만 보이고(별도 심사 센터는 탐색에서 제외), 앱의 "카드 결제창 확인(승인 없음)"이 A10TION 판매 중 상품에서 열린다(인증창만, 주문·이용권 없음).
-- 되돌리기: rollback_grant_nicepay_review_real_center_20261106.sql (이 1행만 삭제). 센터 상태가 바뀌어 승인 취소·내부 전환되면 허용은 즉시 무효.
begin;
do $g$
declare
    c_center  constant uuid := '8965e09c-0d2b-44c6-ab26-40a85507f8b5';
    c_auth    constant uuid := '7ffcf57d-b6d1-4562-a260-33be15f66ee5';
    v_account uuid;
    v_n int;
begin
    perform pg_advisory_xact_lock(hashtext('nicepay-review-grant-20261106'));
    if to_regclass('public.nicepay_review_center_grants') is null then
        raise exception '중단: 허용 목록 테이블이 없어요 — 먼저 add_nicepay_review_real_center_grants_20261103.sql 을 적용하세요';
    end if;
    select a.id into v_account from accounts a join auth.users u on u.id = a.auth_id
     where u.id = c_auth and lower(u.email) = 'niceqa@mwhabit.com' and u.email_confirmed_at is not null
       and a.nicepay_review_access and a.is_member and a.deactivated_at is null and a.merged_into is null;
    if v_account is null then
        raise exception '중단: niceqa 계정이 예상 조건(UID·이메일 인증·심사 권한·회원·비탈퇴)과 달라요';
    end if;
    if exists (select 1 from manager_centers where account_id = v_account and status = 'active') then
        raise exception '중단: 심사 계정이 센터 매니저로도 등록돼 있어요(권한 과다) — audit SQL 결과를 확인하세요';
    end if;
    if not exists (select 1 from centers where id = c_center and name = 'A10TION 피겨팀' and status = 'approved' and not is_internal and not is_nicepay_review) then
        raise exception '중단: A10TION 센터가 예상 값과 달라요(이름/승인/비내부/비심사 센터)';
    end if;
    select count(*) into v_n from products p where p.center_id = c_center and p.is_active and p.is_on_sale
       and not coalesce(p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date, false);
    if v_n < 1 then
        raise exception '중단: A10TION 에 현재 판매 중인(미만료) 상품이 없어요 — 보여 줄 상품이 없습니다';
    end if;
    if exists (select 1 from nicepay_review_center_grants where account_id = v_account and center_id = c_center) then
        raise exception '중단: 이미 허용되어 있어요(중복 실행 방지). 아무것도 바꾸지 않았어요';
    end if;
    insert into nicepay_review_center_grants (account_id, center_id, can_purchase, note)
    values (v_account, c_center, false, 'NICEPAY 카드사 심사: 실제 수강권 조회·결제창 확인(승인 없음) — 2026-11-06');
    raise notice '허용 1행 추가: account=%, center=%, 판매 중 상품 %개', v_account, c_center, v_n;
end
$g$;
commit;
-- 확인(읽기 전용): 정확히 1행, can_purchase=false
select g.account_id, g.center_id, c.name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id = g.center_id;
