-- 읽기 전용 검증 — 결과를 확인만 하세요(쓰기 없음).
-- 1) 트리거가 있어야 한다(true)
select exists (select 1 from pg_trigger where tgname = 'trg_center_settings_limit_guard' and tgrelid = 'center_settings'::regclass and not tgisinternal) as trigger_present;
-- 2) 기존에 "켜짐인데 숫자 NULL/범위 밖"인 행(화면에는 1로 보였지만 서버는 무제한으로 처리해 온 행). 0행이면 정리할 것이 없다.
--    이 목록을 센터 관리자에게 확인받은 뒤 처리 방법을 정한다(자동 보정하지 않는다):
--      A) 화면에 보이던 값 그대로 1로 저장 → 그 센터는 실제로 제한이 시작됨(행동 변화)
--      B) 제한을 끔(enabled=false) → 지금의 실제 동작(무제한) 유지
select center_id,
       daily_book_limit_enabled, daily_book_limit,
       private_max_concurrent_enabled, private_max_concurrent
from center_settings
where (daily_book_limit_enabled   and (daily_book_limit is null or daily_book_limit < 1 or daily_book_limit > 99))
   or (private_max_concurrent_enabled and (private_max_concurrent is null or private_max_concurrent < 1 or private_max_concurrent > 99));
