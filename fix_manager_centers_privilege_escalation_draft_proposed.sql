-- ============================================================
-- SEC-101 + SEC-112(둘 다 P0) 통합 수정: manager_centers 권한 상승 2건
-- [2026-08-14 재설계 — v2] 아래 [v2 재설계] 절 먼저 읽을 것. v1(2026-08-12)은
-- 이 파일 그대로 실행 보류됐고, 사용자가 지적한 두 케이스(초대된 null-role
-- staff의 self-promote, orphan center의 self-claim)를 막지 못했다.
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
-- ============================================================
-- [v2 재설계 — 2026-08-14, 사용자 지적 2건 반영]
-- ============================================================
--
-- ⚠ v1의 두 가지 미해결 사항(사용자가 직접 재현 시나리오로 지적, 둘 다 코드로 재확인 완료):
--
--   (1) [v1 "오너 스태프 수정" self 분기의 실제 결함] v1의 USING/WITH CHECK 자기 분기는
--   "account_id = my_account_id() and role_id is null"만 후보 조건으로 썼다. 이건
--   "role_id가 아직 없는 내 행"이 (a) 방금 만든 새 센터의 부트스트랩 행인지, (b) 오너가
--   role을 나중에 정하기로 하고 role_id를 null로 남겨둔 채 초대한 기존 센터의 저권한
--   스태프 행인지 DB 레벨에서 전혀 구분하지 않는다 — 둘 다 정확히 같은 조건
--   (account_id=나, role_id=null)을 만족하므로 (b)도 (a)와 똑같이 self-UPDATE로
--   그 센터의 오너 role을 자기 것으로 만들 수 있었다.
--     - 현재 lib/roles.ts의 inviteStaff(centerId, accountId, roleId)는 roleId가 필수
--       매개변수라 앱 UI 경로로는 role_id=null 초대가 실제로 일어나지 않는다(확인 완료).
--       하지만 "오너 스태프 초대" INSERT 정책 자체는 DB 레벨에서
--       "role_id is null or role_id in (그 센터 role)"로 role_id=null을 명시적으로
--       허용하므로, facility.staff.create 권한이 있는 계정이 앱 UI를 거치지 않고 직접
--       RPC/REST로 role_id=null 초대 행을 만드는 것은 지금도 가능하다 — RLS는 "UI가
--       이렇게 안 한다"에 기대면 안 된다(이 감사 전체에서 일관되게 적용한 원칙과 동일).
--     - 수정: self 분기 후보 조건에 "이 행이 그 센터의 유일한 manager_centers 행인가"를
--       추가한다. 갓 생성된 센터는 부트스트랩 시점에 정확히 이 행 하나뿐이므로 그대로
--       통과하고, 이미 오너(또는 다른 스태프)가 있는 센터에 role_id=null로 초대된 행은
--       "다른 행이 이미 있음"이 되어 self 분기 후보에서 제외된다 — 부트스트랩과
--       초대-후-미배정을 정확히 구분하는 유일한 DB 레벨 근거.
--
--   (2) [v1 "매니저센터 생성" INSERT 정책의 orphan center 재평가] v1은 orphan center
--   self-claim 문제를 "SEC-113(별도, 저위험 후속 이슈)"로 분리했었다. 사용자 지적대로
--   재평가한 결과, 이건 SEC-113의 부수 효과가 아니라 SEC-101 자체의 우회 경로다:
--   "매니저센터 생성" 정책의 NOT EXISTS(그 center_id의 manager_centers 행)는
--   "이 센터가 방금 만들어졌다"와 "이 센터가 원래 있었는데 스태프가 전부 없어졌다
--   (orphan)"를 전혀 구분하지 않는다. 후자는 실제 회원/수업/결제 이력이 있는 승인된
--   센터일 수 있고, 그런 센터가 (SEC-113: 오너가 자기 마지막 행을 실수로/의도적으로
--   삭제하는 경로로) orphan이 되면, 이 정책은 "새 센터"와 똑같이 취급해 아무나
--   self-claim해 오너가 되는 걸 허용한다 — 이건 SEC-101이 막으려던 것과 정확히 같은
--   피해(임의 사용자가 정상 운영 중이던 센터의 오너가 됨)이므로 SEC-101 범위 안의
--   미해결 우회로 재분류한다.
--     - 수정: self-insert 후보 조건에 "이 center_id의 centers.status가 'pending'인가"를
--       추가한다. centers.status는 pending/approved/rejected 셋뿐이고(schema.sql 확인),
--       registerCenterForAccount()는 centers.status를 지정하지 않아 DB 기본값
--       'pending' 그대로 INSERT한다(lib/centers.ts 확인) — 즉 정상 부트스트랩은
--       항상 status='pending'인 센터에서 일어난다. 반면 orphan이 될 수 있는 센터는
--       실사용 이력이 있으려면 최소 한 번은 platform admin이 'approved'로 바꿨어야
--       하므로(centers.status는 최초 이후 self-service로 되돌릴 방법이 없음 —
--       app/lib 전수 검색으로 approved→pending 되돌리는 코드 경로 없음을 확인) 이미
--       'approved' 상태다. 'rejected'도 명시적 관리자 결정이므로 self-claim 대상에서
--       제외한다. 'pending' 상태의 진짜 orphan(부트스트랩되다 만 채 방치된 신규 센터)은
--       여전히 self-claim 가능하지만, 그런 센터는 애초에 실사용 이력이 없어(승인 전이라
--       공개/예약 자체가 불가능 — "승인된 센터 조회" 등 여러 정책이 approved만 노출)
--       피해가 사실상 0에 수렴한다.
--     - 이 수정은 SEC-113의 근본 원인(DELETE 정책의 self 분기가 마지막 행 삭제를
--       막지 않음)을 고치지 않는다 — 오너가 실수로 자기 마지막 행을 지우면 그 센터는
--       여전히 "관리자가 아무도 없는 상태"가 된다. 다만 이 v2 수정 이후에는 그 상태가
--       "아무나 self-claim해서 오너가 될 수 있는" 권한 상승으로는 더 이상 이어지지
--       않는다(가용성 문제로만 남음 — 정당한 오너가 다시 들어올 방법이 없어져
--       플랫폼 운영자의 수동 개입이 필요해지는 문제). 이 가용성 문제는 여전히 별도
--       SEC-113 후속 배치로 유지한다(DELETE 정책 자체를 고쳐야 함 — 이번 파일은
--       INSERT/UPDATE만 다룸, 범위 밖).
--
-- ============================================================
--
-- [정상 흐름과의 관계 — 반드시 보존]
--   lib/centers.ts registerCenterForAccount()의 4단계(자기 role_id를 null → 방금 만든
--   센터의 오너 role로 UPDATE)가 "오너 스태프 수정"의 self 분기를 정확히 이 용도로 쓴다.
--   lib/roles.ts updateStaffRole()(유일한 다른 UPDATE 호출부, 타인 대상)는 has_permission
--   분기만 쓴다. specialty 컬럼은 app/lib 전체에서 참조 0건(완전한 dead field, 자기수정
--   기능 자체가 없음) — 이 컬럼을 이번 수정으로 더 엄격하게 잠궈도 실사용 영향 없음.
--
-- [설계 비교 — 사용자 요청에 따른 4안 검토, 최종 B안 채택]
--   A) 부트스트랩을 security definer RPC/trigger로 완전히 옮기고 self-UPDATE 분기 자체를
--      제거. 가장 근본적으로 깔끔하지만 lib/centers.ts를 새 RPC 호출로 바꿔야 해서
--      "코드 수정"이 필요하다 — 이번 정적 감사/STOP 범위를 넘어선다.
--   B) [채택] client bootstrap은 그대로 두고, self-UPDATE/self-INSERT를 "부트스트랩임을
--      DB에서 확인 가능한 조건(유일한 행 + centers.status='pending')"으로 좁힌다.
--      SQL만으로 완결되고 lib/centers.ts는 단 한 줄도 바꿀 필요가 없다.
--   C) 센터 생성 + 오너 연결을 하나의 atomic RPC로 통합. 원자성 이점은 실재하지만
--      lib/centers.ts 변경이 필요해 이번 범위 밖. 장기 권장(최종 보고서 참고).
--   D) 검토했으나 B보다 안전하거나 간단한 대안을 찾지 못함.
--
-- [role_id 교차 센터 주입 차단]
--   self 분기든 has_permission 분기든 관계없이, 결과 role_id는 항상
--   "그 행의 center_id와 같은 센터의 center_roles"에 속해야 한다는 제약을 모든 쓰기
--   경로(INSERT 2개 + UPDATE 1개) 공통으로 건다.
--
-- [race condition] 동시 self-insert(TOCTOU)는 방금 막 만들어진, 암호학적으로 예측
--   불가능한 UUID를 실시간으로 알아내 그 찰나에 경쟁해야 해 실질적으로 악용 불가능한
--   잔여 리스크로 판단 — 이번 배치에서 SERIALIZABLE/advisory lock까지는 도입하지 않음.
--
-- 여러 번 실행해도 안전(drop policy if exists + create policy).
-- 단일 트랜잭션(BEGIN/COMMIT)으로 묶어 3개 정책 중 일부만 적용된 위험한 중간 상태를
-- 방지한다(2026-08-13 교차검증에서 추가).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] INSERT "매니저센터 생성" — SEC-101: 낯선 사람의 self-join +
--     orphan(approved/rejected) center self-claim 차단
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
        -- [v2 신규] 이 center_id가 아직 platform admin 승인 전(pending)일 때만
        -- self-insert 허용 — approved/rejected 센터는 실사용 이력이 있었거나
        -- 명시적으로 반려된 것이므로, 어떤 이유로 orphan(manager_centers=0행)이
        -- 됐더라도 self-claim 대상이 아니다.
        and exists (
            select 1 from centers c
            where c.id = manager_centers.center_id and c.status = 'pending'
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
-- [3] UPDATE "오너 스태프 수정" — SEC-112: self-promote(같은 센터 + 타 센터 role_id) 차단,
--     초대된 null-role 스태프의 self-promote도 차단(v2 신규)
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        -- self 분기는 "아직 role이 없는(null) 내 행" 중에서도, "그 센터에 이 행 외
        -- 다른 manager_centers 행이 전혀 없을 때"만 후보가 된다(v2 신규 조건) —
        -- 이게 "방금 만든 센터의 부트스트랩 행"과 "이미 오너/스태프가 있는 센터에
        -- role_id=null로 초대된 행"을 구분하는 유일한 DB 레벨 근거다. 전자만
        -- 유일한 행이고, 후자는 최소 오너 행이 이미 존재하므로 이 조건을 만족 못한다.
        (
            account_id = my_account_id()
            and role_id is null
            and not exists (
                select 1 from manager_centers mc2
                where mc2.center_id = manager_centers.center_id
                  and mc2.id <> manager_centers.id
            )
        )
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
                -- active로" 딱 한 가지 결과뿐이다(부트스트랩 완료 전환). "유일한 행"
                -- 조건은 USING에서 이미 후보를 걸렀으므로(그 사실은 이 UPDATE 자체로
                -- 바뀌지 않는다) 여기서 반복하지 않는다.
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

COMMIT;

-- ============================================================
-- 완료.
--   - "매니저센터 생성": 방금 만든(아직 아무도 연결 안 되고 platform admin 승인
--     전인) 센터에만 self-insert 허용, role_id는 항상 null로만.
--   - "오너 스태프 초대": has_permission 요건 그대로 + role_id가 그 센터 소속인지만
--     추가 검증.
--   - "오너 스태프 수정": self 분기는 "role_id가 아직 null이면서 그 센터의 유일한
--     행인 내 행"만 대상, 결과는 "이 센터의 오너 role + active" 단 한 가지로 고정
--     (부트스트랩 1회 전환). role이 이미 있거나 다른 행이 이미 존재하는 센터는
--     self 분기가 아예 적용 안 되므로 어떤 방법으로도(같은 센터든 타 센터든,
--     null-role 초대 경유든) self-promote 불가능. has_permission 분기는 기존과
--     동일하게 자유롭게 동작(단, role_id가 그 센터 소속이어야 한다는 제약만 공통 추가).
-- ============================================================

-- 확인(읽기 전용)
select policyname, cmd, qual, with_check from pg_policies where tablename = 'manager_centers' order by policyname;
