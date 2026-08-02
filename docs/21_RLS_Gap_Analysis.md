# RLS Gap Analysis (SEC-007 / SEC-008)

> 이 문서는 **조사·설계 산출물**입니다. 여기 나오는 SQL은 전부 **초안(draft)**이며,
> 별도 승인 없이는 운영 Supabase에 절대 실행하지 마세요. 실제 적용은
> `proposed_rls_gap_batch_a.sql` ~ `proposed_rls_gap_batch_d.sql`(2026-08-01부터 이 4개
> 파일이 실제 적용용 — 아래 "단계 적용 계획" 참고) 파일을 검토·승인받은 뒤 별도 Batch에서
> 진행합니다. `add_rls_gap_tables_draft_proposed.sql`은 최초 조사 시점의 기록으로 보존됩니다.

## ⚠️ 2026-08-02 정정 3 — Batch A1 적용 후 messages SELECT 정책 결함 발견

`proposed_rls_gap_batch_a1.sql`이 실제로 적용된 뒤 `tests/integration/sec009-batch-a1-rls.test.ts`를
돌린 결과 **37/38 통과**, `messages`의 "message.sms.view 권한이 있으면 SMS만 보이고 푸시는
여전히 안 보인다" 1건만 실패했다(push 채널 행이 함께 보임). `staff_salaries`/`leads`는
정상 동작이 실제 확인됐다.

**원인**: `messages` SELECT 정책만 channel로 나뉘지 않고 `message.sms.view`/`message.push.view`를
단순 OR로 묶어놨다(INSERT/UPDATE/DELETE는 원래부터 channel로 정확히 분리돼 있었음 — SELECT만
누락된 결함, 최초 SEC-008 초안 시점부터 있었고 여러 차례 검토에서도 놓쳤다).

**수정**: `fix_messages_select_channel_scope_draft_proposed.sql`(짝 파일
`rollback_fix_messages_select_channel_scope_draft_proposed.sql`)로 `messages`의 SELECT
정책만 최소 범위로 수정 — `staff_salaries`/`leads`와 `messages`의 INSERT/UPDATE/DELETE는
전혀 건드리지 않는다. **아직 실행하지 않음, 사용자 승인 대기 중.** 위험도는 낮음으로
판단됨(SEC-007에서 이미 확인한 대로 `messages`는 app/lib 코드 참조 0건이라 실제 운영
데이터가 있을 가능성이 낮음).

## ⚠️ 2026-08-02 정정 — "RLS 없음" 분류가 부정확했음 (SEC-009에서 발견)

이 문서와 이슈(SEC-007)는 아래 17개 테이블을 전부 "RLS가 없거나 정책이 0건"으로 분류했다.
"정책 0건"은 실제 조회로 확인했지만(각 테이블 CREATE POLICY 문 부재), **"RLS 활성화 여부"는
직접 확인하지 않고 정책 부재로부터 추정**했다 — 이 둘은 Postgres에서 서로 독립적인 별개
상태다(정책이 0건이어도 RLS는 켜져 있을 수 있고, 그 경우 결과는 "전체 공개"가 아니라
정반대인 "완전 차단"이다).

SEC-009(Batch A 적용 준비) 작업 중 실제 개발(dev) Supabase에 대해 오너 권한으로 insert를
시도해본 결과, Batch A의 5개 테이블(`staff_salaries`/`contracts`/`leads`/`messages`/
`notification_logs`) **전부 이미 RLS가 활성화된 상태**였고(정책만 0건 — 즉 현재 오너를
포함해 아무도 접근할 수 없는 완전 차단 상태), 이 저장소의 어떤 `*.sql` 파일에도 이걸 켠
기록이 없다(Supabase 대시보드에서 직접 조작된 것으로 추정). 즉 **당장의 활성 위험(무권한
접근)은 이 5개 테이블에는 해당하지 않았다** — 다만 정책이 없어 정상 기능도 동작하지 않는
상태였을 뿐이다.

**아직 확인되지 않은 것**:
- Batch B/C/D의 12개 테이블은 이번에 직접 확인하지 않았다 — 같은 drift가 있을 수도, 없을 수도
  있다. Batch B부터는 SEC-009와 동일한 방법(오너 권한 insert 시도 → 42501 에러 코드로 판정)으로
  각 배치 적용 전 반드시 재확인해야 한다.
- **운영(production) Supabase의 실제 상태는 전혀 확인하지 못했다**(이 세션에 접근 권한 없음).
  dev와 production이 같은 상태라고 가정하지 말 것 — 실행 승인 전 별도 확인 필요.

**영향**: `proposed_rls_gap_batch_a.sql`의 결론(권한 기반 정책 추가)은 여전히 유효하다(정책이
없다는 사실 자체는 맞았음). 다만 `rollback_rls_gap_batch_a.sql`은 원래 "RLS 비활성화" 상태로
되돌리도록 작성돼 있었는데, 그렇게 하면 원래보다 더 위험한 상태(전체 공개)가 되므로 정책만
제거하도록 수정했다(두 파일 모두 헤더에 정정 내용 기록).

## ⚠️ 2026-08-02 정정 2 — service_role에 5개 테이블 SQL GRANT 자체가 없음

위 발견과는 별개로, `staff_salaries`/`contracts`/`leads`/`messages`/`notification_logs` 5개
테이블 전부 `service_role`에 SQL GRANT가 없다는 것도 확인했다(`permission denied for table X`
— `account_center_permissions`에서 이미 겪은 것과 같은 종류의 문제, RLS와는 무관한 별개
설정). `staff_salaries`/`leads`/`messages`는 오너에게 INSERT+DELETE 정책이 모두 있어 일반
로그인 client(오너)로 fixture를 만들고 지울 수 있어 문제되지 않지만, `contracts`(DELETE
정책이 의도적으로 없음 — 서명 후 불변 원칙)와 `notification_logs`(INSERT 정책이 의도적으로
없음 — 서버 트리거 전용)는 일반 client·admin client 어느 쪽으로도 지금은 fixture를 만들거나
지울 방법이 없다. 이 두 테이블은 `GRANT ALL ON TABLE ... TO service_role`이 별도 승인·실행된
뒤에나 자동화된 통합 테스트를 안전하게 추가할 수 있어, `tests/integration/sec009-batch-a1-rls.test.ts`는
`staff_salaries`/`leads`/`messages` 3개만 다루고 `contracts`/`notification_logs`는 A2로 분리해
의도적으로 제외했다 — 상세는 `docs/TODO.md` P2-13, [22_RLS_Gap_A2_Investigation.md](./22_RLS_Gap_A2_Investigation.md) 참고.

