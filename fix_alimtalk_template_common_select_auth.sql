-- ============================================================
-- "공통" 알림톡 템플릿 조회 정책에 로그인 여부 확인 추가
--
-- 배경: add_alimtalk_template_common.sql의 SELECT 정책 "알림톡템플릿 조회"는
-- `center_id is null` 조건에 별도 인증 체크가 없어서, 로그인하지 않은 익명(anon) 요청도
-- 공통 템플릿을 조회할 수 있었다(실제 anon key로 직접 확인함, 2026-09-08 QA 중 발견).
-- 문구 자체가 민감정보는 아니지만 의도한 설계("모든 매니저"가 아니라 "아무나")가 아니라
-- 로그인한 사용자로만 좁힌다.
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(drop/create policy if exists).
-- ============================================================

drop policy if exists "알림톡템플릿 조회" on alimtalk_templates;

create policy "알림톡템플릿 조회"
    on alimtalk_templates for select
    using (
        center_id in (select my_managed_center_ids())
        or (center_id is null and auth.uid() is not null)
        or is_platform_admin()
    );
