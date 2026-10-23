-- fix_write_review_unified_ledger_20261022.sql 되돌리기.
-- 함수는 이 파일 적용 직전 운영 정의(2026-10-22 읽기 전용 확인본: 5인자=center_reviews+옛 장부, 4인자=reviews+통합 원장)로 복원한다.
-- review_id 컬럼·인덱스는 남긴다(삭제하면 이미 기록된 보상-후기 연결이 사라진다; 필요하면 수동으로 drop).
drop function if exists update_my_review(uuid, int, text, text[]);

create or replace function write_review(p_center_id uuid, p_profile_id uuid, p_rating integer, p_content text, p_photos text[] default null)
returns json language plpgsql security definer as $$
declare v_has_pass int; v_point int; v_exists int;
begin
    if p_profile_id not in (select my_profile_ids()) then raise exception '본인 프로필로만 후기를 쓸 수 있어요'; end if;
    select count(*) into v_has_pass from memberships where profile_id = p_profile_id and center_id = p_center_id;
    if v_has_pass = 0 then
        select count(*) into v_has_pass from orders where profile_id = p_profile_id and center_id = p_center_id and status in ('paid', 'done');
    end if;
    if v_has_pass = 0 then raise exception '이 센터의 수강권을 구매한 적이 있는 회원만 후기를 쓸 수 있어요'; end if;
    select count(*) into v_exists from center_reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then raise exception '이미 이 센터에 후기를 작성했어요'; end if;
    insert into center_reviews (center_id, profile_id, rating, content, photos) values (p_center_id, p_profile_id, p_rating, p_content, p_photos);
    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        insert into point_accounts (center_id, profile_id, balance) values (p_center_id, p_profile_id, v_point)
        on conflict (center_id, profile_id) do update set balance = point_accounts.balance + v_point, updated_at = now();
        insert into point_logs (center_id, profile_id, amount, reason, memo) values (p_center_id, p_profile_id, v_point, 'review', '후기 작성 적립');
    end if;
    return json_build_object('point', v_point);
end;
$$;

create or replace function write_review(p_center_id uuid, p_profile_id uuid, p_rating integer, p_content text)
returns json language plpgsql security definer as $$
declare v_has_pass int; v_point int; v_exists int;
begin
    if p_profile_id not in (select my_profile_ids()) then raise exception '본인 프로필로만 후기를 쓸 수 있어요'; end if;
    select count(*) into v_has_pass from memberships where profile_id = p_profile_id and center_id = p_center_id;
    if v_has_pass = 0 then raise exception '이 센터의 수강권을 구매한 회원만 후기를 쓸 수 있어요'; end if;
    select count(*) into v_exists from reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then raise exception '이미 이 센터에 후기를 작성했어요'; end if;
    insert into reviews (center_id, profile_id, rating, content) values (p_center_id, p_profile_id, p_rating, p_content);
    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then insert into point_transactions (profile_id, center_id, amount, reason) values (p_profile_id, p_center_id, v_point, '후기 작성 적립'); end if;
    return json_build_object('point', v_point);
end;
$$;