## 2026-08-02 확인 — Batch A1(3개 테이블) 역할별 기대 결과 매트릭스

읽기 전용 진단(`anon`/`authenticated`/`service_role`로 SELECT 시도, mutation 없음)과
`proposed_rls_gap_batch_a1.sql`의 정책 조건을 근거로 작성. `R`=조회 가능, `W`=쓰기 가능,
`own`=본인 관련 행만, `-`=차단.

### staff_salaries (own/other 권한 완전 분리 — 다른 두 테이블과 조건 형태가 다름)

| 역할 | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| anon | - | - | - | - |
| member(그 센터 소속 아님) | - | - | - | - |
| staff 무권한 | - | - | - | - |
| staff — own.view/own.update만 보유 | own행만 R/W | own행만 | own행만 | - (delete는 other.update 전용 키라 own 권한으론 불가) |
| staff — other.view/other.update만 보유 | 타인행만 R/W | 타인행만 | 타인행만 | 타인행만(other.update 있으면 가능) |
| owner | 전체 R/W | 전체 | 전체 | 전체 |
| platform admin | **-**(이 테이블 정책엔 `is_platform_admin()` 분기가 없음 — 그 센터의 manager_centers 관계가 없는 한 접근 불가) | - | - | - |
| 타 센터 owner/staff | - | - | - | - |

### leads / messages (permission key 그대로, own/other 분리 없음)

| 역할 | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| anon | - | - | - | - |
| member(그 센터 소속 아님) | - | - | - | - |
| staff 무권한 | - | - | - | - |
| staff — 해당 permission key 보유(`customer.lead.*` 또는 `message.sms.*`/`message.push.*`, messages는 channel별로 독립) | R/W | W | W | W |
| owner | 전체 R/W | 전체 | 전체 | 전체 |
| platform admin | **-**(이 두 테이블도 `is_platform_admin()` 분기 없음) | - | - | - |
| 타 센터 owner/staff | - | - | - | - |

**참고**: `contracts`/`notification_logs`(A2)는 정책에 `is_platform_admin()` 분기가 **있어서**
platform admin이 조회 가능하지만, A1의 3개 테이블(`staff_salaries`/`leads`/`messages`)은
카탈로그의 permission key 체계만 사용하고 platform admin 특례가 없다 — 기존 카탈로그 설계
그대로이며 이번에 새로 바꾸지 않았다.

### 현재(정책 적용 전) 실제 상태 — 위 매트릭스는 SQL 적용 후 기대값이며, 지금은 아래처럼 다르다

| 항목 | 실제 확인 결과 |
|---|---|
| RLS 활성화 | 3개 테이블 전부 이미 활성화됨(정책 0건) |
| 현재 정책 | 3개 테이블 전부 0건(직접 조회 불가 — PostgREST가 pg_policies를 노출하지 않아, INSERT 시도가 전부 "new row violates row-level security policy"로 실패하는 것으로 간접 확인) |
| anon GRANT | 있음(SELECT 시도 시 에러 없이 0건 반환) |
| authenticated GRANT | 있음(SELECT 시도 시 에러 없이 0건 반환, RLS가 0건으로 필터링) |
| service_role GRANT | **없음**(`permission denied for table X`) — 테스트 도구 전용 문제, 앱 기능과 무관 |
| 실제 데이터 행 수 | **확인 불가** — anon/authenticated는 RLS가 막아 0건만 보이고 service_role은 GRANT가 없어 조회 자체가 안 됨. PostgREST로는 어느 role로도 진짜 행 수를 알 방법이 없다(슈퍼유저/대시보드 직접 접근이 아니면 확인 불가능) |
| 즉, 현재(적용 전) 결과 | **모든 역할(owner 포함)이 SELECT/INSERT/UPDATE/DELETE 전부 차단** — 정책이 0건이라 owner 특례(`has_permission()`의 is_owner 분기)조차 평가되지 않음(RLS가 정책 자체를 못 찾아 기본 거부) |

## 단계 적용 계획 (2026-08-01 갱신 — ACL-003 재검증 이후)

ACL-003 서버 측 재검증에서 "센터 소속이면 누구나(무권한 스태프 포함) 접근 가능"이라는 과다
권한 패턴이 실제 보안 결함으로 확인된 뒤, 이 문서의 17개 테이블 정책 초안 중
`my_managed_center_ids()`만으로 **쓰기**를 허용하던 항목을 재검토해 더 구체적인
`has_permission()` 권한 키로 좁혔습니다(아래 "정책 강화 내역" 참고). 단일 파일 대신
4개 독립 배치로 나눠, 각 배치를 따로 적용·검증·rollback할 수 있게 했습니다.

| Batch | 파일 | 대상 |
|---|---|---|
| A1 — 민감정보 최우선(통합 테스트 준비됨) | `proposed_rls_gap_batch_a1.sql` | staff_salaries, leads, messages |
| A2 — 민감정보 최우선(추가 조사 중, SQL 미확정) | (초안만, [22_RLS_Gap_A2_Investigation.md](./22_RLS_Gap_A2_Investigation.md)) | contracts, notification_logs |
| B — 직원 운영 데이터 | `proposed_rls_gap_batch_b.sql` | staff_schedules, schedule_memos, contract_templates, terms |
| C — 회원·시설 기능 | `proposed_rls_gap_batch_c.sql` | lockers, locker_assignments, membership_transfers, class_types |
| D — 미구현·레거시 후보 | `proposed_rls_gap_batch_d.sql` | popup_notices, competitions, community_comments, change_logs |

