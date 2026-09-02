-- ============================================================
-- 알림톡(카카오 알림톡) 연동 — 스키마 확장
--
-- schema.sql 13-8절에 notification_rules/messages/notification_logs가 이미 정의돼 있었지만
-- RLS도 없이 방치돼 있었다(어떤 화면도 안 씀). 이 테이블들을 그대로 살려서 알림톡 발송·자동
-- 발송 규칙·정산 기록에 쓴다. lib/messaging/types.ts가 예고해둔 대로 messages.channel에
-- 'alimtalk'을 추가한다.
--
-- 플랫폼(sonjw) 단일 알리고 계정으로 전 센터를 대행 발송하는 구조(사용자 결정, 2026-09-01)
-- — 알리고 API 키 자체는 여기 저장하지 않고 Edge Function 시크릿(supabase secrets set)으로만
-- 관리한다. 즉시 발송은 이력을 안 남기고(사용자 결정), 예약 발송·자동 규칙 발송만 messages/
-- notification_logs에 기록한다(정산 근거 필요, "발송 내용 히스토리 화면"은 안 만들기로 한 것과
-- 별개 — notification_logs는 건당 수수료 집계용).
--
-- 여러 번 실행해도 안전(idempotent).
-- ============================================================

-- 1) messages.channel에 'alimtalk' 추가
alter table messages drop constraint if exists messages_channel_check;
alter table messages add constraint messages_channel_check
    check (channel in ('sms', 'lms', 'push', 'alimtalk'));

-- 2) 예약 발송용 텍스트/사진 블록 구조 저장 (즉시 발송은 안 씀)
alter table messages add column if not exists content_blocks jsonb;
comment on column messages.content_blocks is
    '텍스트/사진 블록 배열([{"type":"text","value":"..."},{"type":"image","url":"..."}]). 예약 발송에만 사용, 즉시 발송은 content만 씀';

-- 자동 발송 규칙이 큐잉한 메시지인지 표시 + 같은 회원에게 같은 규칙으로 중복 큐잉하지 않기 위한
-- 멱등 체크용(evaluate_notification_rules() 참고). 수동(즉시/예약) 발송은 NULL.
alter table messages add column if not exists rule_id uuid references notification_rules(id);

-- 3) 알림톡 승인 템플릿
create table if not exists alimtalk_templates (
    id                  uuid primary key default gen_random_uuid(),
    center_id           uuid not null references centers(id),
    aligo_template_code text,                                    -- 카카오 승인 후 알리고가 발급(승인 전 NULL)
    title               text not null,
    content             text not null,                           -- 승인 신청용 문구. 변수는 [[이름]] 형태
    variables           text[] not null default '{}',
    status              text not null default 'draft'
                        check (status in ('draft', 'pending', 'approved', 'rejected')),
    is_active           boolean not null default true,
    created_at          timestamptz not null default now()
);

comment on table alimtalk_templates is '센터별 카카오 알림톡 승인 템플릿. 자유 문장 발송이 안 돼서 자동 발송 규칙은 이 중 승인된 것만 골라 씀';

-- 4) 자동 발송 규칙에 알림톡 채널 + 템플릿 연결
alter table notification_rules add column if not exists send_alimtalk boolean not null default false;
alter table notification_rules add column if not exists template_id uuid references alimtalk_templates(id);

-- ============================================================
-- RLS — add_inquiries.sql과 동일한 헬퍼(my_managed_center_ids, is_platform_admin) 재사용.
-- 센터 매니저는 자기 센터 행만 CRUD, 플랫폼 관리자는 전체 조회(정산 확인용), 회원 본인은 접근 불가.
-- ============================================================

-- messages/notification_logs는 이미(2026-08-02/08-18) 채널별·권한별로 세분화된 RLS 정책이
-- 적용돼 있었다(fix_messages_select_channel_scope_draft_proposed.sql,
-- fix_rls_gap_batch_a2_contracts_notification_logs_draft_proposed.sql). 처음에 이 파일이
-- "센터 매니저면 전체 허용" 정책을 그 위에 추가로 얹었다가 그 세분화를 무력화해서 권한
-- 없는 스태프도 다른 채널 발송이력을 볼 수 있게 되는 회귀를 냈다(PR #113 CI,
-- tests/integration/sec009-batch-a1-rls.test.ts / sec009-batch-a2-rls.test.ts에서 실측
-- 확인, 2026-09-02) — 애초에 이 두 테이블에 대한 실제 쓰기는 evaluate_notification_rules()
-- (security definer)와 send-alimtalk Edge Function(service_role)만 하므로 RLS를 우회해서
-- 이 정책이 알림톡 기능에 필요하지도 않았다. messages/notification_logs는 기존 정책을
-- 그대로 둔다(아래에서 건드리지 않음) — notification_rules/alimtalk_templates만 신규
-- 테이블이라 정책이 필요하다.
alter table notification_rules enable row level security;
alter table alimtalk_templates enable row level security;

drop policy if exists "알림규칙 매니저 관리" on notification_rules;
create policy "알림규칙 매니저 관리"
    on notification_rules for all
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "알림톡템플릿 매니저 관리" on alimtalk_templates;
create policy "알림톡템플릿 매니저 관리"
    on alimtalk_templates for all
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

-- ============================================================
-- 권한 카탈로그: 더보기 > 알림톡 메뉴 노출용 (add_manager_menu_permissions.sql 패턴)
-- ============================================================
insert into permissions (key, category, parent_key, label, description, sort_order) values
('message.alimtalk.view', 'message', null, '알림톡 관리', '알림톡 발송, 자동 발송 규칙, 템플릿, 발신 설정을 관리할 수 있습니다.', 10)
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from center_roles r
cross join permissions p
where r.is_owner = true
  and p.key = 'message.alimtalk.view'
on conflict do nothing;

-- ============================================================
-- 확인
-- ============================================================
select conname from pg_constraint where conname = 'messages_channel_check';
select policyname, tablename from pg_policies
where tablename in ('notification_rules', 'messages', 'notification_logs', 'alimtalk_templates');
select key from permissions where key = 'message.alimtalk.view';
