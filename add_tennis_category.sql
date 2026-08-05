-- 종목(service_categories)에 "테니스" 추가.
-- add_operator_settings.sql의 초기 시드 목록에 없었던 것을 이제 추가한다.
-- 정식 CRUD는 /admin/categories(운영자 화면, lib/operator.ts addCategory())로 이미
-- 가능하지만, 코드 리뷰/배포 이력에 남도록 마이그레이션 파일로도 남긴다.
insert into service_categories (label, emoji, sort_order) values
    ('테니스', '🎾', 9)
on conflict (label) do nothing;