**2026-08-02**: 원래 하나였던 Batch A(5개 테이블)를 A1/A2로 분리했습니다 — A1의 3개 테이블은
`tests/integration/sec009-batch-a1-rls.test.ts`로 통합 테스트 커버리지가 준비됐지만, A2의
2개 테이블(`contracts`/`notification_logs`)은 service_role GRANT 부재로 fixture 생성·정리를
자동화할 방법이 없어 검증되지 않은 상태입니다. 검증되지 않은 테이블을 검증된 테이블과 함께
적용하면 회귀 발생 시 원인 분리가 어렵다는 지적에 따라 분리했습니다. `proposed_rls_gap_batch_a.sql`/
`rollback_rls_gap_batch_a.sql`(5개 테이블 통합본)은 역사적 기록으로 보존하고, 실제 적용은
A1 파일만 사용합니다.

각 배치는 짝 `rollback_rls_gap_batch_*.sql` 파일을 가지며, FK 의존성은 전부 같은 배치
내부에서만 존재합니다(예: `locker_assignments`→`lockers`는 둘 다 Batch C). 배치 간 교차
FK 의존은 없어 어떤 순서로 적용해도 안전합니다 — 다만 민감도상 A1→A2→B→C→D 순서를 권장합니다.

### 정책 강화 내역 (원안 → 배치 파일에서 수정된 항목)

| 테이블 | 원안(add_rls_gap_tables_draft_proposed.sql) | 배치 파일에서 강화됨 | 사유 |
|---|---|---|---|
| `class_types` (쓰기) | `center_id in (my_managed_center_ids())` | `has_permission(center_id,'facility.operation')` | ACL-003과 동일한 과다 권한 패턴 |
| `lockers` (쓰기) | `center_id in (my_managed_center_ids())` | `has_permission(center_id,'facility.operation')` | 〃 |
| `locker_assignments` (쓰기) | `center_id in (my_managed_center_ids())`(lockers 경유) | `has_permission(center_id,'customer.member.update')` | 〃, 회원정보 변경에 가까운 행위 |
| `popup_notices` (센터 쓰기) | `center_id in (my_managed_center_ids())` | `has_permission(center_id,'facility.notification')` | 〃 |
| `notification_logs` (조회) | `center_id in (my_managed_center_ids())` | `has_permission(center_id,'message.sms.view' or 'message.push.view')` | 정산 데이터 — 조회도 좁힘 |
| `change_logs` (조회) | `center_id in (my_managed_center_ids())` | `has_permission(center_id,'facility.role_permission')` | 감사로그 — account_center_permissions와 동일한 "관리자급" 대리 키 사용 |

**정당화된 예외로 유지**: `staff_schedules`(조회)와 `schedule_memos`(조회)는 여전히
`my_managed_center_ids()`만 사용합니다 — ACL-003의 실제 피해(다른 사람의 권한 grant/deny
같은 민감정보 유출)와 달리, 이 두 테이블의 조회 대상은 "휴가/외부미팅" 같은 낮은 민감도의
캘린더 조율 정보이고 같은 센터 스태프끼리 서로의 일정을 볼 수 있어야 하는 것이 원래
제품 의도이기 때문입니다. 수정/삭제(쓰기)는 두 테이블 모두 이미 본인 것 + 구체적 권한
키를 요구하고 있어 문제가 없습니다.

## 재분류 (2026-08-01, SEC-007/008 단계 적용 준비)

| 테이블 | PII 민감도 | 코드 사용 | center_id | tenant scope | 정상 역할 | 공개 읽기 | 쓰기 주체 | 기존 데이터 | RLS 활성화 기능장애 위험 | 삭제후보 | 우선순위 | Batch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| change_logs | 중 | 0건 | 있음 | 직접 | 권한보유staff | 불필요 | 서버(RPC/트리거) | 낮음 | 낮음 | 아니오(기능 존속 결정 대기) | Medium | D |
| class_types | 없음 | 0건 | 있음 | 직접 | 로그인전체/권한보유staff | 필요(로그인) | facility.operation 보유자 | 낮음 | 낮음 | 아니오 | Low | C |
| community_comments | 낮음 | 0건 | 없음 | 간접(community_posts) | 로그인전체/작성자본인 | 필요(로그인) | 작성자 | 낮음 | 낮음 | 아니오(로드맵 결정 대기) | Medium | D |
| competitions | 없음 | 0건 | 없음(전역) | 없음 | 전체(anon포함)/platform admin | 필요 | platform admin | 낮음 | 낮음 | 아니오 | Low | D |
| contract_templates | 없음 | 0건 | 있음 | 직접 | 권한보유staff | 불필요 | contract.template.write 보유자 | 낮음 | 낮음 | 아니오 | Medium | B |
| contracts | 매우높음 | 0건 | 있음 | 직접 | 본인/권한보유staff | 불필요 | 권한보유staff(RPC전환 권장) | 낮음 | 낮음 | 아니오 | **Critical** | A |
| leads | 높음 | 0건 | 있음 | 직접 | customer.lead.* 보유자 | 불필요 | 권한보유staff | 낮음 | 낮음 | 아니오 | High | A |
| lockers | 없음 | 0건 | 있음 | 직접 | 로그인전체/권한보유staff | 필요(로그인) | facility.operation 보유자 | 낮음 | 낮음 | 아니오 | Low | C |
| locker_assignments | 낮음~중 | 0건 | 없음 | 간접(lockers) | 본인/권한보유staff | 불필요 | customer.member.update 보유자 | 낮음 | 낮음 | 아니오 | Medium | C |
| membership_transfers | 중 | 0건 | 없음 | 간접(memberships) | 당사자/권한보유staff | 불필요 | RPC 전용(정책 없음) | 낮음 | 낮음 | 아니오 | Medium | C |
| messages | 높음 | 0건 | 있음 | 직접 | message.sms/push.* 보유자 | 불필요 | 권한보유staff | 낮음 | 낮음 | 아니오 | High | A |
| notification_logs | 낮음~중 | 0건 | 있음 | 직접 | message.*.view 보유자 | 불필요 | 서버 트리거 | 낮음 | 낮음 | 아니오 | Medium | A |
| popup_notices | 없음 | 0건 | 있음(nullable) | 직접/전역 | 전체(anon포함)/권한보유+platform admin | 필요 | 권한보유staff/platform admin | 낮음 | 낮음 | 아니오 | Low | D |
| schedule_memos | 중 | 0건 | 없음 | 간접(classes/staff_schedules) | 센터소속전체(조회, 정당화된 예외)/작성자+권한보유(쓰기) | 불필요 | 작성자/권한보유staff | 낮음 | 낮음 | 아니오 | Medium | B |
| staff_salaries | 매우높음 | 0건 | 있음 | 직접 | facility.salary.own/other.* 보유자 | 불필요 | 권한보유staff | 낮음 | 낮음 | 아니오 | **Critical** | A |
| staff_schedules | 중 | 0건 | 있음 | 직접 | 센터소속전체(조회, 정당화된 예외)/본인+schedule.own.etc.*(쓰기) | 불필요 | 본인 | 낮음 | 낮음 | 아니오 | Medium | B |
| terms | 없음 | 0건 | 있음 | 직접 | 전체(anon포함)/contract.terms.manage 보유자 | 필요 | 권한보유staff | 낮음 | 낮음 | 아니오 | Low | B |

