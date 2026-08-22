-- ============================================================
-- P2-14 후속 — progress_records: 누락된 UPDATE RLS 정책 추가
--
-- 배경: progress_records는 SELECT/INSERT/DELETE 정책만 있고 UPDATE 정책이
--   없었다(add_progress_categories.sql 작성 당시 수정 기능이 없어서 빠짐).
--   RLS가 켜진 테이블에서 UPDATE 정책이 없으면 기본 거부라 지금까지는 무해했지만,
--   lib/progress.ts의 updateProgressNote()가 이미 .update()를 호출하도록 작성돼
--   있다(현재는 어느 화면에서도 호출하지 않는 죽은 함수) — 나중에 이 함수를 화면에
--   연결하면 RLS가 없어 즉시 permission denied로 막히거나, 먼저 이 정책 없이 다른
--   경로로 우회하면 위험할 수 있어 미리 추가해둔다.
--
-- progress_categories의 기존 UPDATE 정책, progress_records의 기존 INSERT 정책과
-- 동일한 패턴(그 카테고리에 customer.progress 권한이 있는 스태프만)을 그대로 따른다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

drop policy if exists "진도 기록 수정" on progress_records;
create policy "진도 기록 수정"
    on progress_records for update
    using (
        category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    )
    with check (
        category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );

-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd from pg_policies
 where tablename = 'progress_records'
 order by cmd;
