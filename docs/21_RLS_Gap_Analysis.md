# RLS Gap Analysis (SEC-007 / SEC-008)

> 이 문서는 **조사·설계 산출물**입니다. 여기 나오는 SQL은 전부 **초안(draft)**이며,
> 별도 승인 없이는 운영 Supabase에 절대 실행하지 마세요. 실제 적용은 `add_rls_gap_tables_draft_proposed.sql`
> 파일을 검토·승인받은 뒤 별도 Batch에서 진행합니다.

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

### 테이블 × 역할 접근 매트릭스 (요약)

`R`=조회 가능, `RW`=조회+쓰기 가능, `own`=본인 관련 행만, `-`=차단. 정확한 조건은 위 "테이블별 상세"의 정책초안 참고.

| 테이블 | anon | member | staff(무권한) | staff(권한) | owner | platform admin |
|---|---|---|---|---|---|---|
| change_logs | - | - | - | - | R | R |
| class_types | R | R | R | RW | RW | RW |
| community_comments | - | R(본인 CUD) | R(본인 CUD) | R(본인 CUD) | R(본인 CUD) | R |
| competitions | R | R | R | R | R | RW |
| contract_templates | - | - | - | RW | RW | - |
| contracts | - | own(R) | - | RW(list.view) | RW | R |
| leads | - | - | - | RW(개별 권한별) | RW | - |
| lockers | R | R | R | RW | RW | RW |
| locker_assignments | - | own(R) | R | RW | RW | - |
| membership_transfers | - | own(R) | - | R(pass_detail) | R | - |
| messages | - | - | - | RW(channel별) | RW | - |
| notification_logs | - | - | - | - | R | R |
| popup_notices | R | R | R(자기 센터 것만 RW) | RW | RW | RW(전체공지) |
| schedule_memos | - | - | R / own(CUD) | RW | RW | - |
| staff_salaries | - | - | own(권한시) | RW(own/other 분리) | RW | - |
| staff_schedules | - | - | R / own(CUD, 권한시) | RW | RW | - |
| terms | R | R | R | R | RW | RW |

### Fixture 요구사항

후속 배치의 통합 테스트(`tests/integration/`)가 필요로 할 최소 fixture 세트:

- 센터 2개(A, B) — 교차 테스트용(센터 A 스태프가 센터 B 데이터 접근 시도 → 차단 확인)
- 센터 A: 오너 계정 1, `facility.salary.other.view`만 가진 스태프 1, 아무 권한도 없는 스태프 1
- 센터 B: 오너 계정 1(센터 A 데이터 접근 시도용)
- 일반 회원 계정 1(어느 센터의 스태프도 아님, `profiles` 1개 이상 보유)
- 플랫폼 운영자 계정 1(`is_platform_admin = true`)
- 각 17개 테이블에 최소 1행씩(센터 A 소속 1행 + 센터 B 소속 1행) — 특히 `contracts`/`staff_salaries`/`leads`는
  PII 필드까지 채운 realistic한 값으로(테스트가 실제로 유출 여부를 검증할 수 있도록)
- `account_center_permissions`에 allow/deny 오버라이드 각 1건 이상(역할 권한을 뒤집는 케이스 검증용)

### 테스트 시나리오 형식 (후속 배치에서 작성)

각 테이블마다 최소 아래 4종을 통합 테스트로 작성한다:
1. 권한 없는 역할의 SELECT 시도 → 0건 반환(또는 42501 에러)
2. 권한 있는 역할의 SELECT 시도 → 자기 센터 행만 반환(타 센터 행 미포함)
3. 권한 없는 역할의 INSERT/UPDATE/DELETE 시도 → 실패
4. 권한 있는 역할의 INSERT/UPDATE/DELETE 시도 → 성공 + 타 센터 대상으로는 실패

## DB-001 (`chat_messages`) 결론

- **정의**: `sender_account_id`/`receiver_account_id`/`content` — 1:1 채팅 목적, 주석에 "하이파이브 참고 기능"
- **RLS**: 활성화되어 있으나 정책 0건 → 현재는 **완전 차단 상태**(anon/authenticated 누구도 접근 불가, 안전하지만 기능도 불가)
- **코드 사용**: app/lib 전체에서 참조 0건, 어떤 SQL 함수/트리거/뷰도 참조하지 않음
- **대체 여부**: 실제 1:1 문의 채팅 기능은 `inquiry_threads` + `inquiry_messages`로 완전히 대체되어 있음(RPC
  `open_inquiry_thread`/`send_inquiry_message`/`read_inquiry_thread` + 실시간 구독까지 구현 완료, `lib/inquiries.ts`).
  `messages`(대량 발송) 테이블과는 목적이 달라 그것과의 중복은 아님.
- **결론**: **정책 추가 후보가 아니라 삭제 후보**입니다. 다만 이번 배치는 "실제 DROP 금지" 원칙이므로 지금 삭제하지
  않습니다. `docs/TODO.md`에 "승인 후 `chat_messages` DROP 마이그레이션 작성" 항목으로 기록합니다.
