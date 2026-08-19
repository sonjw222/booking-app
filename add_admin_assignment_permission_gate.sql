-- ============================================================
-- P1-9 관리자 직접배치 — 권한으로 제한
--
-- 지금까지는 센터의 활성 매니저/스태프 전원이 관리자 직접배치(admin_assign_reservation)/
-- 무료 추가배치·취소(admin_cancel_reservation)를 쓸 수 있었다(2026-07-30 결정, docs/TODO.md
-- P1-9 참고 — 당시엔 새 permission key를 만들지 않기로 했었음). 사용자 결정(2026-08-15)으로
-- 이제 특정 권한이 있는 스태프만 쓸 수 있게 제한한다.
--
-- 새 permission key를 만들지 않는다 — 카탈로그에 이미 `schedule.makeup`("보강 예약",
-- "수강권 조건과 무관하게 회원을 수업에 예약할 수 있습니다")가 있는데 코드 어디에서도
-- 참조되지 않는 죽은 항목이었다. 설명이 admin_assign_reservation의 동작(수강권 종류/예약
-- 조건 무시)과 정확히 일치해 원래 이 용도로 만들어졌다가 연결이 안 된 것으로 보여, 그대로
-- 재사용한다.
--
-- can_manage_center_reservations()만 바꾸면 admin_assign_reservation·admin_cancel_
-- reservation 둘 다 이 함수 하나로 권한을 확인하므로 함께 적용된다(오너는 has_permission()이
-- 자동 통과).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function can_manage_center_reservations(p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select has_permission(p_center_id, 'schedule.makeup') or is_platform_admin();
$$;
