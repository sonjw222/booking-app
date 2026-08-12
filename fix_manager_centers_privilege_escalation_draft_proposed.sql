-- ============================================================
-- SEC-101 + SEC-112 + SEC-113(전부 P0) 통합 수정: manager_centers 권한 상승 3건
--
-- [SEC-101] 낯선 사람의 self-join
--   "매니저센터 생성" INSERT 정책이 "내 계정으로만 넣으면 무조건 통과"였다. 로그인한
--   사용자 누구나 임의 기존 센터에 스스로 active 행을 만들 수 있었다.
--
-- [SEC-112] 이미 초대된 저권한 스태프의 self-promote (같은 센터 + 타 센터 role_id 둘 다)
--   "오너 스태프 수정" UPDATE 정책의 (account_id = my_account_id()) 분기가 role_id/status에
--   어떤 제약도 걸지 않았다. manager_centers.role_id는 center_roles(id)를 참조할 뿐
--   "그 role이 이 행의 center_id와 같은 센터 소속인지"를 DB가 전혀 검증하지 않는다
--   (schema.sql 확인 — center_roles.center_id와 manager_centers.center_id 사이에 복합
--   FK/체크 제약 없음). 그 결과 이미 정상적으로 초대된 저권한 스태프(role_id가 이미
--   null이 아닌 어떤 값)가 다음 두 방법 중 하나로 스스로를 오너로 승격할 수 있었다:
--     (a) 같은 센터: "내 센터 역할 조회" 정책이 그 센터 소속이면 role 무관하게 누구나
--         center_roles를 볼 수 있어, 그 센터의 오너 role_id를 그대로 읽어서 자기 행에 UPDATE.
--     (b) 다른 센터(더 넓은 경로): 자기 소유의 아무 센터나 하나 만들면(합법적인 부트스트랩)
--         그 센터의 오너 role_id를 얻는다. 그 role_id를 "다른(진짜) 센터"에서 자신이 갖고
--         있는 기존 행에 UPDATE — center_roles와 manager_centers의 center_id가 다르든 말든
--         has_permission()이 role_id만 조인하고 그 role의 center_id는 확인하지 않아 그대로
--         "그 센터의 오너"로 인식됨.
--
-- [SEC-113] 마지막 남은 행 self-delete → orphan center → 제3자 self-claim
--   "오너 스태프 삭제" DELETE 정책의 self 분기(account_id = my_account_id())가 "그 센터의
--   마지막 남은 행이어도" 본인이 자기 행을 지우는 걸 막지 않았다. 오너(또는 그 센터의
--   유일한 남은 매니저)가 실수로/계정 정리 중 자기 행을 지우면 그 센터의 manager_centers
--   행이 0건이 되고("orphaned"), 바로 아래 SEC-101 수정의 self-insert 조건
--   (not exists(그 center_id에 기존 행))을 다시 만족하게 되어 원래 소유자가 아닌 누구든
--   그 센터(기존 수업·회원·이력이 전부 남아있는 실제 데이터)를 새 오너로 가로챌 수 있었다.
--   SEC-101/112만 패치하고 이 문제를 방치하면 "우회 불가능한 수정"이라는 잘못된 확신을
--   주면서 동일한 결과(타인의 실제 센터 탈취)를 달성하는 다른 경로가 열려 있는 셈이라,
--   같은 P0 권한 상승 체인의 일부로 보고 이 파일에서 함께 닫는다(2026-08-12/13 통합
--   보안 감사에서 P1/P2 → P0로 재평가 확정).
--
-- [정상 흐름과의 관계 — 반드시 보존]
--   lib/centers.ts registerCenterForAccount()의 4단계(자기 role_id를 null → 방금 만든
--   센터의 오너 role로 UPDATE)가 "오너 스태프 수정"의 self 분기를 정확히 이 용도로 쓴다.
--   lib/roles.ts updateStaffRole()(유일한 다른 UPDATE 호출부, 타인 대상)는 has_permission
--   분기만 쓴다. lib/roles.ts removeStaff()(DELETE 호출부)는 self/has_permission 두 분기
--   전부 정상적인 "오너가 스태프를 내보내거나 스태프가 스스로 나가는" 시나리오에만 쓰인다.
--   specialty 컬럼은 app/lib 전체에서 참조 0건(완전한 dead field, 자기수정 기능 자체가
--   없음) — 이 컬럼을 이번 수정으로 더 엄격하게 잠궈도 실사용 영향 없음.
--
-- [설계 비교 — SEC-101/112, 4안 검토, 최종 B안 채택]
--   A) 부트스트랩을 security definer RPC/trigger로 완전히 옮기고 self-UPDATE 분기 자체를
--      제거. 가장 근본적으로 깔끔하지만 lib/centers.ts를 새 RPC 호출로 바꿔야 해서
--      "코드 수정"이 필요하다 — 이번 정적 감사/STOP 범위를 넘어선다.
--   B) [채택] client bootstrap은 그대로 두고, self-UPDATE를
--      "지금 role_id가 null인 행 → 그 센터의 오너 role로, 정확히 1회만" 전환으로 좁힌다.
--      UPDATE 정책은 USING(대상 행 선정, OLD 값 기준)과 WITH CHECK(결과 값, NEW 기준)를
--      함께 쓸 수 있는데, USING에 "role_id is null"을 넣으면 "이미 role이 있는 내 행"은
--      애초에 self 분기의 후보에서 제외된다 — role이 이미 배정된 사람은 그 시점부터
--      두 번 다시 self 분기를 못 쓰고 has_permission만 남는다. 정확히 부트스트랩
--      1회만 허용하고 그 이후 self-promote를 영구 차단하는 가장 좁은 조건이며,
--      SQL만으로 완결되고 lib/centers.ts는 단 한 줄도 바꿀 필요가 없다.
--   C) 센터 생성 + 오너 연결을 하나의 atomic RPC로 통합. 중간 실패로 "센터는 있는데
--      오너가 없는" 반쪽 상태가 안 생긴다는 원자성 이점은 실재하지만, 이 역시
--      lib/centers.ts 변경이 필요해 이번 범위 밖. 별도 후속 배치로 권장(장기적으로 C를
--      권장, 지금은 B).
--   D) 검토했으나 B보다 안전하거나 간단한 대안을 찾지 못함.
--
-- [role_id 교차 센터 주입 차단]
--   self 분기든 has_permission 분기든 관계없이, 결과 role_id는 항상
--   "그 행의 center_id와 같은 센터의 center_roles"에 속해야 한다는 제약을 모든 쓰기
--   경로(INSERT 2개 + UPDATE 1개) 공통으로 건다. 이것이 SEC-112(b)를 근본적으로 닫는다
--   (self 분기의 "role_id is null" 제약과는 별개의, 독립적인 방어선).
--
-- [설계 비교 — SEC-113, 4안 검토, 최종 A안 채택(최소 변경)]
--   A) [채택] "이 DELETE를 실행하면 그 center_id에 manager_centers 행이 0건이 되는가"를
--      직접 검사해, 0건이 되는 삭제만 막는다(자기 자신 외에 다른 행이 하나라도 남아있으면
--      허용). SEC-101의 self-insert 재개 조건(not exists)과 정확히 반대 조건이라, 이
--      정책이 있는 한 "orphan 상태" 자체가 DB 레벨에서 절대 만들어지지 않는다 — 가장
--      좁고 직접적인 차단. self/has_permission 두 분기 모두에 동일하게 적용(관리자 권한
--      으로도 마지막 한 명을 지울 수는 없어야 하므로).
--   B) "owner role을 가진 마지막 행만" 막는 방식은 검토했으나 기각 — 오너가 아닌 마지막
--      한 명(예: 오너가 이미 나가고 스태프 한 명만 남은 센터)도 그 사람이 나가면 똑같이
--      orphan이 된다. owner 여부로 좁히면 이 경우를 놓친다.
--   C) "owner transfer 완료 후에만 기존 오너 삭제 허용"은 이상적이지만 "owner transfer"라는
--      개념 자체(다른 스태프를 새 오너로 지정하는 절차)가 현재 스키마/코드 어디에도
--      없다(NEEDS PRODUCT DECISION) — 새로 설계해야 해서 이번 P0 최소 수정 범위 밖.
--   D) "센터 삭제/탈퇴를 전용 RPC로만" — 근본적으로 가장 깔끔하지만 코드 변경(새 RPC +
--      lib/centers.ts 또는 lib/roles.ts 수정)이 필요해 이번 범위 밖.
--   → 장기적으로는 C(오너 위임 워크플로우) 또는 D(센터 폐쇄 전용 RPC)를 권장하며, 이번
--   P0 배치는 A로 즉시 안전하게 막는다. C/D는 별도 TODO로 분리(최종 보고서 참고).
--
-- [SEC-101 재검토 — edge case 평가]
--   - race condition(동시 self-insert): 이론상 존재하나(READ COMMITTED에서 NOT EXISTS
--     체크와 실제 insert 사이 TOCTOU) 공격자가 방금 막 만들어진, 암호학적으로 예측
--     불가능한 UUID를 실시간으로 알아내 그 찰나에 경쟁해야 해 실질적으로 악용 불가능한
--     잔여 리스크로 판단 — 이번 배치에서 SERIALIZABLE/advisory lock까지는 도입하지 않음.
--     SEC-113 수정으로 "고의로 orphan을 만든 뒤 그 순간을 노리는" 훨씬 현실적인 공격
--     표면은 이제 막힌다.
--   - 삭제/복구된 센터: centers 테이블에 소프트 삭제 개념을 찾지 못함 — 해당 없음.
--   - 플랫폼 관리자 생성 흐름: 별도의 "관리자가 대신 센터+오너를 만드는" 코드 경로를
--     찾지 못함(NEEDS VERIFICATION) — 있다면 service_role 경유일 가능성이 높아 이번
--     RLS 정책 변경의 영향을 받지 않을 것으로 추정.
--
-- [원자성] 정책 3개(총 6문: DROP+CREATE ×3)를 BEGIN/COMMIT으로 묶는다 — 예를 들어
--   [1]/[2]는 성공하고 [3](SEC-112 self-promote를 막는 핵심 정책) 적용 중 네트워크
--   끊김/SQL Editor 오류로 실패하면 "SEC-101은 막혔지만 SEC-112는 여전히 뚫려 있는"
--   위험한 중간 상태가 그대로 커밋된 채 남을 수 있다. 하나의 트랜잭션으로 묶어 전부
--   성공하거나 전부 안 하거나 둘 중 하나만 되도록 한다.
--
-- 여러 번 실행해도 안전(drop policy if exists + create policy, 트랜잭션 내부).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] INSERT "매니저센터 생성" — SEC-101: 낯선 사람의 self-join 차단
-- ------------------------------------------------------------
drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not exists (
            select 1 from manager_centers mc2
            where mc2.center_id = manager_centers.center_id
        )
    );

