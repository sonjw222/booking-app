-- ============================================================
-- 운영 설정 기능 추가 (center_settings RLS)
--
-- 하는 일:
--   center_settings 에 RLS 켜고 정책 부여
--   - 조회: 로그인 사용자 누구나 (예약 화면이 이 설정을 참고하므로)
--   - 수정: 운영정보 설정 권한(facility.operation) 있는 사람만
--
-- (지금은 RLS가 꺼져 있어 아무나 남의 센터 설정을 바꿀 수 있음 → 필요)
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================

alter table center_settings enable row level security;

drop policy if exists "설정 조회" on center_settings;
create policy "설정 조회"
    on center_settings for select
    using (auth.uid() is not null);

drop policy if exists "매니저 설정 생성" on center_settings;
create policy "매니저 설정 생성"
    on center_settings for insert
    with check (has_permission(center_id, 'facility.operation'));

drop policy if exists "매니저 설정 수정" on center_settings;
create policy "매니저 설정 수정"
    on center_settings for update
    using (has_permission(center_id, 'facility.operation'))
    with check (has_permission(center_id, 'facility.operation'));


-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'center_settings';


-- ============================================================
-- 완료!
--   → 오너 계정 → 매니저 대시보드 → "운영 설정"
--   → 예약/취소 시간, 대기, 기능 on/off 등 17항목 설정 → 저장
-- ============================================================
