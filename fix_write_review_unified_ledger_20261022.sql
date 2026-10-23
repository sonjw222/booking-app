-- ============================================================
-- [감사 F13] 후기 보상 장부 불일치 + 후기 수정 시 보상 중복
--
-- 확정된 원인(운영 함수 정의를 읽기 전용으로 확인, 2026-10-22):
--   · write_review 가 두 개 공존한다.
--       4인자: reviews(옛 테이블)에 쓰고 point_transactions(통합 원장)에 적립 — 프런트가 쓰지 않는다.
--       5인자(사진 포함): center_reviews 에 쓰지만 point_accounts/point_logs(옛 장부)에 적립 — 프런트가 실제로 호출한다.
--     회원 잔액(my_point_balance/my_point_balances)과 결제 사용(use_points)은 통합 원장만 읽으므로 후기 보상이 쓰이지 않고 옛 장부에 쌓인다.
--   · 후기 수정은 기존 후기를 삭제한 뒤 write_review 를 다시 호출했다 → 새 행이 생겨 보상이 다시 지급되고 후기 ID·관리자 답변이 사라졌다.
--
-- 이 파일이 하는 일(스키마 1개 추가 + 함수 교체, 데이터 이관 없음):
--   1) point_transactions.review_id (nullable) + 부분 unique 인덱스 — 같은 후기 행에 대한 보상은 한 번만(재시도·중복 요청에서도 1회).
--   2) write_review(5인자)를 center_reviews + 통합 원장(point_transactions)으로 교체. 작성 자격·중복 작성 거부 규칙은 그대로.
--   3) write_review(4인자)는 5인자로 위임하는 얇은 래퍼로 교체(옛 reviews 테이블에 쓰는 경로 제거).
--   4) update_my_review(): 내 후기의 별점·내용·사진만 같은 행에서 수정 — ID·관리자 답변(reply/replied_at)·작성일 보존, 보상 없음.
--
-- 이 파일이 하지 않는 일:
--   · 옛 장부(point_accounts/point_logs)의 기존 잔액·QA 2000P를 옮기거나 지우지 않는다 → diagnose_point_ledger_mismatch_20261022.sql(읽기 전용) 로 확인하고,
--     이관은 proposed_migrate_legacy_review_points_20261022.sql 을 검토·승인 후 별도 실행.
--   · 후기 삭제 후 재작성 시 보상 재지급 정책은 바꾸지 않는다(현행 유지 — "삭제 시 포인트는 회수되지 않음"). 정책 결정 필요(아래 주석 참고).
--   · center_reviews RLS 정책은 바꾸지 않는다.
-- 적용: SQL Editor에 파일 전체. 여러 번 실행해도 안전. 되돌리기: rollback_fix_write_review_unified_ledger_20261022.sql
-- ============================================================

alter table point_transactions add column if not exists review_id uuid references center_reviews(id) on delete set null;
create unique index if not exists uq_point_transactions_review_reward on point_transactions(review_id) where review_id is not null;

create or replace function write_review(
    p_center_id uuid,
    p_profile_id uuid,
    p_rating int,
    p_content text,
    p_photos text[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_has_pass  int;
    v_point     int;
    v_review_id uuid;
    v_given     int := 0;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 프로필로만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_has_pass from memberships where profile_id = p_profile_id and center_id = p_center_id;
    if v_has_pass = 0 then
        select count(*) into v_has_pass from orders
        where profile_id = p_profile_id and center_id = p_center_id and status in ('paid', 'done');
    end if;
    if v_has_pass = 0 then
        raise exception '이 센터의 수강권을 구매한 적이 있는 회원만 후기를 쓸 수 있어요';
    end if;

    if exists (select 1 from center_reviews where center_id = p_center_id and profile_id = p_profile_id) then
        raise exception '이미 이 센터에 후기를 작성했어요';
    end if;

    insert into center_reviews (center_id, profile_id, rating, content, photos)
    values (p_center_id, p_profile_id, p_rating, p_content, p_photos)
    returning id into v_review_id;

    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        -- 통합 원장에만 기록. 같은 후기 행의 보상은 unique 인덱스로 1회만(충돌하면 0건 삽입).
        insert into point_transactions (profile_id, center_id, amount, reason, review_id)
        values (p_profile_id, p_center_id, v_point, '후기 작성 적립', v_review_id)
        on conflict (review_id) where review_id is not null do nothing;
        get diagnostics v_given = row_count;
    end if;

    return json_build_object('point', case when v_given > 0 then v_point else 0 end, 'review_id', v_review_id);
end;
$$;

create or replace function write_review(
    p_center_id uuid,
    p_profile_id uuid,
    p_rating int,
    p_content text
)
returns json
language sql
security definer
set search_path = public
as $$
    select write_review(p_center_id, p_profile_id, p_rating, p_content, null::text[]);
$$;

create or replace function update_my_review(
    p_review_id uuid,
    p_rating int,
    p_content text,
    p_photos text[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row center_reviews;
begin
    select * into v_row from center_reviews where id = p_review_id for update;
    if not found or v_row.profile_id not in (select my_profile_ids()) then
        raise exception '내 후기를 찾을 수 없어요';
    end if;
    if p_rating is null or p_rating < 1 or p_rating > 5 then
        raise exception '별점은 1~5 사이여야 해요';
    end if;
    -- 별점·내용·사진만 바꾼다. id / reply / replied_at / hidden / created_at / 보상 이력은 그대로.
    update center_reviews set rating = p_rating, content = p_content, photos = p_photos where id = p_review_id;
    return json_build_object('point', 0, 'review_id', p_review_id);
end;
$$;

revoke all on function write_review(uuid, uuid, int, text, text[]) from public, anon;
revoke all on function write_review(uuid, uuid, int, text) from public, anon;
revoke all on function update_my_review(uuid, int, text, text[]) from public, anon;
grant execute on function write_review(uuid, uuid, int, text, text[]) to authenticated;
grant execute on function write_review(uuid, uuid, int, text) to authenticated;
grant execute on function update_my_review(uuid, int, text, text[]) to authenticated;

-- [정책 결정 필요] 삭제 후 재작성: center_reviews 는 (센터, 프로필) 당 1행이라 후기를 지우면 새 행으로 다시 쓸 수 있고 새 보상이 지급된다.
-- 앱은 이제 "수정"에서 삭제를 쓰지 않으므로 일반 사용에서는 중복되지 않지만, 직접 삭제 후 재작성은 가능하다. 막으려면(센터·프로필당 보상 1회)
-- point_transactions 에 (profile_id, center_id) 부분 unique 인덱스(reason = '후기 작성 적립')를 추가하는 방법이 있으나 정책 결정 전에는 적용하지 않는다.

-- PostgREST(API) 스키마 캐시 갱신
notify pgrst, 'reload schema';