"RLS 활성화 기능장애 위험"이 전부 낮음인 이유: 17개 테이블 모두 app/lib 코드 참조 0건이라
RLS를 켜도 지금 당장 깨질 기존 기능이 없습니다(반대로 이미 이 문서 서두에서 밝힌 대로,
"미사용 = 안전"이 아니라 "지금 당장은 발동 안 함"이라는 뜻일 뿐입니다).

## 조사 방법

`schema.sql` + 저장소 루트의 모든 `*.sql` 마이그레이션 파일을 합쳐 `create table` / `alter table ... enable row level
security` / `create policy ... on <table>`을 전수 매칭했습니다. 총 66개 테이블 중 RLS가 아예 없거나(`no`) 정책이
0건인 테이블이 18개 나왔고, 그중 `chat_messages`는 [DB-001](#db-001-chat_messages-결론)에서 별도로 다루므로 이 문서의
17개 대상에서 제외했습니다.

**핵심 발견**: 17개 테이블 전부 **app/lib 코드에서 현재 참조하는 곳이 0건**입니다(`grep` 전수 확인). 대부분 스키마 주석에
"2차/3차 확장 기능"이라고 명시된, 아직 화면이 만들어지지 않은 기능입니다. 즉 **일반 사용자가 앱 UI를 통해 이 데이터에
접근할 경로는 없습니다.** 하지만 Supabase는 PostgREST를 통해 `public` 스키마의 모든 테이블을 REST API로 자동 노출하므로,
**`NEXT_PUBLIC_SUPABASE_ANON_KEY`(클라이언트 번들에 이미 공개된 키)만 있으면 앱 코드를 거치지 않고 누구나 직접
`select * from staff_salaries` 같은 요청을 보낼 수 있습니다.** RLS가 없으면 이 요청이 그대로 성공합니다. 이것이
"현재 사용 안 함 = 안전"이 아니라 "현재는 잠재(dormant) 위험, 기능이 켜지는 순간 즉시 활성 위험"이 되는 이유입니다.

## 재사용 가능한 기존 헬퍼 함수

기존 코드(`reservation_functions.sql`, `schema.sql`)에 이미 아래 함수가 있어 새 정책에 그대로 재사용합니다(새 함수 설계 불필요):

- `my_account_id()` — 로그인 계정의 `accounts.id`
- `my_managed_center_ids()` — 내가 활성(active) 상태로 근무 중인 센터 id 목록
- `has_permission(p_center_id uuid, p_permission text)` — 오너 전권 → 개인 deny → 개인 allow → 역할 권한 순으로 판정.
  `lib/roles.ts`에 이번 배치에서 추가한 `fetchMyEffectivePermissionKeys()`(클라이언트 표시용)와 동일한 우선순위 로직이라
  서버·클라이언트 판정이 일치합니다.
- `is_platform_admin()` — 플랫폼 운영자 여부

## 우선순위 요약

| 우선순위 | 테이블 | 사유 |
|---|---|---|
| Critical | `staff_salaries` | 급여·커미션 등 금전 정보. 권한 카탈로그에 `facility.salary.own/*.other/*` 로 이미 세분화되어 있는데 DB엔 반영 안 됨 |
| Critical | `contracts` | 서명 이미지(`signature_url`) + 계약 스냅샷. 회원 개인정보 중 가장 민감 |
| High | `leads` | 미등록 잠재고객의 이름·전화번호 |
| High | `messages` | 대량 발송 대상자 목록(`target_profile_ids[]`) + 본문 |
| Medium | `change_logs`, `community_comments`, `contract_templates`, `locker_assignments`, `membership_transfers`, `notification_logs`, `schedule_memos`, `staff_schedules` | 회원/스태프 식별 정보와 연결되지만 단독 노출 시 피해는 위 항목보다 낮음 |
| Low | `class_types`, `competitions`, `lockers`, `popup_notices`, `terms` | PII 없음(단, anon이 INSERT/UPDATE/DELETE까지 가능한 것은 별도 "위변조" 리스크로 계속 관리 필요) |

## 테이블별 상세 (14개 항목)

각 테이블마다 ①목적/설명 ②개인정보 포함 ③Tenant Scope ④현재 코드 사용여부 ⑤예상 접근 역할(anon/member/staff/owner/platform admin)
⑥SELECT 정책초안 ⑦INSERT 정책초안 ⑧UPDATE 정책초안 ⑨DELETE 정책초안 ⑩기존 데이터 영향 ⑪회귀 가능성 ⑫테스트 시나리오 ⑬우선순위 순으로 기재합니다.
(⑭ 열 "우선순위"는 위 요약표와 중복되므로 각 항목 마지막 줄에 표기)

### 1. change_logs
- **목적**: 수강권 등 주요 정보 변경이력(누가/언제/무엇을) 추적용 감사로그
- **개인정보**: 중간 — `changed_fields` jsonb에 변경 전/후 값이 그대로 들어가 회원 개인정보가 포함될 수 있음
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건) — 기록하는 트리거/코드 자체가 아직 없음
- **예상 접근 역할**: staff(자기 센터, 조회만), owner(자기 센터 전체), platform admin(전체)
- **SELECT 초안**: `center_id in (select my_managed_center_ids())` (조회 권한은 세분화된 permission key가 카탈로그에 없어 "센터 소속 스태프 전체 조회"로 설계)
- **INSERT 초안**: 서버 함수(트리거/RPC)만 기록해야 함 — 클라이언트 직접 INSERT는 막고 `false`
- **UPDATE/DELETE 초안**: 감사로그 성격상 수정/삭제 불허 — `false` (또는 정책 자체를 만들지 않아 기본 거부)
- **기존 데이터 영향**: 없음(빈 테이블로 추정, 기록 코드 자체가 없음)
- **회귀 가능성**: 낮음 — 아무 코드도 참조하지 않음
- **테스트 시나리오**: 타 센터 스태프가 조회 시도 → 차단 / 클라이언트가 직접 insert 시도 → 차단
- **우선순위**: Medium

