-- ============================================================
-- 스태프 급여(facility.salary.*) 권한 카탈로그 숨김 — 기능 보류 결정
--
-- 배경: staff_salaries(급여) 기능은 코드에 0% 구현돼 있다(app/lib 어디서도 참조 없음).
-- facility.salary.setting/own.view/own.update/other.view/other.update 5개 권한 키가
-- 카탈로그에는 있어서 /manager/staff 역할별 권한 화면에 체크박스로 노출되지만, 토글해도
-- 실제로 아무 RLS도 이 키들을 확인하지 않아 무늬만 있는 죽은 체크박스다.
--
-- docs/TODO.md P3-5("스태프 급여·근무일정과 전자계약")로 이미 별도 로드맵 결정 사안으로
-- 관리되고 있음 — 이번엔 계약서(contract.*)와 동일하게 "보류 + 카탈로그에서만 숨김"으로
-- 결정(사용자 확인, 2026-09-09). 기능 자체를 포기하는 게 아니라 화면에서 죽은 체크박스만
-- 안 보이게 하는 것 — 이미 짜여있는 draft RLS(add_rls_gap_tables_draft_proposed.sql,
-- proposed_rls_gap_batch_a.sql, proposed_rls_gap_batch_a1.sql)는 전혀 건드리지 않고
-- 그대로 남겨둔다. 나중에 이 기능을 만들기로 결정되면 그 draft를 재사용하면 된다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

delete from role_permissions
where permission_key in (
    'facility.salary.setting',
    'facility.salary.own.view',
    'facility.salary.own.update',
    'facility.salary.other.view',
    'facility.salary.other.update'
);

delete from permissions
where key in (
    'facility.salary.setting',
    'facility.salary.own.view',
    'facility.salary.own.update',
    'facility.salary.other.view',
    'facility.salary.other.update'
);

-- ============================================================
-- 확인 — 0행이 나와야 정상
-- ============================================================
select key from permissions where key like 'facility.salary%';
