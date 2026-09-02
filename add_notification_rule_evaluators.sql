-- ============================================================
-- 알림톡 자동 발송 규칙 평가 + 큐 디스패치
--
-- notify_expiring_passes()(add_notifications.sql, remaining_count<=0 전용 in-app 알림)와
-- 같은 패턴을 notification_rules 테이블 전체로 확장한다. SQL에서 외부 HTTP 호출이 안 되므로
-- 여기서는 조건에 맞는 대상을 찾아 messages에 큐잉만 하고, 실제 카카오 발송은
-- add_web_push.sql의 dispatch-web-push와 동일한 방식(pg_net + Edge Function)으로 별도 처리한다.
--
-- ⚠️ 이 파일을 실행하기 전에(add_web_push.sql로 이미 했다면 생략):
--   1) supabase functions deploy send-alimtalk
--   2) supabase secrets set ALIGO_USER_ID=... ALIGO_API_KEY=... ALIGO_SENDER_KEY=... ALIGO_SENDER_PHONE=...
--      (알리고 계정 준비 전이라면 비워둬도 배포는 되고, 발송 시도만 "계정 미연동" 실패로 응답)
--   3) SQL Editor에서 vault에 service_role_key가 이미 있는지 확인(add_web_push.sql에서 등록했으면 재사용):
--      select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY 값>', 'service_role_key', ...);
--
-- 여러 번 실행해도 안전(idempotent).
-- ============================================================

create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- 자동 발송 규칙 평가 → messages 큐잉
-- 지원 trigger_type: count_low / membership_expiring / expired_rebuy / pause_ending / birthday
--   (class_reminder / waitlist_promoted / class_cancelled는 이번 범위 밖 — 스키마엔 있으나
--    아래 분기에 없으므로 조용히 무시됨. 필요해지면 이 함수에 분기만 추가하면 됨)
-- 멱등: 같은 규칙(rule_id)이 같은 회원에게 같은 날 이미 큐잉했으면 건너뜀.
-- ------------------------------------------------------------
create or replace function evaluate_notification_rules()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    rule    record;
    target  record;
    v_tpl   text;
    v_msg   text;
    v_count int := 0;
begin
    for rule in
        select * from notification_rules
         where is_active = true and send_alimtalk = true and template_id is not null
    loop
        select content into v_tpl from alimtalk_templates
         where id = rule.template_id and status = 'approved' and is_active = true;
        if v_tpl is null then
            continue; -- 승인 안 된(또는 없는) 템플릿이면 발송하지 않음
        end if;

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
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id);
                v_count := v_count + 1;
            end loop;

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
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id);
                v_count := v_count + 1;
            end loop;

        elsif rule.trigger_type = 'expired_rebuy' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'expired'
                   and m.center_id = rule.center_id
                   and m.expires_at = current_date - rule.days_before
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id);
                v_count := v_count + 1;
            end loop;

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
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id);
                v_count := v_count + 1;
            end loop;

        elsif rule.trigger_type = 'birthday' then
            for target in
                select distinct pr.id as profile_id, pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.center_id = rule.center_id
                   and pr.birth_date is not null
                   and extract(month from pr.birth_date) = extract(month from (now() at time zone 'Asia/Seoul'))
                   and extract(day from pr.birth_date) = extract(day from (now() at time zone 'Asia/Seoul'))
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and target_profile_ids = array[target.profile_id]
                       and created_at::date = current_date
                );
                v_msg := replace(v_tpl, '[[회원명]]', target.member_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id);
                v_count := v_count + 1;
            end loop;
        end if;
    end loop;

    return v_count;
end;
$$;

comment on function evaluate_notification_rules() is
    '활성 알림톡 자동 발송 규칙을 평가해 대상 회원에게 messages 큐 행을 만든다. 실제 발송은 dispatch-alimtalk cron이 담당';

-- ------------------------------------------------------------
-- daily-notifications cron에 규칙 평가 추가(add_notification_scheduler.sql이 만든 job을
-- 같은 이름으로 재호출해서 덮어씀 — pg_cron 표준 동작)
-- ------------------------------------------------------------
select cron.schedule(
    'daily-notifications',
    '0 0 * * *',
    $$ select notify_upcoming_reservations(); select notify_expiring_passes(); select evaluate_notification_rules(); $$
);

-- ------------------------------------------------------------
-- 1분마다 send-alimtalk Edge Function을 호출해 큐잉된 알림톡을 실제 발송(dispatch-web-push와 동일 패턴)
-- messages 하나당 한 번씩 호출 — 배치 크기가 커지면 나중에 Edge Function 쪽에서 여러 건을 한 번에
-- 처리하도록 바꿀 수 있음(지금은 자동 규칙 발송량이 적을 것으로 가정, 단순하게 시작).
-- ------------------------------------------------------------
select cron.schedule(
    'dispatch-alimtalk',
    '* * * * *',
    $$
    select net.http_post(
        url := 'https://bxntqggkfwnhcczsbqtj.supabase.co/functions/v1/send-alimtalk',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
                select decrypted_secret from vault.decrypted_secrets
                where name = 'service_role_key' limit 1
            )
        ),
        body := jsonb_build_object('messageId', id)
    )
    from messages
    where channel = 'alimtalk' and status = 'scheduled' and scheduled_at <= now();
    $$
);

-- ============================================================
-- 확인
-- ============================================================
select jobname, schedule from cron.job where jobname in ('daily-notifications', 'dispatch-alimtalk');
