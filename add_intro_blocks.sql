-- ============================================================
-- 센터 소개 - 블로그식 (사진 + 글 번갈아)
--
-- 하는 일:
--   centers 에 intro_blocks (jsonb) 추가
--   → 소개를 글/사진 블록 배열로 저장
--   → 기존 intro(단일 텍스트)는 하위호환용으로 남겨둠
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table centers add column if not exists intro_blocks jsonb not null default '[]';

-- (선택) 기존 소개글이 있으면 텍스트 블록 하나로 옮기기
update centers
set intro_blocks = jsonb_build_array(jsonb_build_object('type', 'text', 'value', intro))
where intro is not null and intro <> '' and (intro_blocks = '[]'::jsonb);


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'centers' and column_name = 'intro_blocks';


-- ============================================================
-- 완료!
--   매니저: 센터 정보 → 센터 소개 → 글/사진 블록으로 편집
--   회원: 센터 상세에서 블로그처럼 표시
-- ============================================================
