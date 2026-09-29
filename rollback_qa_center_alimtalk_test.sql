-- add_qa_center_alimtalk_test.sql 롤백 — QA 센터와 그 하위 데이터만 제거한다.
-- 보존 계정(sonjw8030)의 accounts/profiles 행은 절대 건드리지 않는다(이 스크립트는
-- center_members/manager_centers/center_roles/centers에서 이 센터를 참조하는 행만 지운다).
do $$
declare
    v_center_id uuid;
begin
    select id into v_center_id from centers where name = '[QA] 모하빗 알림톡 테스트 센터';
    if v_center_id is null then
        raise notice 'QA 센터가 이미 없어요 — 할 일 없음';
        return;
    end if;

    delete from center_members where center_id = v_center_id;
    delete from manager_centers where center_id = v_center_id;
    delete from center_roles where center_id = v_center_id;
    delete from centers where id = v_center_id;

    raise notice 'QA_CENTER_REMOVED center_id=%', v_center_id;
end $$;

-- 확인(0이어야 정상 롤백)
select count(*) as qa_center_remaining from centers where name = '[QA] 모하빗 알림톡 테스트 센터';
