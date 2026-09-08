-- ============================================================
-- 알림톡 템플릿 "공통"(플랫폼 전체) vs "센터 전용" 구분
--
-- 배경: 사장님이 이미 알리고에 직접 등록해둔 템플릿(예: 휴대폰 인증번호 안내 등)은 모든
-- 센터가 공통으로 쓸 수 있어야 하고, 반대로 각 센터가 템플릿 관리 화면에서 개별적으로
-- 만드는 템플릿은 그 센터만 써야 한다(사용자 결정, 2026-09-08) — "센터 A가 등록한 템플릿을
-- 센터 B는 못 쓰게" 해달라는 요청.
--
-- 지금까지 alimtalk_templates.center_id는 not null이라 "센터 없음 = 전체 공통" 행을 만들
-- 방법이 없었다. center_id를 nullable로 바꿔서 null = 공통 템플릿으로 쓴다.
--
-- 권한 설계:
--   - 조회: 자기 센터 것 + 공통(center_id is null) 것 둘 다 볼 수 있음(모든 매니저).
--   - 생성/수정/삭제: 자기 센터 것만 가능(기존과 동일). 공통(center_id is null) 템플릿은
--     플랫폼 운영자만 만들고 고칠 수 있음 — 일반 매니저가 실수로(또는 의도적으로) 전체
--     공통 템플릿을 건드리면 다른 센터들에 다 영향이 가기 때문.
--   - 기존 정책은 select/insert/update/delete를 한 번에 처리하는 "for all" 정책 하나였는데,
--     조회 범위와 쓰기 범위가 이제 서로 달라져서(조회는 공통 포함, 쓰기는 자기 센터만)
--     command별로 쪼갠다.
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(alter column, drop/create policy if exists).
-- ============================================================

alter table alimtalk_templates alter column center_id drop not null;

comment on column alimtalk_templates.center_id is
    '이 템플릿을 쓸 수 있는 센터. null이면 "공통" — 플랫폼 전체 센터가 다 쓸 수 있음(운영자만 생성/수정 가능)';

drop policy if exists "알림톡템플릿 매니저 관리" on alimtalk_templates;
drop policy if exists "알림톡템플릿 조회" on alimtalk_templates;
drop policy if exists "알림톡템플릿 매니저 생성" on alimtalk_templates;
drop policy if exists "알림톡템플릿 매니저 수정" on alimtalk_templates;
drop policy if exists "알림톡템플릿 매니저 삭제" on alimtalk_templates;

create policy "알림톡템플릿 조회"
    on alimtalk_templates for select
    using (center_id in (select my_managed_center_ids()) or center_id is null or is_platform_admin());

create policy "알림톡템플릿 매니저 생성"
    on alimtalk_templates for insert
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

create policy "알림톡템플릿 매니저 수정"
    on alimtalk_templates for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

create policy "알림톡템플릿 매니저 삭제"
    on alimtalk_templates for delete
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'alimtalk_templates';
