-- 롤백 — grant_nicepay_review_real_center_20261106_proposed.sql 이 넣은 허용 1행만 삭제한다(⚠ 실행하지 않았다). 계정·센터 UUID 로 한 행만 지정, 전체 삭제 없음.
begin;
do $r$
declare
    c_center constant uuid := '8965e09c-0d2b-44c6-ab26-40a85507f8b5';
    c_auth   constant uuid := '7ffcf57d-b6d1-4562-a260-33be15f66ee5';
    v_account uuid;
    v_row record;   -- %rowtype 은 테이블이 없으면 선언 단계에서 오류가 나므로 record 사용(테이블이 없는 상태에서도 정상 종료)
    v_n int;
begin
    perform pg_advisory_xact_lock(hashtext('nicepay-review-grant-20261106'));
    if to_regclass('public.nicepay_review_center_grants') is null then raise notice '허용 테이블이 없어요(이미 정리됨) — 아무것도 바꾸지 않음'; return; end if;
    select a.id into v_account from accounts a where a.auth_id = c_auth;
    if v_account is null then raise exception '롤백 중단: 심사 계정을 찾지 못했어요'; end if;
    select * into v_row from nicepay_review_center_grants where account_id = v_account and center_id = c_center for update;
    if not found then raise notice '이미 없음: 삭제할 허용 행이 없어요(아무것도 바꾸지 않음)'; return; end if;
    if v_row.can_purchase then raise exception '롤백 중단: 이 행은 구매 허용(can_purchase=true)으로 바뀌어 있어요 — 의도한 변경인지 확인 후 직접 처리하세요'; end if;
    delete from nicepay_review_center_grants where account_id = v_account and center_id = c_center;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '롤백 취소: 삭제 행이 1개가 아니에요(%개)', v_n; end if;
    raise notice '허용 1행 삭제 완료';
end
$r$;
commit;
