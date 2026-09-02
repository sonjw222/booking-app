-- ============================================================
-- 자동 발송 규칙 — 특정 수강권(상품) 지정 기능 (절충안 보강, 사용자 결정 2026-09-01)
--
-- 지금까지 count_low 등은 센터 전체 활성 수강권을 대상으로 잔여횟수/기간을 봤다 — 그런데
-- 한 센터가 "10회권"/"20회권"/"무제한 정기권"처럼 여러 상품을 팔면, "잔여 2회 이하"가 상품마다
-- 의미가 다르다(무제한권엔 잔여횟수 개념 자체가 없음). 규칙마다 특정 상품 하나로 좁힐 수 있게
-- product_id를 추가한다(NULL이면 기존처럼 "전체 수강권" 대상 — 하위호환).
-- ============================================================

alter table notification_rules add column if not exists product_id uuid references products(id);

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
            continue;
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
                   and m.remaining_count <= rule.threshold_count
                   and (rule.days_before is null or m.expires_at <= current_date + rule.days_before)
                   and (rule.product_id is null or m.product_id = rule.product_id)
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and rule_membership_id = target.membership_id
                );
                v_msg := replace(replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name),
                    '[[수강권 잔여횟수]]', target.remaining_count::text);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, rule_membership_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, target.membership_id);
                v_count := v_count + 1;
            end loop;

        elsif rule.trigger_type = 'membership_expiring' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name, m.expires_at, m.remaining_count,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'active'
                   and m.center_id = rule.center_id
                   and m.expires_at = current_date + rule.days_before
                   and (rule.threshold_count is null or m.remaining_count <= rule.threshold_count)
                   and (rule.product_id is null or m.product_id = rule.product_id)
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and rule_membership_id = target.membership_id
                );
                v_msg := replace(replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name),
                    '[[수강권 잔여일]]', rule.days_before::text);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, rule_membership_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, target.membership_id);
                v_count := v_count + 1;
            end loop;

        elsif rule.trigger_type = 'expired_rebuy' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name, m.remaining_count,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'expired'
                   and m.center_id = rule.center_id
                   and m.expires_at = current_date - rule.days_before
                   and (rule.threshold_count is null or coalesce(m.remaining_count, 0) <= rule.threshold_count)
                   and (rule.product_id is null or m.product_id = rule.product_id)
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and rule_membership_id = target.membership_id
                );
                v_msg := replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, rule_membership_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, target.membership_id);
                v_count := v_count + 1;
            end loop;

        elsif rule.trigger_type = 'pause_ending' and rule.days_before is not null then
            for target in
                select m.id as membership_id, m.profile_id,
                       coalesce(m.product_name, '수강권') as pass_name, m.remaining_count,
                       pr.name as member_name
                  from memberships m
                  join profiles pr on pr.id = m.profile_id
                 where m.status = 'paused'
                   and m.center_id = rule.center_id
                   and m.paused_until = current_date + rule.days_before
                   and (rule.threshold_count is null or m.remaining_count <= rule.threshold_count)
                   and (rule.product_id is null or m.product_id = rule.product_id)
            loop
                continue when exists (
                    select 1 from messages
                     where rule_id = rule.id and rule_membership_id = target.membership_id
                );
                v_msg := replace(replace(v_tpl,
                    '[[회원명]]', target.member_name),
                    '[[수강권명]]', target.pass_name);
                insert into messages (center_id, channel, content, target_profile_ids, scheduled_at, status, rule_id, rule_membership_id)
                values (rule.center_id, 'alimtalk', v_msg, array[target.profile_id], now(), 'scheduled', rule.id, target.membership_id);
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
    '활성 알림톡 자동 발송 규칙을 평가해 대상 회원에게 messages 큐 행을 만든다. threshold_count/days_before/product_id를 트리거 타입별 필수+선택 조합으로 평가. 실제 발송은 dispatch-alimtalk cron이 담당';

-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns where table_name = 'notification_rules' and column_name = 'product_id';
