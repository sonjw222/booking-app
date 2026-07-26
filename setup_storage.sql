-- ============================================================
-- 사업자등록증 Storage 설정
--
-- ⚠️ 먼저 버킷을 만들어야 해요 (SQL Editor 아님, 대시보드에서):
--
--   1. Supabase 대시보드 → 왼쪽 메뉴 Storage
--   2. "New bucket" 클릭
--   3. Name: business-licenses
--   4. Public bucket: ★꺼두기(OFF)★  (비공개 - 서명 URL로만 열람)
--   5. Create
--
-- 그 다음, 아래 SQL을 SQL Editor에서 실행해 접근 정책을 추가하세요.
-- (버킷을 만든 뒤에 실행해야 합니다)
-- ============================================================


-- 업로드: 로그인한 사용자는 파일 올리기 가능 (센터 등록 시)
drop policy if exists "사업자등록증 업로드" on storage.objects;
create policy "사업자등록증 업로드"
    on storage.objects for insert
    with check (
        bucket_id = 'business-licenses'
        and auth.role() = 'authenticated'
    );

-- 조회: 플랫폼 운영자만 열람 (승인 심사용)
--   본인이 올린 파일도 조회 가능하게 하려면 owner 조건 추가 가능
drop policy if exists "사업자등록증 조회" on storage.objects;
create policy "사업자등록증 조회"
    on storage.objects for select
    using (
        bucket_id = 'business-licenses'
        and (is_platform_admin() or owner = auth.uid())
    );


-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like '사업자등록증%';


-- ============================================================
-- 완료!
--   → 센터 등록 시 사업자등록증 파일이 Storage에 업로드됨
--   → 운영자 승인 화면에서 "📎 서류 보기"로 실제 파일 열람
-- ============================================================