### 2. class_types
- **목적**: 센터가 정의하는 수업 구분(그룹핑용 카테고리)
- **개인정보**: 없음
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건) — `classes.class_type_id`가 참조는 하지만 조회 코드 없음
- **예상 접근 역할**: 모든 로그인 사용자 조회, staff/owner 쓰기
- **SELECT 초안**: `auth.role() = 'authenticated'` (center_holidays와 동일 패턴)
- **INSERT/UPDATE/DELETE 초안**: `center_id in (select my_managed_center_ids())` (세분화된 permission key 없음 — `facility.operation`으로 매핑 가능성 있으나 카탈로그에 명시적 연결은 없어 1차는 "센터 소속 스태프"로 설계)
- **기존 데이터 영향**: 없음(사용 안 함)
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 비로그인 조회 차단 / 타 센터 스태프 쓰기 차단
- **우선순위**: Low

### 3. community_comments
- **목적**: `community_posts` 게시글의 댓글
- **개인정보**: 낮음(작성자 연결은 있으나 이름 자체는 `accounts`에 있음)
- **Tenant Scope**: 게시글(`community_posts.center_id`)을 통한 간접 스코프(전역 가능)
- **현재 사용여부**: 미사용(0건) — 부모 `community_posts`도 사실상 미구현(정책 1개: 로그인 사용자 조회만 있고 글쓰기 정책도 없음)
- **예상 접근 역할**: 로그인 사용자 조회, 작성자 본인 쓰기/수정/삭제
- **SELECT 초안**: `auth.role() = 'authenticated'`
- **INSERT 초안**: `with check (author_account_id = my_account_id())`
- **UPDATE/DELETE 초안**: `using (author_account_id = my_account_id())`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음 — 부모 테이블도 미구현이라 함께 다뤄야 함(별도 이슈로 `community_posts`도 write 정책 보강 필요, 이번 배치 범위 밖으로 TODO에 기록)
- **테스트 시나리오**: 타 계정이 남의 댓글 수정/삭제 시도 → 차단
- **우선순위**: Medium

### 4. competitions
- **목적**: 종목별 대회/이벤트 정보(외부 링크 포함 가능)
- **개인정보**: 없음
- **Tenant Scope**: 전역(센터 무관)
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: anon 포함 전체 조회 가능(공개 정보), 쓰기는 platform admin만
- **SELECT 초안**: `true`
- **INSERT/UPDATE/DELETE 초안**: `is_platform_admin()`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: anon 조회 성공 / anon insert 시도 차단
- **우선순위**: Low

### 5. contract_templates
- **목적**: 센터별 전자계약서 템플릿(변수 치환 가능한 본문)
- **개인정보**: 없음(템플릿 자체는 개인정보 아님)
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: staff(조회), `contract.template.write/delete` 보유자만 쓰기
- **SELECT 초안**: `has_permission(center_id, 'contract.template.view')`
- **INSERT/UPDATE 초안**: `has_permission(center_id, 'contract.template.write')`
- **DELETE 초안**: `has_permission(center_id, 'contract.template.delete')`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 권한 없는 스태프 조회/쓰기 차단, 권한 보유 스태프 통과
- **우선순위**: Medium

### 6. contracts
- **목적**: 회원이 서명한 전자계약서 스냅샷(서명 이미지 포함)
- **개인정보**: 매우 높음 — `signature_url`(서명 이미지), `content`(계약 내용 스냅샷), `profile_id`
- **Tenant Scope**: `center_id` + `profile_id`
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 본인(계약 당사자) 조회, staff(`contract.list.view`/`contract.detail.view`), platform admin
- **SELECT 초안**: `profile_id in (select id from profiles where account_id = my_account_id()) or has_permission(center_id, 'contract.list.view') or is_platform_admin()`
- **INSERT 초안**: 서명 발급은 RPC(서버 검증)로만 처리 권장 — 직접 INSERT는 `has_permission(center_id, 'contract.list.view')`로 제한(임시), 후속 배치에서 RPC 전환 검토
- **UPDATE 초안**: `signed_at`/`status` 등은 RPC로만 — 직접 UPDATE는 `false` 권장(서명 후 스냅샷은 불변이어야 함)
- **DELETE 초안**: `false`(계약서는 법적 증빙, 삭제 불허 원칙)
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 타인 계약서 조회 차단 / 본인 계약서 조회 허용 / 직접 UPDATE 차단
- **우선순위**: Critical

### 7. leads
- **목적**: 아직 등록 전인 상담고객(잠재고객) 정보
- **개인정보**: 높음 — 이름, 전화번호, 상담 메모
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: `customer.lead.*` 권한 보유 스태프만
- **SELECT 초안**: `has_permission(center_id, 'customer.lead.view')`
- **INSERT 초안**: `has_permission(center_id, 'customer.lead.create')`
- **UPDATE 초안**: `has_permission(center_id, 'customer.lead.update')`
- **DELETE 초안**: `has_permission(center_id, 'customer.lead.delete')`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 권한별 CRUD 통과/차단 매트릭스 확인
- **우선순위**: High

