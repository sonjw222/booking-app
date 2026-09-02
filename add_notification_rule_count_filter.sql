-- ============================================================
-- 자동 발송 규칙 — 횟수 조건 보강 (절충안, 사용자 결정 2026-09-01)
--
-- 지금까지는 트리거 5종 중 count_low 하나만 "횟수" 기반이고 나머지 4종은 전부 "기간"(D-day)
-- 기반이라 기간 위주로 치우쳐 있었다. 완전 자유 조건 빌더(별도 큰 작업, 필드/연산자를 관리자가
-- 조합)까지는 안 가고, 기존 threshold_count/days_before 두 컬럼(schema.sql에 이미 있음, 신규
-- 컬럼 아님)을 모든 트리거 타입에서 "선택적으로 같이" 쓸 수 있게 한다 —
--   - count_low: 잔여횟수 조건은 필수, 만료 며칠 이내 조건은 선택
--   - membership_expiring/expired_rebuy/pause_ending: 기간 조건은 필수, 잔여횟수 이하 조건은 선택
-- 즉 "며칠 전 + 잔여 N회 이하" 같은 조합이 가능해진다(둘 다 채우면 AND로 평가).
--
-- 겸사겸사 count_low를 "정확히 N회"(=)에서 "N회 이하"(<=)로 바꾼다 — 더 직관적인 의미이자
-- 이제 매일 재평가해도 안전하도록(아래) 멱등 체크를 "오늘 하루"가 아니라 "이 수강권 건당
-- 한 번"으로 바꿨기 때문에 가능해진 변경이다(<=로 바꾸면 잔여횟수가 임계값 아래로 계속
-- 머무는 회원에게 "오늘 하루" 기준 멱등 체크로는 매일 재발송될 위험이 있었음).
--
-- 여러 번 실행해도 안전(idempotent).
-- ============================================================

-- 자동 규칙이 큐잉한 메시지가 "어느 수강권 건"에 대한 것인지 기록 — 멱등 체크를 오늘 하루가
-- 아니라 이 수강권 건당 한 번으로 좁히는 데 씀(생일은 membership이 아니라 profile 단위라 NULL).
alter table messages add column if not exists rule_membership_id uuid;

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
                   and m.remaining_count <= rule.threshold_count
                   and (rule.days_before is null or m.expires_at <= current_date + rule.days_before)
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
    '활성 알림톡 자동 발송 규칙을 평가해 대상 회원에게 messages 큐 행을 만든다. threshold_count/days_before를 트리거 타입별 필수+선택 조합으로 평가(절충안, 2026-09-01). 실제 발송은 dispatch-alimtalk cron이 담당';

-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns where table_name = 'messages' and column_name = 'rule_membership_id';
