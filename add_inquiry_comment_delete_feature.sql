-- ============================================================
-- 문의 게시판 댓글 삭제 기능 신규 추가 (P2-31 카테고리 D)
--
-- 배경: board.inquiry.comment 권한 라벨은 "댓글 등록, 수정, 삭제"라고 돼 있지만
--   실제로는 등록(send_inquiry_message)만 구현돼 있었다 — inquiry_messages에
--   delete 정책도 RPC도 전혀 없었다(P1-5b 조사 때 이미 확인, 그때는 범위 밖이라 미구현
--   상태로 남겨둠). board.inquiry.comment_other(다른 스태프 댓글 삭제)도 대응하는
--   삭제 기능 자체가 없어 죽은 키였다.
--
-- 이번에 신규로 만드는 것:
--   - delete_inquiry_message_safe(p_message_id): 매니저가 보낸 메시지만 삭제 대상.
--     본인 메시지면 board.inquiry.comment로, 다른 스태프 메시지면
--     board.inquiry.comment_other로 허용. 회원이 보낸 메시지는 이 RPC로 절대
--     삭제할 수 없다(이 권한 카테고리는 스태프 쪽 게시판 관리용).
--
-- 하드 삭제 방식을 쓴다 — 이 저장소에 채팅류 데이터의 소프트삭제(deleted_at 등)
-- 관례가 없고, delete_class_safe 등 기존 삭제 RPC들도 전부 하드 삭제라 일관성을 맞춤.
--
-- 참고: 메시지를 지워도 inquiry_threads.last_message/last_message_at는 갱신하지
-- 않는다(그 메시지가 마지막 메시지였다면 목록 미리보기가 잠깐 stale해질 수 있음) —
-- 사소한 UX 디테일이라 이번 배치 범위 밖으로 남겨둔다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function delete_inquiry_message_safe(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center  uuid;
    v_sender  uuid;
    v_role    text;
begin
    select t.center_id, m.sender_account_id, m.sender_role
      into v_center, v_sender, v_role
      from inquiry_messages m
      join inquiry_threads t on t.id = m.thread_id
     where m.id = p_message_id;

    if v_center is null then
        raise exception '메시지를 찾을 수 없어요';
    end if;

    if v_role <> 'manager' then
        raise exception '회원이 보낸 메시지는 이 기능으로 삭제할 수 없어요';
    end if;

    if not (
        (v_sender = my_account_id() and has_permission(v_center, 'board.inquiry.comment'))
        or has_permission(v_center, 'board.inquiry.comment_other')
        or is_platform_admin()
    ) then
        raise exception '이 댓글을 삭제할 권한이 없어요';
    end if;

    delete from inquiry_messages where id = p_message_id;
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select proname from pg_proc where proname = 'delete_inquiry_message_safe';
