-- F21: 기간 무제한(expires_at NULL) 수강권을 가진 대기자가 승격되지 않는 문제 (2026-10-23) — 후속 SQL, 운영 직접 적용 금지(Codex 검토·적용 대상)
--
-- 발견: 통합 회귀(tests/rls-real/lifecycle.rls.test.ts)에서 정원 마감 수업의 확정 예약을 취소했을 때, 대기 1번이 만료일 없는(expires_at NULL = 기간 무제한,
--      add_product_expiry_options.sql 로 허용된 값) 수강권이면 승격되지 않고 대기로 남았다. 원인: cancel_reservation 의 승격 루프가
--      `and expires_at >= current_date` 로만 수강권을 찾아 NULL 은 조건을 통과하지 못한다(NULL >= 날짜 = NULL). 같은 수강권의 예약
--      (reserve_with_membership)·수강권 목록(usable_memberships_for_classes)은 `expires_at is null or …` 가드를 이미 쓰고 있어 서로 어긋난다.
--      결과: 자리가 났는데 대기자가 승격되지 않아 조용히 건너뛰어지고(다음 대기자가 있으면 그 사람이 대신 승격), 대기자에게는 알림도 가지 않는다.
-- 수정: 그 한 조건만 `and (expires_at is null or expires_at >= current_date)` 로 바꾼다(승격 순서·차감·알림·그 밖의 조건 불변).
--      pg_get_functiondef 결과를 정확히 한 군데만 치환한다(0건/2건 이상이면 중단). 이미 가드가 있으면 아무것도 하지 않는다.
-- 호환: 앱 코드 변경 없음. 정책 영향: 만료일 없는 수강권도 만료일 있는 수강권과 똑같이 승격 대상이 된다(예약 때는 이미 그렇게 쓸 수 있었음).
-- 참고: current_date 는 DB 시간대 기준이고 예약 함수는 KST 날짜를 쓴다(자정 부근 경계 차이) — 이번 수정 범위 밖(별도 기록).

do $patch$
declare
    v_def text;
    v_n   integer;
begin
    v_def := pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure);
    if v_def ~* 'expires_at\s+is\s+null\s+or\s+expires_at\s*>=\s*current_date' then
        return;   -- 이미 적용됨
    end if;
    select count(*) into v_n from regexp_matches(v_def, 'and\s+expires_at\s*>=\s*current_date', 'gi');
    if v_n <> 1 then raise exception 'cancel_reservation: 치환 대상이 정확히 1곳이어야 해요(현재 %곳)', v_n; end if;
    v_def := regexp_replace(v_def, 'and\s+expires_at\s*>=\s*current_date', 'and (expires_at is null or expires_at >= current_date)', 'i');
    execute v_def;
end
$patch$;
