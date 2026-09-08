-- ============================================================
-- 자동 발송 규칙(5종)이 승인된 템플릿을 골라도 항상 SMS로만 나가던 문제 수정
--
-- 배경: app/manager/alimtalk/send(매니저 즉시 발송)에서 templateCode가 서버로 전달되지
-- 않아 SMS로만 나가던 버그를 먼저 고쳤는데(2026-09-08), 자동 규칙 쪽에도 똑같은 문제가
-- 구조적으로 있었다 — evaluate_notification_rules()가 approved 템플릿의 "내용"만 읽어
-- messages.content에 넣고, 그 템플릿의 알리고 코드(aligo_template_code)는 어디에도
-- 저장하지 않았다. dispatch-alimtalk cron이 messages 행을 읽어 sendViaAligo()를 호출할
-- 때 templateCode 없이 부르니 매번 SMS 대체발송으로만 나가고 있었다(실제 카카오 알림톡
-- 아님) — 매니저가 규칙별로 "알림톡 보내기"를 켜고 승인된 템플릿까지 골라놔도 소용없던
-- 상태였다.
--
-- 하는 일:
--   1) messages.aligo_template_code 컬럼 추가 — 큐잉 시점에 템플릿 코드를 같이 저장
--   2) evaluate_notification_rules() 재정의 — v_tpl_code를 같이 읽어 5개 insert문 모두에 저장
--   3) send-alimtalk Edge Function(경로 2, dispatch-alimtalk cron)에서 이 컬럼을 읽어
--      sendViaAligo()에 templateCode로 전달하도록 수정(app 쪽 파일, 이 SQL과 별개 배포 필요)
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(add column if not exists / create or replace function).
-- ============================================================

alter table messages add column if not exists aligo_template_code text;

comment on column messages.aligo_template_code is
    '알림톡 큐잉 당시 사용한 알리고 템플릿 코드(승인된 템플릿에서 복사) — dispatch-alimtalk cron이 '
    'sendViaAligo() 호출 시 이 값을 실어야 SMS 대체발송이 아니라 진짜 카카오 알림톡으로 나간다';

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
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
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
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, aligo_template_code)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, v_tplcode);
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
    '실제 발송은 dispatch-alimtalk cron이 담당';
