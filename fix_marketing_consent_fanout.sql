-- ============================================================
-- Privacy Release Blocker Batch #2 (2026-09-20) — 광고성 알림 팬아웃이
-- accounts.marketing_consent를 전혀 확인하지 않던 문제 수정
--
-- 근본 원인:
--   add_marketing_consent.sql(2026-09-19)이 accounts.marketing_consent /
--   marketing_consent_at 컬럼을 만들고 가입/마이페이지에서 값을 저장하도록 했지만,
--   "그 값을 읽어서 발송 대상을 거르는" 쪽은 어디에도 연결되지 않았다. 그 결과
--   광고성 알림을 만드는 두 경로가 동의 여부와 무관하게 전체 회원을 대상으로 삼았다.
--
--   (1) create_marketing_message_safe()  — add_marketing_notifications.sql
--       운영자가 보내는 플랫폼 전체 혜택·이벤트 알림. 대상 선정이
--       `select id from accounts where is_member = true` 뿐이라 마케팅 수신에
--       동의하지 않은 회원(기본값 false)과 이미 탈퇴/익명화된 계정(deactivated_at
--       not null — 익명화만 하고 행은 남기는 구조라 is_member가 계속 true다)에게도
--       광고 알림 행이 만들어졌다. 정보통신망법상 광고성 정보 전송은 사전 동의
--       (opt-in)가 필요하므로 릴리스 블로커.
--
--   (2) evaluate_notification_rules()  — 최신 정의는
--       fix_notification_rule_alimtalk_template_code.sql(2026-09-08)
--       센터별 알림톡 자동 발송 규칙 5종 중 'birthday'(생일 축하·혜택)와
--       'expired_rebuy'(만료 후 재구매 유도)는 성격상 광고성인데, 대상 선정이
--       memberships/profiles만 보고 수신 동의를 확인하지 않았다.
--
-- 하는 일(최소 변경 — 대상 선정(recipient selection) 단계에만 조건을 추가한다.
-- 발송 채널(push_notification / messages 큐 / 알리고 / FCM / 웹푸시) 쪽 로직은
-- 전혀 건드리지 않는다):
--   1) create_marketing_message_safe(): 대상 쿼리에
--      `and marketing_consent is true and deactivated_at is null` 추가.
--   2) evaluate_notification_rules(): 'birthday'와 'expired_rebuy' 분기에만
--      `join accounts a on a.id = pr.account_id and a.marketing_consent is true` 추가.
--
-- ⚠ 최종 안전 보완(운영 적용 직전 재검증, 같은 날): delete-account Edge Function은
-- 탈퇴 시 accounts.marketing_consent를 false로 바꾸지 않는다(익명화 대상이 아니라서
-- 의도적으로 안 건드림 — 동의 이력 자체는 개인속성이 아니라 보존해도 무방하다고 판단한
-- 부분). 즉 탈퇴 전 마케팅 수신에 동의했던 계정은 탈퇴 후에도 marketing_consent가
-- true로 남는다. create_marketing_message_safe()는 `deactivated_at is null`을 이미
-- 같이 확인해 안전하지만, evaluate_notification_rules()의 광고성 두 분기
-- (birthday/expired_rebuy)는 `a.marketing_consent is true`만 있고 탈퇴 계정 제외
-- 조건이 없어서, 탈퇴 후에도 marketing_consent가 true로 남은 계정에는 계속 광고성
-- 알림톡이 나갈 수 있었다. 두 분기 모두에 `and a.deactivated_at is null`을 추가해
-- 마케팅 수신 동의 여부와 무관하게 탈퇴 계정을 모든 광고성 자동 fanout 대상에서
-- 무조건 제외한다.
--
-- 필수(운영) 알림은 의도적으로 건드리지 않는다 — 수신 동의와 무관하게 지금까지와
-- 똑같이 모든 회원에게 나가야 한다:
--   - evaluate_notification_rules()의 count_low / membership_expiring / pause_ending
--     (수강권 잔여·만료·일시정지 종료 안내 = 계약 이행 고지)
--   - create_announcement(), notify_upcoming_reservations(), notify_expiring_passes(),
--     예약 확정/취소/대기 승급/노쇼/결제 관련 트리거(add_notification_triggers.sql 등)
--   이 파일은 위 함수들을 재정의하지 않으므로 그대로 유지된다.
--
-- `is true`를 쓰는 이유: marketing_consent는 `not null default false`라 현재 스키마상
-- NULL이 나올 수 없지만, `= true`는 값이 NULL이면 UNKNOWN이 되어 조건에서 빠지는 반면
-- `is true`는 NULL을 명시적으로 false로 취급한다 — "동의 기록이 없으면 미동의"라는
-- opt-in 원칙을 스키마 변경과 무관하게 보장한다.
--
-- 동의 철회 즉시 반영: 두 함수 모두 발송 시점에 accounts를 직접 조인/조회하므로
-- 캐시된 값이 아니라 그 시점의 최신 marketing_consent를 본다. 철회(false) 이후
-- 새로 만들어지는 팬아웃에서는 즉시 제외된다(이미 보내진 과거 알림은 그대로).
--
-- ⚠ (2)의 함수 본문은 2026-09-08 fix_notification_rule_alimtalk_template_code.sql의
-- 정의를 그대로 베이스로 삼고 동의 조건만 추가한 것이다. 그 파일이
-- add_notification_rule_count_filter.sql / add_notification_rule_product_filter.sql의
-- 보강(threshold_count/days_before 조합 조건, notification_rules.product_id 필터,
-- messages.rule_membership_id 기반 멱등 체크)을 이미 되돌려 놓은 상태였다 —
-- 이번 파일은 그 기존 문제를 고치지도, 더 악화시키지도 않는다(docs/TODO.md P2 항목으로 기록).
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(create or replace function만 사용 — 테이블/컬럼/정책 변경 없음).
-- ============================================================

