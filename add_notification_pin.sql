-- ============================================================
-- 알림 고정(pin) — 릴리스 폴리시 배치 8차(2026-09-17)
--
-- 관리자 알림 화면에 swipe action "고정 / 고정 해제"를 추가하면서, 고정 상태를
-- React state/localStorage에만 두지 말라는 요구사항(기기 재설치·재로그인·다른 기기에서
-- 사라짐, 요구사항 문서 9번 "notification pin localStorage-only 금지")에 따라 서버에
-- 영구 저장한다.
--
-- 기존 notifications 테이블(add_notifications.sql)의 RLS 정책이 이미
--   - "알림 본인 조회" (select, recipient_account_id = my_account_id())
--   - "알림 본인 수정" (update, recipient_account_id = my_account_id())
--   - "알림 본인 삭제" (delete, recipient_account_id = my_account_id())
-- 를 전부 갖추고 있어서(본인 소유 판정만으로 이미 update/delete 허용), pinned 컬럼 하나만
-- 추가하면 새 RLS 정책 없이 클라이언트에서 바로 토글/전체삭제가 가능하다.
--
-- 여러 번 실행해도 안전(add column if not exists / create index if not exists).
-- ============================================================

alter table notifications
    add column if not exists pinned boolean not null default false;

-- 목록 정렬: 고정 알림을 최상단으로, 고정 안의 정렬은 최신순 유지(pinned desc, created_at desc).
create index if not exists idx_notifications_recipient_pinned
    on notifications(recipient_account_id, pinned desc, created_at desc);