-- ------------------------------------------------------------
-- [2] INSERT "오너 스태프 초대" — 정상 초대는 그대로, role_id 교차 센터 주입만 추가 차단
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (
            role_id is null
            or role_id in (
                select id from center_roles cr
                where cr.center_id = manager_centers.center_id
            )
        )
    );

-- ------------------------------------------------------------
-- [3] UPDATE "오너 스태프 수정" — SEC-112: self-promote(같은 센터 + 타 센터 role_id) 차단
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        -- self 분기는 "아직 role이 없는(null) 내 행"만 대상으로 삼을 수 있다 — role이
        -- 이미 배정된 순간부터 이 행은 self 분기 후보에서 영구적으로 제외된다.
        (account_id = my_account_id() and role_id is null)
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        -- 결과 role_id는 항상 그 행의 center_id와 같은 센터 소속이어야 한다(타 센터
        -- role_id 주입 차단, self/has_permission 두 분기 공통 방어선).
        (
            role_id is null
            or role_id in (
                select id from center_roles cr
                where cr.center_id = manager_centers.center_id
            )
        )
        and (
            (
                -- self 분기로 실제로 바꿀 수 있는 건 "이 센터의 오너 role로, status
                -- active로" 딱 한 가지 결과뿐이다(부트스트랩 완료 전환).
                account_id = my_account_id()
                and status = 'active'
                and role_id in (
                    select id from center_roles cr
                    where cr.center_id = manager_centers.center_id and cr.is_owner = true
                )
            )
            or has_permission(center_id, 'facility.staff.update')
        )
    );

