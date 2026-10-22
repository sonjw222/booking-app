-- ============================================================
-- [감사 F06·F12] 일일 예약 횟수 / 프라이빗 동시 수업 제한 — "켜짐인데 숫자 NULL" 저장 차단
--
-- 배경(운영 읽기 전용 확인, 2026-10-22): 화면은 토글만 켜도 `값 ?? 1`로 1을 보여 주지만 실제 저장값은 NULL이었다.
-- reserve_with_membership()은 enabled=true 이고 숫자가 NULL이 아닐 때만 제한하므로 "화면 1 / 실제 무제한"이 됐다.
-- 앱은 이제 ON 전환 시 숫자(기본 1)를 실제로 저장하고 빈 값·0·소수를 저장 전에 거부한다. 이 파일은 같은 규칙을 서버에서도 강제한다.
--
-- 설계:
--   · BEFORE INSERT/UPDATE 트리거. 이번 쓰기에서 해당 제한의 enabled/숫자를 "바꾸는" 경우에만 검사한다
--     → 이미 ON+NULL 로 남아 있는 기존 행의 다른 설정 저장(예: 휴무 설정)은 막지 않는다(기존 행은 verify 파일의 진단으로 별도 처리).
--   · 조용한 무제한이 아니라 명시적 오류를 낸다.
--   · reserve_with_membership/reserve_class의 제한 계산(범위·확정 기준)은 건드리지 않는다.
-- 적용: SQL Editor에 파일 전체. 여러 번 실행해도 안전(create or replace / drop trigger if exists).
-- 되돌리기: rollback_fix_center_limit_settings_normalize_20261022.sql
-- 검증: verify_fix_center_limit_settings_normalize_20261022.sql (읽기 전용)
-- ============================================================

create or replace function center_settings_limit_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if (tg_op = 'INSERT'
        or new.daily_book_limit_enabled is distinct from old.daily_book_limit_enabled
        or new.daily_book_limit is distinct from old.daily_book_limit)
       and coalesce(new.daily_book_limit_enabled, false)
       and (new.daily_book_limit is null or new.daily_book_limit < 1 or new.daily_book_limit > 99) then
        raise exception '일일 예약 횟수 제한을 켜려면 1~99 사이의 숫자가 필요해요';
    end if;

    if (tg_op = 'INSERT'
        or new.private_max_concurrent_enabled is distinct from old.private_max_concurrent_enabled
        or new.private_max_concurrent is distinct from old.private_max_concurrent)
       and coalesce(new.private_max_concurrent_enabled, false)
       and (new.private_max_concurrent is null or new.private_max_concurrent < 1 or new.private_max_concurrent > 99) then
        raise exception '프라이빗 동시 수업 제한을 켜려면 1~99 사이의 숫자가 필요해요';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_center_settings_limit_guard on center_settings;
create trigger trg_center_settings_limit_guard
    before insert or update on center_settings
    for each row execute function center_settings_limit_guard();
