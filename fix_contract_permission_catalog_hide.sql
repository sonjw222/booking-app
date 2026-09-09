-- ============================================================
-- 전자계약서(contract.*) 죽은 권한 카탈로그 6개 숨김 (P2-31 카테고리 D)
--
-- 배경: "전자계약서"(템플릿·약관·서명 포함) 기능은 앱/lib 코드 어디에도 구현돼
-- 있지 않다(0% 구현, 확인됨) — /manager/staff/permissions 화면에는 아래 6개
-- 체크박스가 그대로 떠 있지만 켜고 꺼도 실제로는 아무 RLS도 확인하지 않아
-- 아무 효과가 없다.
--
-- 이 파일은 "이 기능을 포기한다"는 결정이 아니다 — 그건 별도로 docs/TODO.md의
-- P3-5 로드맵 항목에서 사용자가 나중에 결정할 사안이다. 지금 하는 일은 딱 하나,
-- "효과 없는 체크박스를 화면에서 안 보이게" 정리뿐이다. 이미 짜여있는 draft RLS
-- (add_rls_gap_tables_draft_proposed.sql, proposed_rls_gap_batch_a.sql,
-- proposed_rls_gap_batch_b.sql, fix_rls_gap_batch_a2_contracts_notification_logs_
-- draft_proposed.sql)는 전혀 건드리지 않는다 — 나중에 이 기능을 실제로 만들기로
-- 결정되면 그 draft들을 그대로 다시 쓸 수 있다. 카탈로그 삭제는 role_permissions
-- 부여 이력까지 함께 지우므로, 기능을 나중에 되살릴 때는 permissions insert부터
-- 다시 하면 된다(어차피 지금 아무도 이 권한으로 실제 접근하는 게 없어 데이터 손실
-- 없음, grep으로 app/lib 코드에 이 6개 키 문자열이 하드코딩된 곳이 없음을 확인함).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

delete from role_permissions
 where permission_key in (
    'contract.list.view', 'contract.detail.view',
    'contract.template.view', 'contract.template.write', 'contract.template.delete',
    'contract.terms.manage'
 );

delete from permissions
 where key in (
    'contract.list.view', 'contract.detail.view',
    'contract.template.view', 'contract.template.write', 'contract.template.delete',
    'contract.terms.manage'
 );

-- ============================================================
-- 확인 — 0행이 나와야 정상
-- ============================================================
select key from permissions where key like 'contract.%';