### 8. locker_assignments
- **목적**: 회원별 락커 배정(사용중 락커/만료일)
- **개인정보**: 낮음~중간(회원 식별과 연결되지만 내용 자체는 락커 배정 정보뿐)
- **Tenant Scope**: `lockers.center_id`를 통한 간접 스코프
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 본인 조회, staff(센터 소속) 조회/관리
- **SELECT 초안**: `profile_id in (select id from profiles where account_id = my_account_id()) or locker_id in (select id from lockers where center_id in (select my_managed_center_ids()))`
- **INSERT/UPDATE/DELETE 초안**: `locker_id in (select id from lockers where center_id in (select my_managed_center_ids()))` (세분화된 permission key 없음 — 1차는 센터 소속 스태프로 설계)
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 타 센터 스태프 접근 차단 / 본인 배정 조회 허용
- **우선순위**: Medium

### 9. lockers
- **목적**: 센터별 락커 목록(이름만)
- **개인정보**: 없음
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 로그인 사용자 조회, staff 쓰기
- **SELECT 초안**: `auth.role() = 'authenticated'`
- **INSERT/UPDATE/DELETE 초안**: `center_id in (select my_managed_center_ids())`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 타 센터 스태프 쓰기 차단
- **우선순위**: Low

### 10. membership_transfers
- **목적**: 프로필 간 수강권 양도 이력(양도 시점 잔여횟수 기록)
- **개인정보**: 중간 — 양도인/양수인 프로필 연결
- **Tenant Scope**: `memberships.center_id`를 통한 간접 스코프
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 당사자(양도인/양수인) 조회, staff(`customer.member.pass_detail`)
- **SELECT 초안**: `from_profile_id in (select id from profiles where account_id = my_account_id()) or to_profile_id in (...) or exists (select 1 from memberships m where m.id = membership_id and has_permission(m.center_id, 'customer.member.pass_detail'))`
- **INSERT 초안**: 양도는 RPC로 처리 권장(잔여횟수 원자적 갱신 필요) — 직접 INSERT는 `false` 권장
- **UPDATE/DELETE 초안**: `false`(이력은 불변)
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 제3자 조회 차단 / 당사자·권한 보유 스태프 조회 허용
- **우선순위**: Medium

### 11. messages
- **목적**: 센터의 대량 SMS/앱푸시 발송 이력(예약발송 포함)
- **개인정보**: 높음 — `target_profile_ids[]`(수신 대상 배열), `content`(본문)
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건) — 대량 발송 기능 자체가 아직 화면으로 구현 안 됨
- **예상 접근 역할**: `message.sms.*`/`message.push.*` 권한 보유 스태프만
- **SELECT 초안**: `has_permission(center_id, 'message.sms.view') or has_permission(center_id, 'message.push.view')`
- **INSERT 초안**: `channel in ('sms','lms') → has_permission(center_id,'message.sms.send')`, `channel='push' → has_permission(center_id,'message.push.send')` (channel별 분기 필요 — CHECK 제약과 함께 설계)
- **UPDATE 초안**: 동일하되 `message.sms.update`/`message.push.update` (예약 취소만 허용, `status`가 'sent' 이후는 불변 권장)
- **DELETE 초안**: `message.sms.delete`/`message.push.delete`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 권한 없는 스태프 발송 이력 조회/발송 시도 차단
- **우선순위**: High

### 12. notification_logs
- **목적**: 자동 알림 발송 기록(건당 수수료 정산용)
- **개인정보**: 낮음~중간(`profile_id` 연결)
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: staff(정산 확인 목적) 조회만, 쓰기는 서버(트리거)만
- **SELECT 초안**: `center_id in (select my_managed_center_ids())` (세분화 permission key 없음 — 1차는 센터 소속 스태프)
- **INSERT/UPDATE/DELETE 초안**: `false`(서버 트리거 전용, 클라이언트 직접 조작 불허)
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 타 센터 스태프 조회 차단 / 클라이언트 직접 insert 차단
- **우선순위**: Medium

### 13. popup_notices
- **목적**: 앱 접속 시 즉시 노출되는 팝업 공지(센터별 또는 전체)
- **개인정보**: 없음
- **Tenant Scope**: `center_id`(nullable — 전체공지 가능)
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 전체 조회(anon 포함, 공지 성격), 쓰기는 `center_id`가 NULL이면 platform admin만 / 있으면 센터 스태프
- **SELECT 초안**: `true`
- **INSERT/UPDATE/DELETE 초안**: `(center_id is null and is_platform_admin()) or (center_id is not null and center_id in (select my_managed_center_ids()))`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: anon이 전체공지 삽입 시도(피싱성 팝업) → 차단, 센터 스태프가 자기 센터 팝업만 등록 가능
- **우선순위**: Low(단, anon write로 인한 "피싱 팝업 삽입" 리스크가 있어 RLS 미적용 상태 방치는 권장하지 않음)

### 14. schedule_memos
- **목적**: 수업/기타일정 상세페이지 메모
- **개인정보**: 중간(작성자·내용에 회원 관련 메모 포함 가능)
- **Tenant Scope**: `classes.center_id` 또는 `staff_schedules.center_id`를 통한 간접 스코프
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 센터 소속 스태프 조회, 본인 작성분만 수정/삭제(오너는 전체) — 테이블 주석에 이미 이 규칙이 명시돼 있음
- **SELECT 초안**: 연결된 `class_id`/`staff_schedule_id`의 `center_id`가 `my_managed_center_ids()`에 있으면 허용
- **INSERT 초안**: `with check (author_account_id = my_account_id())` + 위 센터 스코프
- **UPDATE/DELETE 초안**: `author_account_id = my_account_id() or has_permission(center_id, 'schedule.memo.update'/'schedule.memo.delete')` (오너 전권은 `has_permission`이 이미 처리)
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 타인 작성 메모 수정 시도(일반 스태프) 차단 / 오너는 허용
- **우선순위**: Medium

### 15. staff_salaries
- **목적**: 스태프 급여 설정(기본급/수업당 급여/인센티브율)
- **개인정보**: 매우 높음 — 급여는 가장 민감한 개인정보 중 하나. 권한 카탈로그에 이미 `facility.salary.own.*`(본인)과
  `facility.salary.other.*`(타인) view/update가 분리되어 있음 — DB 정책도 이 구분을 그대로 반영해야 함
