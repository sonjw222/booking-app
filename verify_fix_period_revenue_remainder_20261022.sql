-- 읽기 전용 검증(쓰기 없음): 두 함수 모두 패치 마커가 있어야 한다(true, true).
select position('-- f16-remainder' in pg_get_functiondef('public.class_revenue_daily_summary(uuid,date,date)'::regprocedure)) > 0 as daily_patched,
       position('-- f16-remainder' in pg_get_functiondef('public.class_revenue_for_date(uuid,date)'::regprocedure)) > 0 as detail_patched;
-- 합계 대조(센터·기간을 바꿔 실행): 일별 요약의 total 합 = 날짜별 상세 amount 합(같은 기간)이어야 한다 — 앱 화면의 "수업매출 캘린더"에서 비교.
