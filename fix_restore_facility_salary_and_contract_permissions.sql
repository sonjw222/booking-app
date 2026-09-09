-- ============================================================
-- facility.salary.*, contract.* 권한 카탈로그 복원 (잘못된 삭제 되돌림)
--
-- 배경: fix_facility_salary_permission_catalog_hide.sql / fix_contract_permission_
-- catalog_hide.sql이 "코드에 0% 구현돼 있다(app/lib 어디서도 참조 없음)"는 근거로
-- 이 권한들을 permissions 카탈로그에서 삭제했다. 하지만 실제로는 staff_salaries/
-- contracts 테이블의 RLS 정책이 지금도 이 키들을 has_permission()으로 직접 참조하고
-- 있다(2026-09-10 PR #129 통합테스트 sec009-batch-a1-rls.test.ts / a2-rls.test.ts가
-- account_center_permissions_permission_key_fkey 위반으로 검출) — app/lib 코드에 없다는
-- 확인은 맞았지만, RLS 레이어에는 이미 살아있는 게이트였다는 걸 놓쳤다.
--
-- 카탈로그 행을 삭제하면 account_center_permissions/role_permissions에 그 key로
-- INSERT가 전부 FK 위반으로 막혀 "이 권한을 다시는 부여할 수 없음" 상태가 된다 — RLS
-- 정책 자체는 그대로 있으니 사실상 이 기능을 아무도 못 쓰게 영구적으로 막아버리는
-- 결과였다(단순 UI 체크박스 숨김을 훨씬 넘어서는 부수효과).
--
-- 이 파일은 schema.sql의 원래 정의값 그대로 복원한다. UI에서 다시 체크박스가 보이는
-- 부수효과가 있다 — "죽은 체크박스 숨기기"라는 원래 의도를 UI 레벨에서 어떻게 되살릴지는
-- 별도 결정 필요(예: permissions에 hidden 플래그 추가 등, docs/TODO.md P3-5와 함께 후속).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(on conflict do nothing).
-- ============================================================

insert into permissions (key, category, parent_key, label, description, sort_order) values
('facility.salary.own.view',     'facility', 'facility.staff.view', '본인의 급여 정보 조회', '본인의 급여 정보를 조회할 수 있습니다.', 64),
('facility.salary.own.update',   'facility', 'facility.staff.view', '본인의 급여 정보 수정', '본인의 급여 정보를 수정할 수 있습니다.', 65),
('facility.salary.other.view',   'facility', 'facility.staff.view', '다른 스태프의 급여 정보 조회', '다른 스태프의 급여 정보를 조회할 수 있습니다.', 66),
('facility.salary.other.update', 'facility', 'facility.staff.view', '다른 스태프의 급여 정보 수정', '다른 스태프의 급여 정보를 수정할 수 있습니다.', 67),
('facility.salary.setting',      'facility', null, '스태프 급여 설정', '스태프의 근무 형태(정규직, 파트타임, 대강 등)에 따라 급여를 설정할 수 있습니다.', 70)
on conflict (key) do nothing;

insert into permissions (key, category, parent_key, label, description, sort_order) values
('contract.list.view',       'contract', null, '계약서 목록 조회', '계약서 목록을 조회 할 수 있습니다.', 10),
('contract.detail.view',     'contract', 'contract.list.view', '계약서 상세 조회', '계약서 상세 내용을 조회 할 수 있습니다.', 11),
('contract.template.view',   'contract', null, '템플릿 조회', '템플릿을 조회할 수 있습니다.', 20),
('contract.template.write',  'contract', 'contract.template.view', '템플릿 등록/수정', '템플릿을 등록 및 수정 할 수 있습니다.', 21),
('contract.template.delete', 'contract', 'contract.template.view', '템플릿 삭제', '템플릿을 삭제 할 수 있습니다.', 22),
('contract.terms.manage',    'contract', 'contract.template.view', '약관관리', '약관을 등록/수정/삭제할 수 있습니다.', 23)
on conflict (key) do nothing;

-- ============================================================
-- 확인 — 각 11행이 나와야 정상
-- ============================================================
select key from permissions where key like 'facility.salary%' or key like 'contract.%' order by key;