- **Tenant Scope**: `center_id` + `account_id`(대상 스태프)
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 본인 급여(own 권한), 타 스태프 급여(other 권한), 오너(전권)
- **SELECT 초안**: `(account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.view')) or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.view'))`
- **INSERT/UPDATE 초안**: 동일한 own/other 구분, `.update` 권한으로
- **DELETE 초안**: `has_permission(center_id, 'facility.salary.other.update')`(별도 delete 권한 키가 카탈로그에 없어 update 권한으로 대체 — 후속에 `facility.salary.setting` 활용 검토)
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: own 권한만 있는 스태프가 타인 급여 조회 시도 → 차단, other 권한 보유자는 허용
- **우선순위**: Critical

### 16. staff_schedules
- **목적**: 수업이 아닌 스태프 개인 일정(휴가/미팅 등)
- **개인정보**: 중간(개인 일정 내용)
- **Tenant Scope**: `center_id` + `account_id`(일정 주인)
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 센터 소속 스태프 전체 조회(일정 조율 목적), 본인만 CUD(`schedule.own.etc.*`)
- **SELECT 초안**: `center_id in (select my_managed_center_ids())`
- **INSERT/UPDATE/DELETE 초안**: `account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.create'/'update'/'delete')`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: 타인이 남의 개인 일정 수정 시도 → 차단
- **우선순위**: Medium

### 17. terms
- **목적**: 센터별 약관(환불 규정 등, 가입/계약 시 동의)
- **개인정보**: 없음
- **Tenant Scope**: `center_id`
- **현재 사용여부**: 미사용(0건)
- **예상 접근 역할**: 전체 조회(가입 전에도 봐야 함 — anon 포함), 쓰기는 `contract.terms.manage`
- **SELECT 초안**: `true`
- **INSERT/UPDATE/DELETE 초안**: `has_permission(center_id, 'contract.terms.manage')`
- **기존 데이터 영향**: 없음
- **회귀 가능성**: 낮음
- **테스트 시나리오**: anon 조회 허용 확인, 권한 없는 스태프 쓰기 차단
- **우선순위**: Low

## RLS 테스트 계획 (설계만, 이번 배치에서 실행하지 않음)

`add_rls_gap_tables_draft_proposed.sql`이 실제 승인·실행되는 후속 배치에서 이 계획대로 통합 테스트를 작성한다.
이번 배치에서는 **실제 DB에 대한 테스트 실행은 하지 않는다.**

### 6개 역할

1. **anon** — 로그인하지 않은 요청(공개 REST 호출, anon key만 사용)
2. **member** — 일반 회원 계정(어느 센터의 스태프도 아님)
3. **staff (권한 없음)** — 센터 소속이지만 해당 권한 키가 역할/개인예외 어디에도 없는 스태프
4. **staff (권한 있음)** — 해당 permission key를 역할 또는 개인 allow로 보유한 스태프
5. **owner** — 그 센터의 `center_roles.is_owner = true` 스태프(전권)
6. **platform admin** — `accounts.is_platform_admin = true`

### 테이블 × 역할 접근 매트릭스 (요약, 2026-08-01 배치 파일 기준으로 갱신)

`R`=조회 가능, `RW`=조회+쓰기 가능, `own`=본인 관련 행만, `-`=차단. 정확한 조건은
위 "테이블별 상세" 및 `proposed_rls_gap_batch_*.sql`의 정책 참고. **"타 센터 owner/staff"
열은 17개 테이블 전부 `-`입니다** — 모든 정책이 `center_id`(또는 그 상위 FK)를 기준으로
`has_permission()`/`my_managed_center_ids()`를 평가하므로, 다른 센터 소속이라는 사실만으로는
어떤 테이블에도 접근할 수 없습니다(이 격리가 SEC-007/008의 핵심 요구사항).

| 테이블 | anon | member | staff(무권한) | staff(권한) | owner | platform admin | 타 센터 owner/staff |
|---|---|---|---|---|---|---|---|
| change_logs | - | - | - | R | R | R | - |
| class_types | R | R | R | RW | RW | RW | - |
| community_comments | - | R(본인 CUD) | R(본인 CUD) | R(본인 CUD) | R(본인 CUD) | R | - |
| competitions | R | R | R | R | R | RW | - |
| contract_templates | - | - | - | RW | RW | - | - |
| contracts | - | own(R) | - | RW(list.view) | RW | R | - |
| leads | - | - | - | RW(개별 권한별) | RW | - | - |
| lockers | R | R | R | RW | RW | RW | - |
| locker_assignments | - | own(R) | - | RW | RW | - | - |
| membership_transfers | - | own(R) | - | R(pass_detail) | R | - | - |
| messages | - | - | - | RW(channel별) | RW | - | - |
| notification_logs | - | - | - | R | R | R | - |
| popup_notices | R | R | R | RW(자기 센터만) | RW(자기 센터만) | RW(+전체공지) | - |
| schedule_memos | - | - | R / own(CUD) | RW | RW | - | - |
| staff_salaries | - | - | own(권한시) | RW(own/other 분리) | RW | - | - |
| staff_schedules | - | - | R / own(CUD, 권한시) | RW | RW | - | - |
| terms | R | R | R | R | RW | RW | - |

### Fixture 요구사항 (2026-08-01 갱신 — 새 Secret 불필요)

TEST-002에서 검증된 패턴(TEST_MANAGER_A/B 두 계정만으로 "오너"와 "비오너·무권한 스태프"
페르소나를 모두 만들어낸 것)을 그대로 확장합니다 — **17개 테이블 RLS 테스트에도 새 GitHub
Secrets가 필요하지 않습니다.**

- 센터 A(`TEST_MANAGER_A` 소유, 기존 fixture 재사용) / 센터 B(`TEST_MANAGER_B` 소유, 기존
  fixture 재사용) — 교차 센터 테스트에 그대로 사용(서로가 서로의 "타 센터 owner"가 됨).