-- ------------------------------------------------------------
-- [4] DELETE "오너 스태프 삭제" — SEC-113: 마지막 남은 행 self-delete → orphan 차단
--     (self/has_permission 두 분기 공통 — 관리 권한이 있어도 "그 센터의 마지막
--     한 명"은 지울 수 없다. SEC-101의 self-insert 재개 조건과 정확히 반대 조건이라
--     이 정책이 있는 한 manager_centers 행이 0건인 센터 자체가 만들어지지 않는다.)
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and exists (
            select 1 from manager_centers mc2
            where mc2.center_id = manager_centers.center_id
              and mc2.id <> manager_centers.id
        )
    );

COMMIT;

-- ============================================================
-- 완료.
--   - "매니저센터 생성": 방금 만든(아직 아무도 연결 안 된) 센터에만 self-insert 허용,
--     role_id는 항상 null로만.
--   - "오너 스태프 초대": has_permission 요건 그대로 + role_id가 그 센터 소속인지만 추가 검증.
--   - "오너 스태프 수정": self 분기는 "role_id가 아직 null인 내 행"만 대상, 결과는
--     "이 센터의 오너 role + active" 단 한 가지로 고정(부트스트랩 1회 전환). role이
--     이미 있는 행은 self 분기가 아예 적용 안 되므로 어떤 방법으로도(같은 센터든
--     타 센터든) self-promote 불가능.
--   - "오너 스태프 삭제": 그 center_id에 이 행 말고 다른 manager_centers 행이 최소
--     하나는 남아있어야만 삭제 가능(self/권한 삭제 공통) — 마지막 한 명 삭제 자체가
--     DB 레벨에서 봉쇄되어 orphan → self-claim 체인이 원천 차단된다.
-- ============================================================