-- ------------------------------------------------------------
-- 1) 플랫폼 전체 마케팅 알림 — 수신 동의자 + 미탈퇴 계정만
-- ------------------------------------------------------------
create or replace function create_marketing_message_safe(p_title text, p_body text, p_link text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id    uuid;
    v_count int := 0;
    r       record;
begin
    if not is_platform_admin() then
        raise exception '운영자만 마케팅 알림을 보낼 수 있어요';
    end if;
    if coalesce(trim(p_title), '') = '' or coalesce(trim(p_body), '') = '' then
        raise exception '제목과 내용을 모두 입력해주세요';
    end if;

    insert into marketing_messages (title, body, link, created_by)
    values (p_title, p_body, p_link, my_account_id())
    returning id into v_id;

    -- 광고성 정보이므로 사전 수신 동의(opt-in)한 회원에게만 보낸다.
    -- marketing_consent가 NULL이어도 `is true`가 false로 취급해 제외한다.
    -- deactivated_at is not null = 탈퇴(익명화)된 계정 — 행은 남지만 발송 대상 아님.
    for r in
        select id from accounts
         where is_member = true
           and marketing_consent is true
           and deactivated_at is null
    loop
        perform push_notification(
            r.id, 'marketing', p_title, p_body, null, p_link,
            jsonb_build_object('marketing_message_id', v_id)
        );
        v_count := v_count + 1;
    end loop;

    update marketing_messages set target_count = v_count where id = v_id;

    return v_id;
end;
$$;

comment on function create_marketing_message_safe(text, text, text) is
    '운영자가 전체 회원에게 마케팅(혜택·이벤트) 알림을 발송한다. 발송 대상은 '
    'accounts.marketing_consent = true이고 탈퇴하지 않은 회원 역할 계정만(광고성 정보 opt-in).';

revoke all on function create_marketing_message_safe(text, text, text) from public;
revoke all on function create_marketing_message_safe(text, text, text) from anon;
grant execute on function create_marketing_message_safe(text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 2) 알림톡 자동 발송 규칙 — 광고성 2종(birthday / expired_rebuy)만 동의 게이트 +
--    탈퇴 계정 제외 추가. 나머지 3종(count_low / membership_expiring / pause_ending)은
--    필수 운영 알림이라 기존 쿼리 그대로(동의 여부와 무관하게 전원 대상).
-- ------------------------------------------------------------
create or replace function evaluate_notification_rules()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    rule     record;
    target   record;
    v_tpl    text;
    v_tplcode text;
    v_msg    text;
    v_count  int := 0;
begin
    for rule in
        select * from notification_rules
         where is_active = true and send_alimtalk = true and template_id is not null
    loop
        select content, aligo_template_code into v_tpl, v_tplcode from alimtalk_templates
         where id = rule.template_id and status = 'approved' and is_active = true;
        if v_tpl is null then
            continue; -- 승인 안 된(또는 없는) 템플릿이면 발송하지 않음
        end if;

        -- [필수 운영 알림] 잔여횟수 임박 — 동의 게이트 없음(변경 없음)
        if rule.trigger_type = 'count_low' and rule.threshold_count is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name, m.remaining_count,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'active'
                   and m.center_id = rule.center_id
                   and m.remaining_count = rule.threshold_count
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name),
                    '[[수강권 잔여횟수]]', target.remaining_count::text);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
                v_count := v_count + 1;
            end loop;

        -- [필수 운영 알림] 수강권 만료 임박 — 동의 게이트 없음(변경 없음)
        elsif rule.trigger_type = 'membership_expiring' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name, m.expires_at,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'active'
                   and m.center_id = rule.center_id
                   and m.expires_at = current_date + rule.days_before
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name),
                    '[[수강권 잔여일]]', rule.days_before::text);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
                v_count := v_count + 1;
            end loop;

        -- [광고성] 만료 후 재구매 유도 — 마케팅 수신 동의자 + 탈퇴하지 않은 계정만
        elsif rule.trigger_type = 'expired_rebuy' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                  join accounts a on a.id = pr.account_id
                 where m.status = 'expired'
                   and m.center_id = rule.center_id
                   and m.expires_at = current_date - rule.days_before
                   and a.marketing_consent is true
                   and a.deactivated_at is null
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
                v_count := v_count + 1;
            end loop;

        -- [필수 운영 알림] 일시정지 종료 임박 — 동의 게이트 없음(변경 없음)
        elsif rule.trigger_type = 'pause_ending' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'paused'
                   and m.center_id = rule.center_id
                   and m.paused_until = current_date + rule.days_before
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
                v_count := v_count + 1;
            end loop;

        -- [광고성] 생일 축하·혜택 — 마케팅 수신 동의자 + 탈퇴하지 않은 계정만
        elsif rule.trigger_type = 'birthday' then
            for target in
                select distinct pr.id as profile_id, pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                  join accounts a on a.id = pr.account_id
                 where m.center_id = rule.center_id
                   and pr.birth_date is not null
                   and a.marketing_consent is true
                   and a.deactivated_at is null
                   and extract(month from pr.birth_date) = extract(month from (now() at time zone 'Asia/Seoul'))
                   and extract(day from pr.birth_date) = extract(day from (now() at time zone 'Asia/Seoul'))
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(v_tpl, '[[회원명]]', target.member_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
                v_count := v_count + 1;
            end loop;
        end if;
    end loop;

    return v_count;
end;
$$;

comment on function evaluate_notification_rules() is
    '활성 알림톡 자동 발송 규칙을 평가해 대상 회원에게 messages 큐 행을 만든다(템플릿 코드 포함). '
    '광고성 규칙(birthday/expired_rebuy)은 accounts.marketing_consent = true이고 deactivated_at이 '
    'null인(탈퇴하지 않은) 회원만 대상으로 하고, 필수 운영 알림(count_low/membership_expiring/'
    'pause_ending)은 동의·탈퇴 여부와 무관하게 전원 대상. 실제 발송은 dispatch-alimtalk cron이 담당';

-- ============================================================
-- 확인
-- ============================================================

-- (1) 두 함수 정의에 동의 조건이 실제로 반영됐는지 — 아래 세 행 모두 true여야 한다.
select
    prosrc like '%marketing_consent is true%' as marketing_message_consent_gate
from pg_proc where proname = 'create_marketing_message_safe';

select
    (length(prosrc) - length(replace(prosrc, 'a.marketing_consent is true', ''))) / length('a.marketing_consent is true') = 2
        as rule_consent_gate_count_is_2
from pg_proc where proname = 'evaluate_notification_rules';

-- (1-b) 최종 안전 보완 — 광고성 두 분기(birthday/expired_rebuy) 모두에
--       탈퇴 계정 제외 조건이 정확히 들어갔는지. true여야 한다.
select
    (length(prosrc) - length(replace(prosrc, 'a.deactivated_at is null', ''))) / length('a.deactivated_at is null') = 2
        as rule_deactivated_exclusion_count_is_2
from pg_proc where proname = 'evaluate_notification_rules';

-- (2) 실제 발송 대상 수 확인 — 적용 전후로 이 값이 "전체 회원 수"에서
--     "수신 동의 회원 수"로 줄어드는 것이 정상이다.
select
    count(*) filter (where is_member = true and deactivated_at is null) as 회원수,
    count(*) filter (where is_member = true and deactivated_at is null and marketing_consent is true) as 마케팅_수신동의_대상수
from accounts;