- **"staff 무권한" 페르소나**: `TEST_MANAGER_B`를 센터 A에 권한 0개 역할로 초대(TEST-002와
  동일한 `getOrCreateNoPermRole`/`inviteIfNeeded` 헬퍼 재사용, 테스트 자신이 `afterAll`에서
  정리).
- **"staff 권한 있음" 페르소나**: 위와 같은 초대 상태에서, 검증하려는 테이블에 맞는
  구체적 permission key 하나만 `setStaffOverride(mcId, key, 'allow')`로 부여(예:
  `staff_salaries` 테스트 시 `facility.salary.other.view`) — 테이블마다 override를 새로
  걸고 그 테스트의 `afterAll`에서 제거. 새 역할/계정을 추가로 만들 필요가 없습니다.
- **member 페르소나**: 기존 `TEST_USER_A`(payment 통합 테스트가 이미 사용 중인 회원 계정)를
  재사용 — 어느 센터의 스태프도 아니라는 조건을 이미 만족합니다.
- **platform admin 페르소나**: 현재 이 역할의 재사용 가능한 test fixture 계정이 없습니다.
  `is_platform_admin` 플래그가 있는 전용 테스트 계정이 필요할 수 있는데, 이는 **기존
  TEST_MANAGER_A/B/USER_A로 대체할 수 없는 유일한 항목**입니다 — 새 Secret이 필요하다면
  이 한 가지(`TEST_PLATFORM_ADMIN_EMAIL/PASSWORD`)뿐이며, 실제로 필요한지는 platform admin
  분기가 있는 테이블(change_logs/contracts/notification_logs/popup_notices/terms 등)의
  테스트를 실제로 작성하는 시점에 다시 판단합니다(지금 임의로 만들지 않음).
- 각 17개 테이블에 최소 1행씩(센터 A 소속 1행 + 센터 B 소속 1행) — 특히 `contracts`/`staff_salaries`/`leads`는
  PII 필드까지 채운 realistic한 값으로(테스트가 실제로 유출 여부를 검증할 수 있도록). 이 행들도
  각 테스트 파일이 스스로 만들고 정리해야 합니다(TEST-002에서 배운 교훈 — fixture를 만들고
  정리하지 않으면 공유 개발 DB가 오염됩니다).
- `account_center_permissions`에 allow/deny 오버라이드 각 1건 이상(역할 권한을 뒤집는 케이스 검증용) — 위
  "staff 권한 있음" 페르소나 설정과 동일한 메커니즘.

### 테스트 시나리오 형식

각 테이블마다 최소 아래 4종을 통합 테스트로 작성한다:
1. 권한 없는 역할의 SELECT 시도 → 0건 반환(또는 42501 에러)
2. 권한 있는 역할의 SELECT 시도 → 자기 센터 행만 반환(타 센터 행 미포함)
3. 권한 없는 역할의 INSERT/UPDATE/DELETE 시도 → 실패
4. 권한 있는 역할의 INSERT/UPDATE/DELETE 시도 → 성공 + 타 센터 대상으로는 실패

**Batch A — 작성 완료(2026-08-02, 범위 일부 조정)**: `tests/integration/sec009-batch-a1-rls.test.ts`에
위 4종을 `staff_salaries`/`leads`/`messages` 3개 테이블에 작성함(`staff_salaries`는 own/other
권한 완전 분리라 own.view/other.view 조합 2건 추가, `messages`는 channel별 분리라 sms/push
조합 포함). `contracts`/`notification_logs`는 fixture를 안전하게 만들고 지울 방법이 현재 없어
(위 "정정 2" 참고 — service_role GRANT 누락 + 두 테이블 모두 의도적으로 일부 CRUD 정책이 없음)
이 파일에서 의도적으로 제외함(`docs/TODO.md` P2-13). Fixture 계정은 TEST_MANAGER_A(centerA
오너)/TEST_MANAGER_B(centerA에 권한 0개 스태프로 초대)/TEST_USER_A(무관 일반 회원)만 재사용 —
새 Secret 없음. **이 파일은 `proposed_rls_gap_batch_a.sql`이 실제로 적용되기 전에는 의도적으로
RED입니다**(현재 이 3개 테이블은 정책이 0건이라 오너를 포함해 아무도 접근 못 함 — 그래서
fixture 생성 자체가 막힘) — `tests/integration/acl-003-permission-read.test.ts`가 SQL 적용
전 red였던 것과 같은 취지지만, ACL-003과 달리 지금은 red 상태에서 assertion까지 도달하지 못하고
beforeAll(fixture 준비) 단계에서 막힌다(정책이 아예 0건이라 오너도 예외 없이 차단되기 때문 —
account_center_permissions는 이미 일부 정책이 있어 오너 fixture 준비 자체는 됐던 것과 다른 점).
Batch B/C/D는 아직 테스트를 작성하지 않음(다음 배치에서 순서대로 진행, 적용 전 이번과 동일한
방법으로 실제 RLS/GRANT 상태 재확인 필요).

## DB-001 (`chat_messages`) 결론

- **정의**: `sender_account_id`/`receiver_account_id`/`content` — 1:1 채팅 목적, 주석에 "하이파이브 참고 기능"
- **RLS**: 활성화되어 있으나 정책 0건 → 현재는 **완전 차단 상태**(anon/authenticated 누구도 접근 불가, 안전하지만 기능도 불가)
- **코드 사용**: app/lib 전체에서 참조 0건, 어떤 SQL 함수/트리거/뷰도 참조하지 않음
- **대체 여부**: 실제 1:1 문의 채팅 기능은 `inquiry_threads` + `inquiry_messages`로 완전히 대체되어 있음(RPC
  `open_inquiry_thread`/`send_inquiry_message`/`read_inquiry_thread` + 실시간 구독까지 구현 완료, `lib/inquiries.ts`).
  `messages`(대량 발송) 테이블과는 목적이 달라 그것과의 중복은 아님.
- **결론**: **정책 추가 후보가 아니라 삭제 후보**입니다. 다만 이번 배치는 "실제 DROP 금지" 원칙이므로 지금 삭제하지
  않습니다. `docs/TODO.md`에 "승인 후 `chat_messages` DROP 마이그레이션 작성" 항목으로 기록합니다.
