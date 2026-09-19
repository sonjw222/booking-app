# 19. GitHub Projects 개발 백로그 설계

> **상태: 백로그 내용 승인됨(2026-07-31) — 사용자 의사결정 8건 반영 완료. GitHub 실제 생성은 `gh` CLI 인증 문제로 아직 실행되지 못했습니다(상세는 대화 보고 참고).** 인증 완료 후 F번 계획대로 즉시 생성 가능한 상태입니다.

- 대상 저장소: `sonjw222/booking-app`
- 대상 Project: [Booking App Development (#1)](https://github.com/users/sonjw222/projects/1)
- 분석 기준일: 2026-07-31 / 의사결정 반영일: 2026-07-31
- 분석 방법: 저장소 코드(`app/`, `lib/`, 루트 SQL 65개 파일)와 `docs/*.md` 정적 분석. 운영 Supabase를 직접 조회하지 않았습니다 — "검증 필요"로 표시된 항목은 운영 DB 확인이 필요합니다.

> **참고**: 요청에 언급된 `docs/00_Project_Principles.md` ~ `docs/17_*.md` 번호 문서는 저장소에 존재하지 않습니다. 실제로는 `docs/PROJECT_OVERVIEW.md`, `REQUIREMENTS.md`, `ROUTES.md`, `DATABASE.md`, `DEVELOPMENT_RULES.md`, `AI_PLAYBOOK.md`, `WORKFLOW.md`, `CHANGELOG.md`, `TODO.md`(모두 번호 없음) + `18_ERD.md`(직전 작업에서 신규 생성)만 존재합니다. 아래 분석은 이 실제 파일들과 `app/`/`lib/`/SQL 코드를 기준으로 했습니다. 또한 `components/`, `services/`, `types/` 디렉터리는 저장소에 존재하지 않습니다(코드는 `app/`과 `lib/`에만 있음) — 요청에 언급된 참고 디렉터리 목록과 실제 구조가 다름을 확인했습니다.

## 반영된 의사결정 (2026-07-31)

1. RLS 미적용 17개 테이블 정비 — Critical 최우선 유지, 단 영향분석→정책설계→회귀테스트→단계적적용→QA/운영검증 5단계 Task로 분해(`E11-F1-T1~T5`).
2. 포인트 원장 3종 — 지금 통합하지 않음. 역할/데이터흐름/중복/참조코드/RPC 분석 Task까지만 생성, 통합 여부는 별도 Decision(`E04-F3-T1`).
3. Community 게시판/대회 정보 — 보류 유지, Priority Low, Sprint 비움(`E10-F2`).
4. 담당회원 배정 — 별도 조인 테이블 방식을 우선안으로 기록. 영향 분석 Task(`E03-F2-T1`) 선행, 신규 테이블 생성 Task(`E03-F2-T2`)는 Status=Blocked(별도 승인 필요).
5. 실PG 결제 — 지금 구현 안 함. 인터페이스 정리/Mock-Production 분리/Toss 웹훅 설계/결제 상태 모델 검토/연동 준비 체크리스트 Task 생성(`E06-F1-T1~T5`). 실제 Toss 연동 Task(`E06-F1-T6`)는 Status=Blocked.
6. 마이그레이션 — 수동 SQL 방식 유지, Prisma/Drizzle 도입 안 함. SQL 적용순서/migration history/운영 체크리스트/rollback 기준/중복 RPC 최종본 확정 Task 생성(`E11-F2-T1~T5`).
7. 레거시 테이블 5종 — 삭제하지 않음. 사용처/FK/RPC/RLS 영향 조사 및 삭제 후보 확정 Task까지만 생성, 실제 DROP은 각 Task 본문에 별도 승인 필요로 명시(`E04-F3-T2`, `E10-F1-T1`, `E10-F1-T2`, `E11-F3-T1`).
8. 모든 Issue Sprint 필드는 비움, Status는 Blocked로 명시된 2건(`E03-F2-T2`, `E06-F1-T6`)을 제외하고 전부 Backlog.

## A. 저장소 현황 요약

### 현재 구현된 주요 기능
- 이메일 회원가입/로그인, 매니저 가입 시 pending 센터 자동 생성
- 예약 캘린더, 예약/취소/대기, 대기 자동 승격, 회원권 기반 예약 제한(요일/시간/수업명)
- 관리자 직접배치·무료배치·되돌리기·활동기록 화면(가장 최근 Epic에서 완료)
- 매니저 대시보드 요약 통계(오늘/7일/30일, RPC 단일 집계)
- 회원권 발급/일시정지/조건부 환불, 프로필 간 공유 이용
- 굿즈/수강권 장바구니·주문, 매니저 수기결제, 테스트(Mock) 결제 전 구간
- 회원 목록/등급/상태/메모/CSV 내보내기
- 직원 역할/권한 카탈로그 + 계정별 오버라이드(서버 강제)
- 실시간 알림 인박스, 리뷰(포인트 적립), 공지, 1:1 문의 채팅
- 플랫폼 관리자 허브(센터 승인/거절/복원, 카테고리, 배너)

### 부분 구현 기능
- **실제 PG 결제**: Mock 결제만 전 구간 동작, Toss/PortOne은 인터페이스만 있고 전 메서드가 에러를 던지는 스텁 (사업자 등록 대기)
- **권한 기반 UI**: 서버(`has_permission`)는 강제되지만 화면은 권한과 무관하게 모든 메뉴/버튼 노출
- **알림**: 실시간 인박스는 동작하지만 정기 스케줄(예약 임박/수강권 만료)과 외부 푸시/알림톡 발송 미연결
- **매니저 회원 화면의 담당회원/상담고객 탭**: UI는 있으나 "준비 중" 텍스트만 렌더링

### 미구현 기능
- 네이버 소셜 로그인, 수강권 양도, 커뮤니티 게시판/대회 정보
- 미발급 주문 셀프 취소, 센터별 환불 정책 설정
- 예약 캘린더 공휴일 자동 반영(현재 단일 날짜 하드코딩)
- 관리자 활동기록 CSV 내보내기

### 주요 기술 부채
- `: any` / `as any` 361건, 54개 파일 이상에 분산(이전 감사 대비 증가 추세) — `DEVELOPMENT_RULES.md`의 any 금지 규칙과 배치
- 핵심 RPC 22개(`reserve_class`, `fulfill_order`, `cancel_reservation` 등)가 여러 SQL 파일에서 반복 재정의 — 운영 DB의 실제 최종본이 저장소만으로 확인 불가 (`reservation_functions.sql`이 통합본으로 추정되나 미확인)
- `point_transactions`/`point_accounts`/`point_logs` 포인트 원장 이원화, 정합성 미검증
- `npm run lint` 즉시 실패(`eslint.config.js` 부재), Tailwind 유틸리티가 `globals.css`에 import되지 않아 죽은 코드일 가능성
- 파괴적 스크립트 3개(`reset_test_data.sql`, `reset_class_products.sql`, 및 신규 발견 `add_membership_rules.sql`의 전체삭제 구문) 중 1개는 문서화되지 않음
- 5개 레거시/불명확 테이블(`product_passes`, `point_logs`, `change_logs`, `chat_messages`, `reviews`) + 23개 미사용 추정 테이블

### 보안 및 데이터 위험
- **Critical**: 65개 테이블 중 **17개 테이블에 RLS 활성화 구문이 전혀 없음**(`class_types`, `lockers`, `locker_assignments`, `membership_transfers`, `popup_notices`, `competitions`, `community_comments`, `leads`, `change_logs`, `staff_salaries`, `staff_schedules`, `schedule_memos`, `contract_templates`, `terms`, `contracts`, `messages`, `notification_logs`) — RLS가 유일한 서버 접근 통제 계층인 이 프로젝트 구조상 실제 데이터 노출 위험
- `chat_messages`는 RLS는 켜져 있으나 정책이 하나도 없어 사실상 완전히 잠김(의도된 것인지 버그인지 미확인)
- 플랫폼 관리자 화면 2개(`/admin/categories`, `/admin/banners`), 매니저 화면 3개(`/manager/inquiries`, `/manager/notifications`, `/manager/staff/permissions`)에 클라이언트 사전 가드 누락 — 쓰기는 RLS로 보호되지만 화면/폼이 비인가 사용자에게 노출됨
- RLS 회귀를 자동 검증하는 테스트가 전혀 없음(반복된 RLS 긴급수정 이력 존재)

### 문서와 코드의 불일치
- `docs/REQUIREMENTS.md`는 사업자등록증 업로드를 "구현 완료"로 기재하나, `app/login/page.tsx:155`의 코드 주석은 실제 Storage 연결이 안 되어 있을 가능성을 시사 — 검증 필요
- `docs/TODO.md` 자체에도 내부 불일치 존재: P1-11, P1-13 항목이 "P1" 제목 아래 있지만 우선순위 필드는 "P2"로 기재됨(원본 그대로 인용)
- `docs/18_ERD.md`는 저장소 SQL 정적 분석 결과이며 운영 Supabase 실제 상태와 다를 수 있음 — 이 백로그의 DB 관련 Task 중 다수가 "검증 필요"로 표시된 이유

## B. Epic별 백로그

### E01. Authentication

- **Epic 목표**: 회원/매니저 계정의 가입·로그인·역할전환이 안전하고 신뢰 가능하게 동작한다.
- **완료 조건**: 이메일/소셜 로그인 전 구현, 전역 인증 가드 존재, 플랫폼 관리자 권한이 가입 흐름으로 획득 불가함이 검증됨.
- **현재 구현 상태**: 이메일 로그인/가입 구현 완료. Kakao/Apple UI+호출 존재(운영 설정 필요). Naver 미구현. 전역 인증 가드(middleware) 부재.
- **우선순위**: High

#### E01-F1. 이메일 회원가입 및 로그인 — *구현 완료* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 이메일/비밀번호로 신규 계정을 생성하고 즉시 로그인할 수 있다.
- 중복 이메일 가입 시 명확한 오류 메시지가 표시된다.
- 매니저로 가입하면 status='pending' 센터가 자동 생성된다.

**Task 목록**
- `E01-F1-T1` [Bug] 사업자등록증 업로드가 실제 Storage 저장 경로를 사용하는지 검증 — 검증 필요 (Priority: High, Module: Frontend)
- `E01-F1-T2` [Refactor] 전역 인증 가드(미들웨어) 도입 — 미구현 (Priority: High, Module: Frontend)

#### E01-F2. 소셜 로그인 방식 연결 및 해제 — *부분 구현* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- Kakao/Apple 버튼 클릭 시 정상적으로 OAuth 플로우가 완료되고 계정이 생성/연결된다.
- Naver 버튼은 실제 로그인이 되거나, 최소한 '준비 중' 안내가 아닌 완전한 기능으로 대체된다.

**Task 목록**
- `E01-F2-T1` [Task] Kakao/Apple OAuth 운영 환경 설정 확인 및 문서화 — 운영 설정 필요 (Priority: Medium, Module: DevOps)
- `E01-F2-T2` [Task] 네이버 소셜 로그인 연동 — 미구현 (Priority: Low, Module: Frontend)

### E02. Organization & Multi Center

- **Epic 목표**: 센터(스튜디오/체육관)의 등록, 승인, 운영 정보 관리, 다중 센터 소속·전환이 안전하게 동작한다.
- **완료 조건**: 플랫폼 관리자 승인 플로우가 전 구간 RLS/가드로 보호되고, 미승인 센터가 공개 노출되지 않음이 검증됨.
- **현재 구현 상태**: 센터 CRUD/승인/거절/복원, 서비스 카테고리, 홈 배너 관리 구현 완료. 일부 플랫폼 관리자 화면에 클라이언트 가드 누락.
- **우선순위**: High

#### E02-F1. 센터 등록 및 플랫폼 승인 처리 — *구현 완료* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 매니저가 가입하면 status='pending' 센터가 생성된다.
- 플랫폼 관리자가 승인/거절/복원 처리를 할 수 있다.
- 미승인 센터는 공개 목록/검색에 노출되지 않는다.

**Task 목록**
- `E02-F1-T1` [Bug] /admin/categories, /admin/banners에 플랫폼 관리자 클라이언트 가드 추가 — 부분 구현 (Priority: High, Module: Frontend)

#### E02-F2. 센터 운영 정보 관리(소개/사진/연락처/위치) — *구현 완료* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- 매니저가 센터 소개/사진/연락처/SNS/좌표를 수정하면 공개 센터 상세 화면에 즉시 반영된다.

**Task 목록**
- `E02-F2-T1` [Task] center_contacts, schedule_templates 실사용 여부 확인 — 검증 필요 (Priority: Low, Module: Backend)

### E03. Member

- **Epic 목표**: 센터 관리자가 회원 정보를 조회·분류·관리하고, 담당 회원/상담 흐름까지 지원한다.
- **완료 조건**: 회원 목록/등급/상태/메모/CSV 내보내기가 완비되고, 담당회원/상담고객 탭이 실제 기능으로 동작한다.
- **현재 구현 상태**: 회원 목록/검색/등급/상태/메모/CSV 내보내기 구현 완료. 담당회원/상담고객 탭은 UI만 있고 '준비 중' 문구만 표시(미구현).
- **우선순위**: Medium

#### E03-F1. 회원 목록 관리 및 CSV 내보내기 — *구현 완료* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- 이름/전화번호/주소로 회원을 검색할 수 있다.
- 등급을 부여하고 상태(활성/만료/휴면)를 확인할 수 있다.
- CSV로 회원 목록을 내보낼 수 있다.

**Task 목록**: 없음(이미 구현 완료된 기능, 추가 작업 불필요)

#### E03-F2. 담당회원 및 상담고객(리드) 관리 — *미구현* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- 담당 회원 탭에서 실제 담당 관계를 배정/조회할 수 있다.
- 상담고객 탭에서 leads 테이블 기반 CRUD가 동작한다.

**Task 목록**
- `E03-F2-T1` [Task] 담당회원 배정 코드/DB 영향 분석 — 미구현 (Priority: Medium, Module: Backend)
- `E03-F2-T2` [Task] 담당 관계 조인 테이블 생성 및 배정 UI 구현 — 미구현 (Priority: Medium, Module: Backend)
- `E03-F2-T3` [Task] 상담고객(leads) CRUD 화면 구현 — 미구현 (Priority: Medium, Module: Frontend)

### E04. Membership

- **Epic 목표**: 회원권(수강권)의 발급·정지·재개·공유·양도가 정확하고 데이터 정합성 있게 동작한다.
- **완료 조건**: 포인트 원장이 단일화되고, 수강권 관련 핵심 테이블에 FK 인덱스가 있으며, 레거시 테이블 상태가 문서화된다.
- **현재 구현 상태**: 발급/정지/재개/조건부 환불/공유 이용 구현 완료. 수강권 양도, product_passes 레거시 여부, 포인트 이원화는 검증/미구현.
- **우선순위**: High

#### E04-F1. 수강권 발급 및 일시정지/재개 — *구현 완료* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 수강권 발급 시 이용기간/횟수가 정확히 설정된다.
- 정지 시 조건에 따라 환불이 계산된다.
- 재개 시 남은 기간/횟수가 정확히 복원된다.

**Task 목록**: 없음(이미 구현 완료된 기능, 추가 작업 불필요)

#### E04-F2. 수강권 양도 — *미구현* (Priority: Low, Module: Backend)

**Acceptance Criteria**
- 회원 A의 수강권을 회원 B에게 양도하면 잔여 횟수/기간이 그대로 이전된다.
- 양도 이력이 membership_transfers에 기록된다.

**Task 목록**
- `E04-F2-T1` [Task] membership_transfers 기반 수강권 양도 플로우 구현 — 미구현 (Priority: Low, Module: Backend)

#### E04-F3. 포인트 원장 정합성 정리 — *검증 필요* (Priority: High, Module: Database)

**Acceptance Criteria**
- point_transactions/point_accounts/point_logs 중 단일 소스가 정의되고, 나머지는 문서에 역할이 명시되거나 제거된다.

**Task 목록**
- `E04-F3-T1` [Task] point_transactions / point_accounts / point_logs 역할·데이터흐름·중복·참조코드·RPC 분석 — 검증 필요 (Priority: High, Module: Database)
- `E04-F3-T2` [Task] product_passes 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정 — 검증 필요 (Priority: Low, Module: Database)

### E05. Reservation & Class

- **Epic 목표**: 예약/수업 관리, 관리자 직접배치·무료배치가 정확하고 성능 좋게, 감사 가능하게 동작한다.
- **완료 조건**: 핵심 예약 테이블 FK 인덱스가 정비되고, 공휴일이 하드코딩 없이 동작하며, 관리자 배치 용량초과 플로우가 자동 테스트로 검증된다.
- **현재 구현 상태**: 예약/취소/대기·관리자 직접배치/무료배치/되돌리기/활동기록 화면 구현 완료(최근 Epic 완료). 공휴일 하드코딩, 수업유형/복수강사, FK 인덱스는 미구현/검증 필요.
- **우선순위**: High

#### E05-F1. 예약 생성과 중복 예약 방지 — *구현 완료* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 동일 회원이 동일 수업에 중복 예약할 수 없다(unique_active_reservation).
- 정원 초과 시 대기로 등록되고, 취소 시 1순위가 자동 승격된다.

**Task 목록**: 없음(이미 구현 완료된 기능, 추가 작업 불필요)

#### E05-F2. 관리자 직접배치 및 무료 추가 배치 — *구현 완료* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 관리자가 회원권 없이도 무료 배치를 생성할 수 있다.
- 직접배치/무료배치/취소가 admin_action_logs에 기록된다.
- 용량초과 배치 시 확인 단계를 거친다.

**Task 목록**
- `E05-F2-T1` [Task] 용량초과(capacity-override) 2단계 확인 플로우 통합테스트 추가 — 부분 구현 (Priority: Medium, Module: Backend)

#### E05-F3. 예약 화면 공휴일 자동 반영 — *미구현* (Priority: Low, Module: Backend)

**Acceptance Criteria**
- 공휴일 목록이 하드코딩된 단일 날짜가 아니라 매년 자동으로 갱신되거나 테이블 기반으로 조회된다.

**Task 목록**
- `E05-F3-T1` [Bug] 예약 캘린더 공휴일을 하드코딩 대신 테이블/API 기반으로 전환 — 미구현 (Priority: Low, Module: Frontend)

#### E05-F4. 수업 유형 분류 및 복수 강사 배정 — *검증 필요* (Priority: Low, Module: Frontend)

**Acceptance Criteria**
- 수업에 유형(class_types)을 지정할 수 있다.
- 한 수업에 여러 강사를 배정할 수 있다.

**Task 목록**
- `E05-F4-T1` [Task] class_types / class_trainers 실사용 여부 확인 및 UI 연동 — 검증 필요 (Priority: Low, Module: Frontend)

### E06. Product & Payment

- **Epic 목표**: 상품(수강권/굿즈) 판매와 실제 PG 결제가 안전하고 중복 없이 처리된다.
- **완료 조건**: 실PG(Toss 또는 PortOne) 결제가 실 사업자 등록 후 연동 완료되고, 주문 취소/환불 정책이 설정 가능하며, fulfill_order 중복 발급 방지가 테스트로 검증된다.
- **현재 구현 상태**: 장바구니/주문/굿즈 판매/매니저 수기결제 구현 완료. 실PG는 Mock만 동작(Toss/PortOne은 스텁), 미발급 주문 취소·환불정책 설정은 미구현.
- **우선순위**: Critical

#### E06-F1. 실제 PG 결제 연동 준비 — *부분 구현 (테스트 결제 환경만 완료)* (Priority: Critical, Module: Backend)

**Acceptance Criteria**
- Payment Provider 인터페이스, 웹훅 설계, 결제 상태 모델, 연동 준비 체크리스트가 모두 문서로 정리된다.
- 실제 Toss/PortOne 연동 구현 자체는 별도 승인 없이는 착수되지 않는다(Blocked).

**Task 목록**
- `E06-F1-T1` [Task] Payment Provider 인터페이스 정리 — 검증 필요 (Priority: High, Module: Backend)
- `E06-F1-T2` [Refactor] Mock Provider와 Production Provider 분리 — 리팩터링 필요 (Priority: Medium, Module: Backend)
- `E06-F1-T3` [Task] Toss 웹훅 설계 — 미구현 (Priority: High, Module: Backend)
- `E06-F1-T4` [Task] 결제 성공/실패/취소/환불 상태 모델 검토 — 검증 필요 (Priority: Medium, Module: Backend)
- `E06-F1-T5` [Docs] 실 PG 연동 준비 체크리스트 작성 — 미구현 (Priority: Medium, Module: Documentation)
- `E06-F1-T6` [Task] TossPaymentProvider 실제 연동 구현 — 미구현 (Priority: Critical, Module: Backend)
- `E06-F1-T7` [Refactor] fulfill_order()와 confirm_test_payment() 중복 로직 통합 설계 — 리팩터링 필요 (Priority: Medium, Module: Backend)

#### E06-F2. 주문 취소 및 환불 정책 설정 — *미구현* (Priority: Medium, Module: Backend)

**Acceptance Criteria**
- 회원이 미발급 주문을 앱 내에서 직접 취소할 수 있다.
- 환불 가능 기간/조건을 매니저가 센터별로 설정할 수 있다.

**Task 목록**
- `E06-F2-T1` [Task] 미발급 주문 회원 셀프 취소 기능 — 미구현 (Priority: Medium, Module: Backend)
- `E06-F2-T2` [Task] 센터별 환불 정책(기간/조건) 설정 기능 — 미구현 (Priority: Low, Module: Backend)

### E07. Staff & Permission

- **Epic 목표**: 센터 내 직원 역할과 세부 권한이 서버에서 강제되고, 화면도 그 권한을 정확히 반영한다.
- **완료 조건**: 권한이 없는 기능은 화면에서도 노출되지 않고, 모든 매니저 화면에 소속 센터 가드가 존재함이 검증된다.
- **현재 구현 상태**: 역할/권한 카탈로그, 계정별 오버라이드, 서버 강제(has_permission) 구현 완료. 세부 권한 기반 UI 표시 제어 및 일부 화면 가드 누락은 미구현.
- **우선순위**: High

#### E07-F1. 센터별 직원 권한 관리 — *구현 완료* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 오너가 역할별 권한을 설정할 수 있다.
- 계정별로 개별 허용/차단 오버라이드를 적용할 수 있다.
- 서버(RPC/RLS)가 권한 없는 요청을 거부한다.

**Task 목록**
- `E07-F1-T1` [Bug] /manager/staff/permissions에 오너 전용 클라이언트 가드 추가 — 부분 구현 (Priority: High, Module: Frontend)

#### E07-F2. 세부 권한 기반 UI 표시 제어 — *미구현* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- 권한이 없는 메뉴/버튼이 화면에서 아예 숨겨지거나 비활성화된다(현재는 서버만 차단하고 화면은 그대로 노출).

**Task 목록**
- `E07-F2-T1` [Task] 매니저 화면 전반에 effectiveState() 기반 메뉴/버튼 노출 제어 적용 — 미구현 (Priority: Medium, Module: Frontend)

#### E07-F3. 직원 급여 및 근무 스케줄 관리 — *검증 필요* (Priority: Low, Module: Frontend)

**Acceptance Criteria**
- 직원 근무 스케줄을 등록/조회할 수 있다.
- 급여 정보를 기록할 수 있다.

**Task 목록**
- `E07-F3-T1` [Task] staff_salaries / staff_schedules / schedule_memos 실사용 여부 확인 — 검증 필요 (Priority: Low, Module: Backend)

### E08. Notification

- **Epic 목표**: 회원/매니저가 예약·공지·수강권 만료 등 중요한 이벤트를 놓치지 않고 신뢰성 있게 안내받는다.
- **완료 조건**: 정기 알림(예약 임박/수강권 만료)이 스케줄러로 실제 발송되고, 알림 규칙 기반 발송 로그가 남는다.
- **현재 구현 상태**: 실시간 팝업+인박스, 관리자 배치/취소 알림(정보 최소화 원칙 적용) 구현 완료. 정기 알림 스케줄러 미설정, 외부 푸시/알림톡 발송 미구현.
- **우선순위**: High

#### E08-F1. 실시간 알림 인박스 — *구현 완료* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- 새 알림 발생 시 실시간 팝업으로 즉시 표시된다.
- 알림 목록에서 읽음 처리와 미읽음 개수 확인이 가능하다.

**Task 목록**
- `E08-F1-T1` [Bug] /manager/inquiries, /manager/notifications에 fetchMyCenters() 가드 추가 — 부분 구현 (Priority: High, Module: Frontend)

#### E08-F2. 정기 알림 스케줄링(예약 임박, 수강권 만료) — *미구현* (Priority: High, Module: Backend)

**Acceptance Criteria**
- 예약 임박 알림이 실제로 정해진 주기마다 발송된다.
- 수강권 만료 임박 알림이 실제로 발송된다.

**Task 목록**
- `E08-F2-T1` [Task] notify_upcoming_reservations()/notify_expiring_passes() 스케줄러 연결 — 미구현 (Priority: High, Module: DevOps)

#### E08-F3. 외부 푸시/알림톡 발송 연동 — *미구현* (Priority: Medium, Module: Backend)

**Acceptance Criteria**
- 알림 설정에서 켠 항목에 대해 실제 FCM 푸시 또는 알림톡이 발송된다.

**Task 목록**
- `E08-F3-T1` [Task] 알림 설정과 실제 발송 채널(FCM/알림톡) 연결 — 미구현 (Priority: Medium, Module: Backend)

### E09. Dashboard & Reports

- **Epic 목표**: 매니저/오너가 센터 운영 현황(예약/회원/매출/활동)을 실시간·집계 형태로 한눈에 파악한다.
- **완료 조건**: 핵심 통계가 RPC 집계로 표시되고, revenue_summary 뷰 등 미사용 자원이 정리되며, 엑셀 내보내기가 구현된다.
- **현재 구현 상태**: 매니저 대시보드 요약 카드(오늘/7일/30일), 최근 활동/알림 구현 완료(최근 Epic). revenue_summary 뷰 사용 여부, admin-assignments 화면 엑셀 내보내기는 검증필요/미구현.
- **우선순위**: Medium

#### E09-F1. 매니저 대시보드 요약 통계 — *구현 완료* (Priority: Medium, Module: Backend)

**Acceptance Criteria**
- 오늘/7일/30일 기간을 선택하면 수업/예약/취소/회원/수강권 통계가 RPC 단일 호출로 표시된다.
- 매출 카드는 PG 미연동 상태에서 '준비중'으로만 표시되고 가짜 데이터가 없다.

**Task 목록**
- `E09-F1-T1` [Task] revenue_summary 뷰 실사용 여부 확인 — 검증 필요 (Priority: Low, Module: Database)

#### E09-F2. 관리자 활동기록 엑셀 내보내기 — *미구현* (Priority: Low, Module: Frontend)

**Acceptance Criteria**
- 활동기록 화면에서 현재 필터 조건에 맞는 목록을 엑셀(CSV)로 내보낼 수 있다.

**Task 목록**
- `E09-F2-T1` [Task] admin-assignments 화면에 CSV 내보내기 추가 — 미구현 (Priority: Low, Module: Frontend)

### E10. Community

- **Epic 목표**: 리뷰/공지 외에 커뮤니티 게시판, 대회 정보 등 부가 소통 기능이 필요 시 제공된다.
- **완료 조건**: 레거시 reviews/chat_messages 테이블 상태가 확정되고, 커뮤니티 기능 착수 여부가 제품 결정으로 문서화된다.
- **현재 구현 상태**: 센터 리뷰(사진+평점, 포인트 적립), 공지 구현 완료. 커뮤니티 게시판/대회 정보 미구현. 레거시 reviews/chat_messages 정리 필요.
- **우선순위**: Low

#### E10-F1. 레거시 테이블 정리(reviews, chat_messages) — *검증 필요* (Priority: Medium, Module: Database)

**Acceptance Criteria**
- reviews와 center_reviews 중 어느 쪽이 현재 사용 중인지 결론이 나고 문서화된다.
- chat_messages와 inquiry_messages의 관계가 결론 나고 문서화된다.

**Task 목록**
- `E10-F1-T1` [Task] reviews 테이블 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정 — 검증 필요 (Priority: Medium, Module: Database)
- `E10-F1-T2` [Bug] chat_messages 사용처·FK·RLS 영향 조사 및 삭제 후보 확정 — 검증 필요 (Priority: Medium, Module: Database)

#### E10-F2. 커뮤니티 게시판 및 대회 정보 — *미구현* (Priority: Low, Module: Frontend)

**Acceptance Criteria**
- 회원이 커뮤니티 게시글을 작성/조회/댓글 작성할 수 있다.
- 대회 정보를 등록/조회할 수 있다.

**Task 목록**
- `E10-F2-T1` [Task] 커뮤니티 게시판 MVP 구현 — 미구현 (Priority: Low, Module: Frontend)

### E11. System

- **Epic 목표**: 플랫폼 전체의 보안 경계(RLS/권한)와 코드 품질 기준이 일관되게 지켜지고, 회귀를 자동으로 잡아낸다.
- **완료 조건**: 모든 테이블에 RLS가 명시적으로 활성화·정책화되고, 핵심 RPC의 운영 최종본이 확인되며, 자동 RLS 회귀 테스트가 CI에 존재한다.
- **현재 구현 상태**: 플랫폼 관리자 허브/승인 구현 완료. RLS 미적용 테이블 17개, RPC 다중 정의 22개, lint 설정 부재, any 사용 361건 등 다수의 시스템 리스크 존재.
- **우선순위**: Critical

#### E11-F1. RLS 전면 적용 및 회귀 테스트 — *미구현* (Priority: Critical, Module: Database)

**Acceptance Criteria**
- 65개 테이블 전부에 RLS가 명시적으로 활성화되어 있다.
- RLS가 활성화된 테이블은 최소 SELECT 정책이 존재하거나, 의도적으로 RPC 전용 접근임이 문서화된다.
- 역할별(회원/매니저/타센터매니저/관리자) 접근 시나리오를 검증하는 자동 테스트가 CI에서 실행된다.
- 정책 변경이 단계적으로 적용되고 각 단계마다 QA/운영 DB 검증을 거친다.

**Task 목록**
- `E11-F1-T1` [Task] [1/5] RLS 미적용 17개 테이블 영향 분석 — 미구현 (Priority: Critical, Module: Database)
- `E11-F1-T2` [Task] [2/5] 테이블별 역할 기반 RLS 정책 설계 — 미구현 (Priority: Critical, Module: Database)
- `E11-F1-T3` [Task] [3/5] RLS 역할별 회귀 테스트 스위트 구축 — 미구현 (Priority: Critical, Module: Backend)
- `E11-F1-T4` [Task] [4/5] RLS 정책 단계적 적용 — 미구현 (Priority: Critical, Module: Database)
- `E11-F1-T5` [Task] [5/5] RLS 적용 QA 및 운영 DB 검증 — 미구현 (Priority: Critical, Module: Database)

#### E11-F2. 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리 — *검증 필요* (Priority: High, Module: Database)

**Acceptance Criteria**
- reserve_class 등 다중 파일에서 재정의된 핵심 RPC 22개의 운영 DB상 실제 최종 정의가 확정된다.
- SQL 파일 적용 순서·이력·운영 체크리스트·rollback 기준이 문서로 정리된다.
- 수동 SQL 마이그레이션 방식을 당분간 유지하기로 확정하고, 도구(Prisma/Drizzle 등) 도입은 하지 않는다.

**Task 목록**
- `E11-F2-T1` [Docs] SQL 파일 적용 순서 정리 — 미구현 (Priority: High, Module: Documentation)
- `E11-F2-T2` [Docs] Migration history 정리(운영 적용 이력 ledger) — 미구현 (Priority: High, Module: Documentation)
- `E11-F2-T3` [Docs] 운영 적용 체크리스트 작성 — 미구현 (Priority: Medium, Module: Documentation)
- `E11-F2-T4` [Docs] Migration rollback 기준 정리 — 미구현 (Priority: Medium, Module: Documentation)
- `E11-F2-T5` [Task] 중복 정의 핵심 RPC 22개 운영 최종본 확정 — 검증 필요 (Priority: High, Module: Database)

#### E11-F3. 레거시 테이블 5종 삭제 후보 최종 확정 — *검증 필요* (Priority: Medium, Module: Database)

**Acceptance Criteria**
- product_passes/point_logs/change_logs/chat_messages/reviews 5개 테이블 각각의 사용처/FK/RPC/RLS 영향과 삭제 후보 여부가 결론 나고 docs/DATABASE.md에 반영된다.
- 실제 DROP은 이 Feature 범위에 포함되지 않고 별도 승인·별도 Task로 남겨진다.

**Task 목록**
- `E11-F3-T1` [Task] change_logs 사용처·FK·RLS 영향 조사 및 5종 레거시 테이블 최종 확정 — 검증 필요 (Priority: Medium, Module: Database)

#### E11-F4. 타입 안전성 확보 (any 사용 축소) — *리팩터링 필요* (Priority: Medium, Module: Frontend)

**Acceptance Criteria**
- Supabase 타입 생성 도구가 도입되어 신규 코드는 any 없이 작성 가능하다.
- 가장 사용량이 많은 상위 5개 파일의 any 사용이 제거된다.

**Task 목록**
- `E11-F4-T1` [Refactor] Supabase 타입 자동 생성 도입 — 미구현 (Priority: Medium, Module: DevOps)
- `E11-F4-T2` [Refactor] any 사용 최다 파일(lib/members.ts, lib/orders.ts, lib/classes.ts) 타입 개선 — 리팩터링 필요 (Priority: Low, Module: Frontend)

#### E11-F5. 개발 환경/도구 정비 — *미구현* (Priority: Medium, Module: DevOps)

**Acceptance Criteria**
- npm run lint이 정상 동작한다.
- Tailwind 유틸리티 클래스가 실제로 빌드에 반영된다.
- .env.local.example이 존재한다.

**Task 목록**
- `E11-F5-T1` [Task] eslint.config.js 신설 — 미구현 (Priority: Medium, Module: DevOps)
- `E11-F5-T2` [Bug] Tailwind CSS 실제 적용 확인 및 연결 — 검증 필요 (Priority: Medium, Module: Frontend)
- `E11-F5-T3` [Docs] .env.test.local.example 외 .env.local.example 신설 — 미구현 (Priority: Low, Module: Documentation)

### E12. Infrastructure

- **Epic 목표**: 데이터베이스 성능/무결성과 CI/CD 파이프라인이 안정적으로 운영을 뒷받침한다.
- **완료 조건**: 고트래픽 테이블의 FK 컬럼에 인덱스가 있고, 파괴적 스크립트가 안전장치로 보호되며, CI가 Node 버전 우회 없이 정상 동작한다.
- **현재 구현 상태**: GitHub Actions 통합테스트 워크플로 구현 완료(Node 22 우회 적용 상태). FK 인덱스 다수 누락, 파괴적 스크립트 안전장치 미비.
- **우선순위**: High

#### E12-F1. 핵심 테이블 FK 인덱스 정비 — *미구현* (Priority: High, Module: Database)

**Acceptance Criteria**
- reservations/payments/memberships/admin_action_logs/orders/notifications의 모든 FK 컬럼에 인덱스가 존재하거나, 인덱스가 불필요한 이유가 문서화된다.

**Task 목록**
- `E12-F1-T1` [Task] reservations/payments/memberships FK 인덱스 추가 — 미구현 (Priority: High, Module: Database)
- `E12-F1-T2` [Task] admin_action_logs/orders/notifications FK 인덱스 추가 — 미구현 (Priority: Medium, Module: Database)

#### E12-F2. 파괴적 SQL 스크립트 안전장치 — *부분 구현* (Priority: Medium, Module: Database)

**Acceptance Criteria**
- 파괴적 스크립트가 실수로 운영에 실행되지 않도록 파일명/디렉터리 분리 또는 실행 전 확인 절차가 존재한다.

**Task 목록**
- `E12-F2-T1` [Task] reset_test_data.sql / reset_class_products.sql / add_membership_rules.sql 전체삭제 구문 안전장치 문서화 — 부분 구현 (Priority: Medium, Module: Database)

#### E12-F3. CI/CD 안정화 — *부분 구현* (Priority: Low, Module: DevOps)

**Acceptance Criteria**
- 단위 테스트가 실제 Supabase 클라이언트 초기화 없이 격리되어 실행된다.
- Node 20에서도 CI가 정상 동작한다(우회 없이).

**Task 목록**
- `E12-F3-T1` [Refactor] 단위 테스트의 lib/supabaseClient.ts 초기화 결합 제거 — 리팩터링 필요 (Priority: Low, Module: Backend)

### 상세 Task 명세

아래는 위 목록에 나온 모든 Task/Bug/Refactor/Docs 항목의 전체 명세입니다 (제목/목적/작업범위/제외범위/예상 수정 파일/관련 DB 테이블/Acceptance Criteria/테스트 방법/문서 업데이트 대상/의존 작업/위험 요소).

#### `E01-F1-T1` [Bug] 사업자등록증 업로드가 실제 Storage 저장 경로를 사용하는지 검증

- **Epic / Feature**: Authentication / 이메일 회원가입 및 로그인
- **구현 상태**: 검증 필요
- **Priority / Module**: High / Frontend
- **목적**: app/login/page.tsx:155의 코드 주석이 '실제 파일 업로드는 Storage에 올린 뒤 그 경로를 저장해야 함'이라고 남아있어, lib/storage.ts의 업로드 로직이 실제로 이 화면에서 호출되는지 문서(구현 완료로 기재)와 코드가 불일치할 가능성이 있다.
- **작업 범위**:
  - app/login/page.tsx의 사업자등록증 업로드 흐름 재확인
  - lib/storage.ts 호출 여부 확인 및 필요시 연결
- **제외 범위**:
  - Storage 버킷 정책/용량 제한 변경(별도 Task)
- **예상 수정 파일**: app/login/page.tsx, lib/storage.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 회원가입 화면에서 업로드한 사업자등록증 파일이 Supabase Storage business-licenses 버킷에 실제로 저장된다.
  - 저장된 파일 경로가 centers 테이블 또는 관련 컬럼에 기록된다.
- **테스트 방법**: 매니저 가입 시나리오로 업로드 후 Supabase Storage 콘솔에서 파일 존재 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/CHANGELOG.md
- **의존 작업**: 없음
- **위험 요소**: 실제로는 이미 연결되어 있고 주석만 오래된 것일 수 있음 — 코드 확인 우선

#### `E01-F1-T2` [Refactor] 전역 인증 가드(미들웨어) 도입

- **Epic / Feature**: Authentication / 이메일 회원가입 및 로그인
- **구현 상태**: 미구현
- **Priority / Module**: High / Frontend
- **목적**: 현재 어떤 페이지에도 최상위 인증 가드가 없어 비로그인 사용자가 회원 전용 화면 쉘을 그대로 볼 수 있다(데이터는 RLS로 막히지만 화면 노출 자체가 UX/보안 신뢰성 문제).
- **작업 범위**:
  - Next.js middleware 또는 루트 레이아웃 레벨에서 비로그인 접근 시 /login으로 리다이렉트
  - 공개 라우트(/, /search, /category, /center/[id], /login) 화이트리스트 정의
- **제외 범위**:
  - 매니저/관리자 페이지별 세부 권한 가드(별도 Task, Staff & Permission/System 참고)
- **예상 수정 파일**: app/, middleware.ts(신규)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 비로그인 상태로 /mypage 접근 시 /login으로 리다이렉트된다.
  - 공개 라우트는 비로그인 상태에서도 정상 렌더링된다.
- **테스트 방법**: 비로그인 브라우저 세션으로 각 회원 전용 라우트 접근 후 리다이렉트 확인.
- **문서 업데이트 대상**: docs/ROUTES.md
- **의존 작업**: 없음
- **위험 요소**: 미들웨어 도입이 기존 클라이언트 사이드 데이터 페칭 패턴과 충돌할 수 있어 회귀 테스트 필요

#### `E01-F2-T1` [Task] Kakao/Apple OAuth 운영 환경 설정 확인 및 문서화

- **Epic / Feature**: Authentication / 소셜 로그인 방식 연결 및 해제
- **구현 상태**: 운영 설정 필요
- **Priority / Module**: Medium / DevOps
- **목적**: 코드상 OAuth 호출은 존재하나 Supabase 프로젝트에 provider가 실제로 설정되어 있는지 확인되지 않았다(TODO P2-1).
- **작업 범위**:
  - Supabase Auth 콘솔에서 Kakao/Apple provider 활성화 여부 확인
  - redirect URL 화이트리스트 점검
- **제외 범위**:
  - Naver provider 신규 연동(별도 Feature)
- **예상 수정 파일**: app/login/page.tsx
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - Kakao 버튼으로 실제 신규 계정 생성 및 로그인이 완료된다.
  - Apple 버튼으로 실제 신규 계정 생성 및 로그인이 완료된다.
- **테스트 방법**: 실기기/브라우저에서 각 provider로 로그인 시도 후 accounts 테이블에 신규 행 생성 확인.
- **문서 업데이트 대상**: docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: Supabase 프로젝트 설정 값은 저장소에서 확인 불가 — 운영 콘솔 접근 필요

#### `E01-F2-T2` [Task] 네이버 소셜 로그인 연동

- **Epic / Feature**: Authentication / 소셜 로그인 방식 연결 및 해제
- **구현 상태**: 미구현
- **Priority / Module**: Low / Frontend
- **목적**: 로그인 화면에 Naver 버튼은 있으나 클릭 시 '설정되지 않음' 안내만 표시된다.
- **작업 범위**:
  - Naver OAuth provider 연동
  - Supabase Auth 설정
- **제외 범위**:
  - 기존 이메일/Kakao/Apple 로직 변경
- **예상 수정 파일**: app/login/page.tsx
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - Naver 버튼 클릭 시 실제 OAuth 인증 흐름이 완료되고 계정이 생성/로그인된다.
- **테스트 방법**: Naver 계정으로 로그인 후 accounts/profiles 생성 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md
- **의존 작업**: 없음
- **위험 요소**: Naver 개발자 센터 앱 등록 필요(외부 의존)

#### `E02-F1-T1` [Bug] /admin/categories, /admin/banners에 플랫폼 관리자 클라이언트 가드 추가

- **Epic / Feature**: Organization & Multi Center / 센터 등록 및 플랫폼 승인 처리
- **구현 상태**: 부분 구현
- **Priority / Module**: High / Frontend
- **목적**: 두 화면은 checkPlatformAdmin() 사전 가드 없이 렌더링되어, 비관리자도 화면과 폼을 볼 수 있다. 실제 쓰기는 RLS로 막히지만 화면 노출 자체가 노출 표면이다.
- **작업 범위**:
  - app/admin/categories/page.tsx, app/admin/banners/page.tsx에 /admin/centers와 동일한 checkPlatformAdmin() 가드 패턴 적용
- **제외 범위**:
  - RLS 정책 자체 변경(이미 충분히 보호됨)
- **예상 수정 파일**: app/admin/categories/page.tsx, app/admin/banners/page.tsx, lib/admin.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 비관리자 계정으로 두 라우트 접근 시 콘텐츠 대신 접근 불가 안내가 표시된다.
  - 관리자 계정으로는 기존과 동일하게 정상 동작한다.
- **테스트 방법**: 일반 회원 계정으로 두 라우트 직접 접근 후 접근 차단 확인 + 관리자 계정 회귀 테스트.
- **문서 업데이트 대상**: docs/ROUTES.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E02-F2-T1` [Task] center_contacts, schedule_templates 실사용 여부 확인

- **Epic / Feature**: Organization & Multi Center / 센터 운영 정보 관리(소개/사진/연락처/위치)
- **구현 상태**: 검증 필요
- **Priority / Module**: Low / Backend
- **목적**: 두 테이블 모두 app/lib에서 직접 .from() 참조가 확인되지 않아, 실제 사용 중인지 스키마만 남은 것인지 불명확하다.
- **작업 범위**:
  - 코드베이스 전체에서 두 테이블 참조 여부 재확인(중첩 select/RPC 내부 포함)
- **제외 범위**:
  - 테이블 삭제(사용 확정 전에는 삭제 금지)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: center_contacts, schedule_templates
- **Acceptance Criteria**:
  - 두 테이블이 실제로 어떤 화면/RPC에서 쓰이는지, 혹은 미사용인지 결론이 문서화된다.
- **테스트 방법**: grep + 코드 리딩 기반 확인, 필요시 운영 DB 행 수 확인 요청.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E03-F2-T1` [Task] 담당회원 배정 코드/DB 영향 분석

- **Epic / Feature**: Member / 담당회원 및 상담고객(리드) 관리
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Backend
- **목적**: app/manager/members/page.tsx:358의 담당회원 탭은 '담당회원 기능은 준비 중이에요' 텍스트만 렌더링한다. 2026-07-31 의사결정: 담당 관계 저장 방식은 별도 조인 테이블 방식을 우선안으로 기록하되, 실제 신규 테이블 생성은 이 Task에서 실행하지 않는다.
- **작업 범위**:
  - 기존 center_members/profiles/manager_centers 참조 코드 전수 확인
  - 별도 조인 테이블(예: member_staff_assignments) 설계안 문서화(컬럼, FK, RLS 초안)
  - 기존 화면/쿼리에 미치는 영향 분석
- **제외 범위**:
  - 신규 테이블 실제 생성(별도 승인 후 후속 Task)
  - 배정 UI 구현(후속 Task)
- **예상 수정 파일**: app/manager/members/page.tsx, lib/members.ts
- **관련 DB 테이블**: center_members, profiles
- **Acceptance Criteria**:
  - 별도 조인 테이블 설계안(컬럼/FK/RLS 초안)이 문서로 정리된다.
  - 기존 코드에 미치는 영향(변경 필요 파일 목록)이 정리된다.
- **테스트 방법**: 해당 없음(분석 Task) — 산출물은 설계 문서.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/TODO.md, docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 설계 확정 전 제품 결정 필요 — 이 Task는 분석까지만 수행

#### `E03-F2-T2` [Task] 담당 관계 조인 테이블 생성 및 배정 UI 구현

- **Epic / Feature**: Member / 담당회원 및 상담고객(리드) 관리
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Backend
- **목적**: 담당회원 배정 코드/DB 영향 분석에서 나온 조인 테이블 설계안을 실제로 적용하는 구현 Task. **신규 테이블 생성은 별도 승인 전까지 실행하지 않는다(2026-07-31 의사결정).**
- **작업 범위**:
  - 신규 조인 테이블 Migration 작성(승인 후)
  - 배정/조회 UI 구현
- **제외 범위**:
  - 상담고객(leads) 관리(별도 Task)
- **예상 수정 파일**: app/manager/members/page.tsx, lib/members.ts
- **관련 DB 테이블**: center_members, profiles
- **DB 변경 사항**:
  - 필요한 Migration: 신규 조인 테이블(예: member_staff_assignments) — 승인 전까지 실행 금지
  - RLS 영향: 신규 테이블에 대한 RLS 정책 신규 작성 필요
  - 기존 데이터 영향: 없음(신규 테이블)
  - Rollback 필요 여부: 신규 테이블이므로 테이블 삭제로 rollback 가능
- **Acceptance Criteria**:
  - 매니저가 특정 회원에게 담당 강사/직원을 배정할 수 있다.
  - 담당회원 탭에서 배정된 목록이 조회된다.
- **테스트 방법**: 배정 후 새로고침해도 담당 정보가 유지되는지 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/TODO.md
- **의존 작업**: 담당회원 배정 코드/DB 영향 분석
- **위험 요소**: 신규 테이블 생성은 사용자 승인 필요 — 승인 전까지 착수 금지

#### `E03-F2-T3` [Task] 상담고객(leads) CRUD 화면 구현

- **Epic / Feature**: Member / 담당회원 및 상담고객(리드) 관리
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Frontend
- **목적**: leads 테이블은 존재하나(center_id FK) 실제 CRUD 화면이 없다.
- **작업 범위**:
  - 상담고객 목록/등록/상태변경 화면
- **제외 범위**:
  - 담당회원 배정(별도 Task)
- **예상 수정 파일**: app/manager/members/page.tsx, lib/members.ts(또는 신규 lib/leads.ts)
- **관련 DB 테이블**: leads
- **Acceptance Criteria**:
  - 상담고객을 등록/조회/상태 변경할 수 있다.
- **테스트 방법**: 신규 상담고객 등록 후 목록에 반영되는지 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E04-F2-T1` [Task] membership_transfers 기반 수강권 양도 플로우 구현

- **Epic / Feature**: Membership / 수강권 양도
- **구현 상태**: 미구현
- **Priority / Module**: Low / Backend
- **목적**: membership_transfers 테이블(from_profile_id/to_profile_id/membership_id)은 존재하나 실제 호출하는 코드가 없다.
- **작업 범위**:
  - 양도 요청 RPC(security definer)
  - 매니저 승인 화면
- **제외 범위**:
  - 양도 수수료(transfer_fee) 결제 연동
- **예상 수정 파일**: lib/passes.ts(또는 신규)
- **관련 DB 테이블**: membership_transfers, memberships
- **DB 변경 사항**:
  - 필요한 Migration: 기존 membership_transfers 테이블 재사용 가능성 높음, 신규 RPC 추가 필요
  - RLS 영향: RPC 내부 권한 체크로 RLS 우회 없이 처리
  - 기존 데이터 영향: memberships.profile_id 갱신 — 기존 예약과의 연결 정합성 검토 필요
  - Rollback 필요 여부: 양도 취소 RPC 별도 필요 여부 검토
- **Acceptance Criteria**:
  - 양도 완료 후 원 회원은 해당 수강권을 사용할 수 없고 대상 회원만 사용 가능하다.
  - 양도 이력이 조회 가능하다.
- **테스트 방법**: 양도 전/후 양쪽 프로필의 usable_memberships() 결과 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 동시 예약 중인 수강권 양도 시 정합성 처리 필요

#### `E04-F3-T1` [Task] point_transactions / point_accounts / point_logs 역할·데이터흐름·중복·참조코드·RPC 분석

- **Epic / Feature**: Membership / 포인트 원장 정합성 정리
- **구현 상태**: 검증 필요
- **Priority / Module**: High / Database
- **목적**: 판매 화면은 point_transactions를, 리뷰/구매 적립은 point_accounts를 사용하는 것으로 보이며 두 원장 간 동기화가 확인되지 않았다(TODO P1-1). 2026-07-31 의사결정: **지금 통합하지 않는다.** 이 Task는 현재 역할/데이터 흐름/중복/참조 코드/RPC를 분석하는 데까지만 하고, 통합 여부는 이 Task의 산출물을 근거로 별도 Decision에서 정한다.
- **작업 범위**:
  - 세 테이블 각각의 실제 코드 호출 경로 전수 확인(lib/sales.ts, lib/reviews.ts 등)
  - 세 테이블을 참조하는 RPC 목록화
  - 중복/불일치 지점 구체적으로 식별
  - 분석 결과를 근거로 통합 여부에 대한 옵션(통합/역할분리유지)을 정리한 별도 Decision 문서 초안 작성
- **제외 범위**:
  - 실제 원장 통합/마이그레이션 실행(이번 Task 범위 아님 — 별도 Decision 및 후속 Task 필요)
  - 포인트 사용처(결제 시 차감 로직) 신규 개발
- **예상 수정 파일**: lib/sales.ts, lib/reviews.ts
- **관련 DB 테이블**: point_transactions, point_accounts, point_logs
- **Acceptance Criteria**:
  - 세 테이블 각각의 실제 참조 코드 위치와 데이터 흐름이 문서로 정리된다.
  - 중복/불일치 지점이 구체적으로 식별된다.
  - 통합 여부에 대한 결정은 이 Task에서 내리지 않고 별도 Decision 문서로 남겨진다.
- **테스트 방법**: 해당 없음(분석 Task) — 산출물은 분석 문서 및 Decision 초안.
- **문서 업데이트 대상**: docs/DATABASE.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 분석 결과에 따라 후속 통합 작업 범위가 크게 달라질 수 있음 — 이번 Task는 통합을 실행하지 않는다

#### `E04-F3-T2` [Task] product_passes 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정

- **Epic / Feature**: Membership / 포인트 원장 정합성 정리
- **구현 상태**: 검증 필요
- **Priority / Module**: Low / Database
- **목적**: product_passes는 수강권 소유 구조를 갖고 있으나 현재 앱은 memberships/products를 사용 중으로 보인다. 2026-07-31 의사결정: 삭제 후보 확정까지만 수행, 실제 DROP은 범위 밖.
- **작업 범위**:
  - 운영 DB에서 product_passes 실제 행 존재 여부 확인
  - FK/RPC 참조 여부 확인
  - 레거시 확정 시 삭제 후보로 문서화
- **제외 범위**:
  - 테이블 DROP 실행(별도 승인 필요)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: product_passes
- **Acceptance Criteria**:
  - product_passes의 사용처/FK/RPC 조사 결론과 삭제 후보 여부가 docs/DATABASE.md에 반영된다.
- **테스트 방법**: 코드 grep + 운영 DB 행 수 확인.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 실제 DROP은 별도 승인·별도 Task로 진행

#### `E05-F2-T1` [Task] 용량초과(capacity-override) 2단계 확인 플로우 통합테스트 추가

- **Epic / Feature**: Reservation & Class / 관리자 직접배치 및 무료 추가 배치
- **구현 상태**: 부분 구현
- **Priority / Module**: Medium / Backend
- **목적**: 이 플로우는 수동으로만 검증되었고 자동화된 통합 테스트가 없다(TODO P1-11).
- **작업 범위**:
  - tests/integration/admin-assignment-security.test.ts에 용량초과 확인→확정 2단계 케이스 추가
- **제외 범위**:
  - 플로우 로직 자체 변경
- **예상 수정 파일**: tests/integration/admin-assignment-security.test.ts
- **관련 DB 테이블**: reservations, admin_action_logs
- **Acceptance Criteria**:
  - 용량초과 상태에서 1단계 호출만으로는 예약이 생성되지 않는다.
  - 2단계 확인 호출 후에만 is_capacity_override=true로 예약이 생성된다.
- **테스트 방법**: 신규 통합 테스트 실행으로 검증.
- **문서 업데이트 대상**: docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E05-F3-T1` [Bug] 예약 캘린더 공휴일을 하드코딩 대신 테이블/API 기반으로 전환

- **Epic / Feature**: Reservation & Class / 예약 화면 공휴일 자동 반영
- **구현 상태**: 미구현
- **Priority / Module**: Low / Frontend
- **목적**: app/reservation/page.tsx:34에 2026-07-17 하나만 하드코딩되어 있어 이후 연도/공휴일이 전혀 반영되지 않는다.
- **작업 범위**:
  - center_holidays 또는 별도 공휴일 테이블/외부 API 연동으로 대체
- **제외 범위**:
  - 센터별 임시 휴무일(center_holidays) 로직 변경 — 이미 별도 구현됨
- **예상 수정 파일**: app/reservation/page.tsx
- **관련 DB 테이블**: center_holidays
- **Acceptance Criteria**:
  - 연도가 바뀌어도 코드 수정 없이 공휴일이 올바르게 표시된다.
- **테스트 방법**: 임의 연도 이동 후 알려진 공휴일이 화면에 표시되는지 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 외부 공휴일 API 사용 시 요금/쿼터 확인 필요

#### `E05-F4-T1` [Task] class_types / class_trainers 실사용 여부 확인 및 UI 연동

- **Epic / Feature**: Reservation & Class / 수업 유형 분류 및 복수 강사 배정
- **구현 상태**: 검증 필요
- **Priority / Module**: Low / Frontend
- **목적**: 두 테이블 모두 FK는 정의되어 있으나 화면에서 실제로 쓰이는지 확인되지 않았다.
- **작업 범위**:
  - 코드 전수 확인 후 미사용이면 UI 연동, 이미 사용 중이면 문서만 갱신
- **예상 수정 파일**: app/manager/classes/page.tsx, lib/classes.ts
- **관련 DB 테이블**: class_types, class_trainers
- **Acceptance Criteria**:
  - 결론(사용중/미사용)이 docs/REQUIREMENTS.md에 반영된다.
- **테스트 방법**: 코드 grep 및 실제 화면 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E06-F1-T1` [Task] Payment Provider 인터페이스 정리

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 검증 필요
- **Priority / Module**: High / Backend
- **목적**: 현재 lib/payments/types.ts의 PaymentProvider 인터페이스가 실PG(Toss/PortOne) 연동에 필요한 모든 메서드/에러 케이스를 충분히 커버하는지 재검토가 필요하다. 2026-07-31 의사결정: 실제 PG 연동은 지금 하지 않고, 인터페이스 정리까지만 수행한다.
- **작업 범위**:
  - 기존 PaymentProvider 인터페이스(createPayment/confirmPayment/cancelPayment/getPaymentStatus) 재검토
  - 웹훅 수신을 위한 인터페이스 확장 여부 검토(설계만)
- **제외 범위**:
  - 실제 Toss/PortOne 구현체 작성
- **예상 수정 파일**: lib/payments/types.ts, lib/payments/PaymentProviderFactory.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 인터페이스 정리안이 문서로 정리되고, 기존 MockPaymentProvider와의 호환성이 확인된다.
- **테스트 방법**: 기존 Mock 결제 흐름이 인터페이스 변경 없이 그대로 동작하는지 회귀 테스트(npm run test:all).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E06-F1-T2` [Refactor] Mock Provider와 Production Provider 분리

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 리팩터링 필요
- **Priority / Module**: Medium / Backend
- **목적**: 현재 PaymentProviderFactory가 env var로 Mock/Toss/PortOne을 선택하나, 테스트 환경에서 Production 경로가 실수로 선택되지 않도록 경계를 명확히 분리할 필요가 있다. TossPaymentProvider/PortOnePaymentProvider 스텁 파일이 90% 동일 구조인 점도 함께 검토한다.
- **작업 범위**:
  - Mock/Production 선택 로직을 환경(NODE_ENV, 배포 환경변수)에 따라 명확히 분리
  - Toss/PortOne 공통 베이스(에러 포맷 등) 추출 여부 검토
- **제외 범위**:
  - 실제 Toss/PortOne 구현체 작성
- **예상 수정 파일**: lib/payments/PaymentProviderFactory.ts, lib/payments/TossPaymentProvider.ts, lib/payments/PortOnePaymentProvider.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 운영 배포 환경에서 Mock Provider가 실수로 선택될 수 없음이 코드/설정으로 보장된다.
- **테스트 방법**: 환경변수 조합별 Factory 선택 결과 단위 테스트.
- **문서 업데이트 대상**: 없음
- **의존 작업**: Payment Provider 인터페이스 정리
- **위험 요소**: 없음

#### `E06-F1-T3` [Task] Toss 웹훅 설계

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 미구현
- **Priority / Module**: High / Backend
- **목적**: 실제 Toss 연동 착수 전, 웹훅 수신 엔드포인트/서명 검증/멱등성 처리 방식을 먼저 설계 문서로 확정해둔다. 2026-07-31 의사결정: 설계까지만 하고 실제 구현은 하지 않는다.
- **작업 범위**:
  - 웹훅 엔드포인트 라우트 설계
  - 서명 검증 방식 설계
  - 중복 수신 시 멱등 처리 설계
- **제외 범위**:
  - 실제 웹훅 엔드포인트 구현
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: payments, orders
- **Security 검토 항목**:
  - 웹훅 서명 검증 설계 필수
  - 재전송 공격 방지를 위한 멱등키 설계 필수
- **Acceptance Criteria**:
  - 웹훅 설계 문서(엔드포인트/서명검증/멱등성)가 작성된다.
- **테스트 방법**: 해당 없음(설계 Task).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: Payment Provider 인터페이스 정리
- **위험 요소**: 없음

#### `E06-F1-T4` [Task] 결제 성공/실패/취소/환불 상태 모델 검토

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 검증 필요
- **Priority / Module**: Medium / Backend
- **목적**: 현재 orders/payments 상태 전이가 Mock 흐름 기준으로만 설계되어 있어, 실PG의 실패/부분취소/환불 등 추가 상태 전이가 기존 모델에 들어맞는지 검토가 필요하다.
- **작업 범위**:
  - orders.status/payments 상태값 전수 확인
  - 실PG 도입 시 필요한 신규 상태(부분환불 등) 식별
- **제외 범위**:
  - 실제 상태 컬럼/전이 로직 변경
- **예상 수정 파일**: lib/orders.ts, lib/payments
- **관련 DB 테이블**: orders, payments
- **Acceptance Criteria**:
  - 현재 상태 모델과 실PG 요구사항 간 차이가 문서로 정리된다.
- **테스트 방법**: 해당 없음(검토 Task).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E06-F1-T5` [Docs] 실 PG 연동 준비 체크리스트 작성

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Documentation
- **목적**: 사업자 등록 완료 후 실제 Toss/PortOne 연동에 착수할 때 바로 참고할 수 있는 체크리스트를 미리 정리해둔다.
- **작업 범위**:
  - 사업자 등록/가맹점 심사/웹훅 URL 등록/테스트 키→운영 키 전환/모니터링 항목을 체크리스트로 정리
- **제외 범위**:
  - 실제 연동 착수
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 체크리스트 문서가 docs/TODO.md 또는 별도 문서로 존재한다.
- **테스트 방법**: 해당 없음(문서 Task).
- **문서 업데이트 대상**: docs/TODO.md
- **의존 작업**: Toss 웹훅 설계, 결제 성공/실패/취소/환불 상태 모델 검토
- **위험 요소**: 없음

#### `E06-F1-T6` [Task] TossPaymentProvider 실제 연동 구현

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 미구현
- **Priority / Module**: Critical / Backend
- **목적**: lib/payments/TossPaymentProvider.ts의 모든 메서드가 현재 에러만 던진다. **2026-07-31 의사결정: 지금 구현하지 않는다.** 사업자 등록 완료 및 위 준비 Task 완료 후 별도 승인을 받아 착수한다.
- **작업 범위**:
  - createPayment/confirmPayment/cancelPayment/getPaymentStatus 실제 구현
  - 웹훅 서명 검증 구현
- **제외 범위**:
  - PortOne 구현(별도 Task)
  - 프론트엔드 결제위젯 UI 변경
- **예상 수정 파일**: lib/payments/TossPaymentProvider.ts, lib/payments/PaymentProviderFactory.ts
- **관련 DB 테이블**: payments, orders, memberships
- **Security 검토 항목**:
  - 웹훅 서명 검증 필수
  - 결제 금액은 반드시 서버에서 주문 금액과 재대조
  - 중복 승인 요청에 대한 멱등성 처리
- **Acceptance Criteria**:
  - 테스트 결제가 아닌 실제 Toss 승인 요청이 성공/실패 모두 정확히 처리된다.
  - 승인 성공 시 fulfill_order()가 정확히 1회 호출된다.
- **테스트 방법**: Toss 테스트 키로 성공/실패/취소 각 시나리오 수행 후 orders/payments/memberships 상태 확인.
- **문서 업데이트 대상**: docs/TODO.md, docs/CHANGELOG.md
- **의존 작업**: Payment Provider 인터페이스 정리, Mock Provider와 Production Provider 분리, Toss 웹훅 설계, 결제 성공/실패/취소/환불 상태 모델 검토, 실 PG 연동 준비 체크리스트 작성
- **위험 요소**: 사업자 등록 및 Toss 가맹점 심사 완료가 선행 조건(외부 의존), 별도 승인 없이는 착수 금지

#### `E06-F1-T7` [Refactor] fulfill_order()와 confirm_test_payment() 중복 로직 통합 설계

- **Epic / Feature**: Product & Payment / 실제 PG 결제 연동 준비
- **구현 상태**: 리팩터링 필요
- **Priority / Module**: Medium / Backend
- **목적**: 두 함수가 유사한 발급 로직을 신뢰 모델만 다르게 하여 중복 보유 중(의도된 임시 구조, TODO P0-1에서 실PG 연동 시점에 통합 예정으로 명시됨). 설계만 하고 실제 통합은 실PG 연동(Blocked) 이후로 미룬다.
- **작업 범위**:
  - 실PG 연동 작업과 함께 공통 발급 로직을 단일 함수/RPC로 추출하는 설계
- **제외 범위**:
  - Mock provider 자체 제거(당분간 테스트 환경에 필요)
  - 실제 통합 실행(TossPaymentProvider 실제 연동 구현 승인 후)
- **예상 수정 파일**: reservation_functions.sql, add_direct_payment.sql
- **관련 DB 테이블**: orders, payments, memberships
- **DB 변경 사항**:
  - 필요한 Migration: 공통 RPC로 통합 시 신규 함수 정의 필요(실제 통합 시점)
  - RLS 영향: 기존 security definer 경계 유지
  - 기존 데이터 영향: 없음(로직 통합, 데이터 구조 불변)
  - Rollback 필요 여부: 함수 정의만 되돌리면 됨
- **Acceptance Criteria**:
  - 실PG 연동 완료 후 두 경로가 동일한 발급 함수를 호출하도록 하는 설계안이 문서화된다.
- **테스트 방법**: 해당 없음(설계 Task) — 실제 통합 시점에 통합 테스트로 검증.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: TossPaymentProvider 실제 연동 구현
- **위험 요소**: 없음

#### `E06-F2-T1` [Task] 미발급 주문 회원 셀프 취소 기능

- **Epic / Feature**: Product & Payment / 주문 취소 및 환불 정책 설정
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Backend
- **목적**: 현재는 미발급 주문 취소를 위해 센터에 별도 문의해야 한다.
- **작업 범위**:
  - 주문 status='pending' 상태에서만 회원이 취소 가능한 RPC 추가
- **제외 범위**:
  - 발급 완료된 주문의 환불(이미 refund_membership()으로 존재)
- **예상 수정 파일**: lib/orders.ts, app/purchases/page.tsx
- **관련 DB 테이블**: orders
- **DB 변경 사항**:
  - 필요한 Migration: orders 취소 상태 전이를 처리하는 신규 RPC
  - RLS 영향: 본인 주문만 취소 가능하도록 RPC 내 검증
  - 기존 데이터 영향: 없음
  - Rollback 필요 여부: RPC 제거로 원복 가능
- **Acceptance Criteria**:
  - pending 주문에 취소 버튼이 노출되고 클릭 시 상태가 cancelled로 바뀐다.
  - 이미 발급된 주문에는 취소 버튼이 노출되지 않는다.
- **테스트 방법**: pending/issued 각 상태에서 취소 가능 여부 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E06-F2-T2` [Task] 센터별 환불 정책(기간/조건) 설정 기능

- **Epic / Feature**: Product & Payment / 주문 취소 및 환불 정책 설정
- **구현 상태**: 미구현
- **Priority / Module**: Low / Backend
- **목적**: 현재 24시간/미사용 환불 조건이 코드에 하드코딩되어 있다.
- **작업 범위**:
  - center_settings에 환불 정책 필드 추가
  - 관리 화면에서 설정
- **제외 범위**:
  - 실PG 환불 API 연동(별도)
- **예상 수정 파일**: lib/settings.ts, app/manager/settings/page.tsx
- **관련 DB 테이블**: center_settings
- **DB 변경 사항**:
  - 필요한 Migration: add_refund_policy_settings.sql: center_settings에 컬럼 추가(nullable, 기본값=기존 하드코딩 값)
  - RLS 영향: 기존 center_settings 정책 재사용
  - 기존 데이터 영향: 기존 행에 기본값 백필 필요
  - Rollback 필요 여부: 컬럼 삭제
- **Acceptance Criteria**:
  - 매니저가 환불 가능 기간을 센터별로 변경할 수 있고, 변경값이 실제 환불 판정에 반영된다.
- **테스트 방법**: 기본값과 다른 값으로 설정 후 환불 가능 여부가 그에 따라 달라지는지 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E07-F1-T1` [Bug] /manager/staff/permissions에 오너 전용 클라이언트 가드 추가

- **Epic / Feature**: Staff & Permission / 센터별 직원 권한 관리
- **구현 상태**: 부분 구현
- **Priority / Module**: High / Frontend
- **목적**: 이 화면은 fetchMyCenters() 가드와 오너 전용 사전 확인이 없어, 소속되지 않은 사용자도 화면과 폼을 볼 수 있다.
- **작업 범위**:
  - fetchMyCenters() + 오너 역할 확인 가드 추가
- **제외 범위**:
  - 권한 데이터 모델 자체 변경
- **예상 수정 파일**: app/manager/staff/permissions/page.tsx
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 소속되지 않은 사용자가 접근 시 콘텐츠 대신 접근 불가 안내가 표시된다.
  - 오너 계정은 기존과 동일하게 정상 동작한다.
- **테스트 방법**: 비소속/일반 직원/오너 계정 각각으로 접근 테스트.
- **문서 업데이트 대상**: docs/ROUTES.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E07-F2-T1` [Task] 매니저 화면 전반에 effectiveState() 기반 메뉴/버튼 노출 제어 적용

- **Epic / Feature**: Staff & Permission / 세부 권한 기반 UI 표시 제어
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Frontend
- **목적**: 현재 effectiveState()는 권한 설정 화면 자체에서만 쓰이고, 다른 매니저 화면들은 권한과 무관하게 모든 메뉴/버튼을 노출한다.
- **작업 범위**:
  - app/manager/page.tsx 메뉴 목록, 각 하위 화면의 액션 버튼에 permission 체크 적용
- **제외 범위**:
  - 권한 카탈로그(permissions) 자체 확장
- **예상 수정 파일**: app/manager/page.tsx, lib/roles.ts
- **관련 DB 테이블**: permissions, role_permissions, account_center_permissions
- **Acceptance Criteria**:
  - 권한이 없는 직원 계정으로 로그인하면 해당 메뉴가 보이지 않거나 비활성화된다.
  - 서버 차단과 화면 노출 제어 결과가 항상 일치한다.
- **테스트 방법**: 권한을 의도적으로 제거한 테스트 계정으로 각 메뉴 노출 여부 확인.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 전 화면에 걸친 변경이라 회귀 범위가 넓음 — 화면 단위로 나눠 진행 권장

#### `E07-F3-T1` [Task] staff_salaries / staff_schedules / schedule_memos 실사용 여부 확인

- **Epic / Feature**: Staff & Permission / 직원 급여 및 근무 스케줄 관리
- **구현 상태**: 검증 필요
- **Priority / Module**: Low / Backend
- **목적**: 세 테이블 모두 FK는 있으나 코드에서 직접 참조가 확인되지 않았다.
- **작업 범위**:
  - 코드 전수 확인 후 미사용이면 향후 Feature로 별도 설계, 사용 중이면 문서 갱신
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: staff_salaries, staff_schedules, schedule_memos
- **Acceptance Criteria**:
  - 결론이 docs/REQUIREMENTS.md/docs/DATABASE.md에 반영된다.
- **테스트 방법**: 코드 grep.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E08-F1-T1` [Bug] /manager/inquiries, /manager/notifications에 fetchMyCenters() 가드 추가

- **Epic / Feature**: Notification / 실시간 알림 인박스
- **구현 상태**: 부분 구현
- **Priority / Module**: High / Frontend
- **목적**: 두 화면 모두 소속 센터 확인 가드 없이 렌더링된다.
- **작업 범위**:
  - 다른 매니저 화면과 동일한 fetchMyCenters() 가드 패턴 적용
- **예상 수정 파일**: app/manager/inquiries/page.tsx, app/manager/notifications/page.tsx
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 비소속 계정 접근 시 접근 불가 안내가 표시된다.
- **테스트 방법**: 비소속 계정으로 두 라우트 접근 테스트.
- **문서 업데이트 대상**: docs/ROUTES.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E08-F2-T1` [Task] notify_upcoming_reservations()/notify_expiring_passes() 스케줄러 연결

- **Epic / Feature**: Notification / 정기 알림 스케줄링(예약 임박, 수강권 만료)
- **구현 상태**: 미구현
- **Priority / Module**: High / DevOps
- **목적**: 두 함수는 SQL로 정의되어 있으나 이를 주기적으로 호출하는 스케줄러(pg_cron 등)가 연결되어 있지 않아 실제로는 전혀 발송되지 않는다(TODO P0-5).
- **작업 범위**:
  - Supabase pg_cron 또는 외부 스케줄러(Vercel Cron 등)로 두 함수를 주기 호출하도록 연결
- **제외 범위**:
  - 함수 로직 자체 변경
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: notifications, reservations, memberships
- **DB 변경 사항**:
  - 필요한 Migration: pg_cron 확장 활성화 필요 시 add_notification_scheduler.sql
  - RLS 영향: 영향 없음(함수는 이미 security definer)
  - 기존 데이터 영향: 없음
  - Rollback 필요 여부: cron job 삭제로 원복
- **Acceptance Criteria**:
  - 예약 24시간 전 시점에 해당 회원에게 알림이 실제로 생성된다.
  - 수강권 만료 N일 전 시점에 알림이 실제로 생성된다.
- **테스트 방법**: 스케줄러 실행 후 notifications 테이블에 신규 행 생성 확인.
- **문서 업데이트 대상**: docs/TODO.md, docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 운영 Supabase 플랜에 pg_cron 확장 사용 가능 여부 확인 필요

#### `E08-F3-T1` [Task] 알림 설정과 실제 발송 채널(FCM/알림톡) 연결

- **Epic / Feature**: Notification / 외부 푸시/알림톡 발송 연동
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Backend
- **목적**: app/settings/notifications/page.tsx는 현재 localStorage에만 설정을 저장하고 실제 발송에는 아무 영향이 없다.
- **작업 범위**:
  - FCM 또는 알림톡 발송 서비스 연동
  - 설정값을 서버에 저장하고 발송 시 참조
- **제외 범위**:
  - 인앱 알림(이미 구현됨)
- **예상 수정 파일**: app/settings/notifications/page.tsx, lib/notifications.ts
- **관련 DB 테이블**: notification_rules, notification_logs
- **Acceptance Criteria**:
  - 설정을 끈 채널로는 실제 발송이 되지 않고, 켠 채널로는 실제 발송이 확인된다.
- **테스트 방법**: 설정 on/off 각각에서 실제 발송 여부 확인(테스트 발송 채널 사용).
- **문서 업데이트 대상**: docs/REQUIREMENTS.md, docs/TODO.md
- **의존 작업**: notify_upcoming_reservations()/notify_expiring_passes() 스케줄러 연결
- **위험 요소**: 외부 발송 서비스 비용 발생

#### `E09-F1-T1` [Task] revenue_summary 뷰 실사용 여부 확인

- **Epic / Feature**: Dashboard & Reports / 매니저 대시보드 요약 통계
- **구현 상태**: 검증 필요
- **Priority / Module**: Low / Database
- **목적**: SQL에 뷰가 정의되어 있으나 앱에서 직접 조회하는 코드가 확인되지 않았다.
- **작업 범위**:
  - 코드 전수 확인, 미사용이면 대시보드에서 활용 검토 또는 문서에 미사용으로 명시
- **예상 수정 파일**: lib/managerDashboard.ts, lib/sales.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 결론이 docs/DATABASE.md에 반영된다.
- **테스트 방법**: 코드 grep.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E09-F2-T1` [Task] admin-assignments 화면에 CSV 내보내기 추가

- **Epic / Feature**: Dashboard & Reports / 관리자 활동기록 엑셀 내보내기
- **구현 상태**: 미구현
- **Priority / Module**: Low / Frontend
- **목적**: 해당 화면 헤더 주석에 이번 범위 제외로 명시되어 있던 기능으로, 별도 백로그 항목으로 옮긴다.
- **작업 범위**:
  - 현재 필터 조건 그대로 CSV 내보내기 버튼 추가(기존 회원 목록 CSV 내보내기 패턴 재사용)
- **제외 범위**:
  - 통계 대시보드 신규 추가(이미 매니저 대시보드로 구현됨)
- **예상 수정 파일**: app/manager/admin-assignments/page.tsx
- **관련 DB 테이블**: admin_action_logs
- **Acceptance Criteria**:
  - 필터 적용 후 내보내기 버튼 클릭 시 현재 목록과 동일한 내용의 CSV가 다운로드된다.
- **테스트 방법**: 필터 변경 후 다운로드한 CSV 내용이 화면 목록과 일치하는지 확인.
- **문서 업데이트 대상**: docs/CHANGELOG.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E10-F1-T1` [Task] reviews 테이블 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정

- **Epic / Feature**: Community / 레거시 테이블 정리(reviews, chat_messages)
- **구현 상태**: 검증 필요
- **Priority / Module**: Medium / Database
- **목적**: fix_center_reviews.sql 이후 center_reviews가 현재 리뷰 기능에 쓰이는 것으로 보이며, 원래 reviews 테이블이 완전히 대체되었는지는 운영 데이터 확인이 필요하다. 2026-07-31 의사결정: 삭제 후보 확정까지만 수행하고 실제 DROP은 이 Task 범위에 포함하지 않는다.
- **작업 범위**:
  - 코드 전수 확인(사용처)
  - reviews를 참조하는 FK/RPC 목록화
  - RLS 정책 영향 확인
  - 운영 DB 행 수 확인 요청
  - 삭제 후보 여부 결론 문서화
- **제외 범위**:
  - 테이블 DROP 실행(별도 승인 필요)
- **예상 수정 파일**: lib/reviews.ts
- **관련 DB 테이블**: reviews, center_reviews
- **Acceptance Criteria**:
  - reviews의 사용처/FK/RPC/RLS 영향이 표로 정리된다.
  - 삭제 후보 여부에 대한 결론이 docs/DATABASE.md에 반영된다.
- **테스트 방법**: 코드 grep + 운영 데이터 확인.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 실제 DROP은 이 Task 완료 후 별도 승인·별도 Task로 진행

#### `E10-F1-T2` [Bug] chat_messages 사용처·FK·RLS 영향 조사 및 삭제 후보 확정

- **Epic / Feature**: Community / 레거시 테이블 정리(reviews, chat_messages)
- **구현 상태**: 검증 필요
- **Priority / Module**: Medium / Database
- **목적**: chat_messages는 RLS가 활성화되어 있으나 어떤 create policy도 없어 사실상 아무도 접근할 수 없는 상태다. 의도된 비활성화인지, 정책 누락 버그인지 불명확하다. 2026-07-31 의사결정: 삭제 후보 확정까지만 수행, 실제 DROP은 범위 밖.
- **작업 범위**:
  - 운영 데이터/코드 참조 여부 확인
  - FK 영향 확인
  - 정책 누락 원인 확인 후 미사용 확정 시 삭제 후보로 문서화, 사용 중이라면 정책 긴급 추가는 별도 Bug로 분리
- **제외 범위**:
  - 테이블 DROP 실행(별도 승인 필요)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: chat_messages
- **Acceptance Criteria**:
  - chat_messages의 실제 사용 여부, FK 영향, 정책 부재 원인이 결론 나고 문서화된다.
  - 삭제 후보 여부 결론이 docs/DATABASE.md에 반영된다.
- **테스트 방법**: 코드 grep + 정책 조회(pg_policies).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 실제로 사용 중인데 정책이 없다면 기능 장애 상태 — 우선 확인 필요

#### `E10-F2-T1` [Task] 커뮤니티 게시판 MVP 구현

- **Epic / Feature**: Community / 커뮤니티 게시판 및 대회 정보
- **구현 상태**: 미구현
- **Priority / Module**: Low / Frontend
- **목적**: community_posts/community_comments 테이블은 있으나 화면이 전혀 없다.
- **작업 범위**:
  - 게시글 목록/작성/상세/댓글 화면
- **제외 범위**:
  - 대회 정보(별도 Task)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: community_posts, community_comments
- **Acceptance Criteria**:
  - 게시글을 작성하면 목록에 표시되고, 댓글을 달 수 있다.
- **테스트 방법**: 게시글/댓글 CRUD 수동 테스트.
- **문서 업데이트 대상**: docs/REQUIREMENTS.md
- **의존 작업**: 없음
- **위험 요소**: 착수 여부 자체가 제품 우선순위 결정 필요 — Section E 질문 참고

#### `E11-F1-T1` [Task] [1/5] RLS 미적용 17개 테이블 영향 분석

- **Epic / Feature**: System / RLS 전면 적용 및 회귀 테스트
- **구현 상태**: 미구현
- **Priority / Module**: Critical / Database
- **목적**: class_types, lockers, locker_assignments, membership_transfers, popup_notices, competitions, community_comments, leads, change_logs, staff_salaries, staff_schedules, schedule_memos, contract_templates, terms, contracts, messages, notification_logs 총 17개 테이블에 RLS 활성화 구문이 전혀 없다. 2026-07-31 의사결정: 전체 정책을 바로 변경하지 않고 영향 분석→정책 설계→회귀 테스트→단계적 적용→QA/운영 검증 순서로 진행한다. 이 Task는 1단계(영향 분석)만 수행한다.
- **작업 범위**:
  - 각 테이블의 실제 개인정보/민감정보 포함 여부 확인
  - 각 테이블의 코드/RPC 참조 여부 확인
  - 현재 anon/authenticated 권한으로 실제 노출되는 데이터 범위 확인
  - 테이블별 위험도(개인정보 포함 여부 기준) 우선순위 산정
- **제외 범위**:
  - 실제 정책 작성/적용(2단계 이후 Task)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: class_types, lockers, locker_assignments, membership_transfers, popup_notices, competitions, community_comments, leads, change_logs, staff_salaries, staff_schedules, schedule_memos, contract_templates, terms, contracts, messages, notification_logs
- **Security 검토 항목**:
  - 개인정보(주소/연락처 등)가 포함된 테이블(leads, contracts 등) 우선 점검
  - 실제 운영 DB에서 현재 RLS 상태를 직접 조회하여 저장소 SQL과 일치하는지 먼저 확인
- **Acceptance Criteria**:
  - 17개 테이블 각각의 민감정보 포함 여부와 현재 노출 범위가 표로 정리된다.
  - 위험도 기준 처리 우선순위가 정해진다.
- **테스트 방법**: 해당 없음(분석 Task) — 산출물은 영향 분석 문서.
- **문서 업데이트 대상**: docs/DATABASE.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 개인정보(leads, contracts 등)가 실제로 노출되고 있었을 가능성 — 분석 결과에 따라 후속 단계 긴급도가 달라짐

#### `E11-F1-T2` [Task] [2/5] 테이블별 역할 기반 RLS 정책 설계

- **Epic / Feature**: System / RLS 전면 적용 및 회귀 테스트
- **구현 상태**: 미구현
- **Priority / Module**: Critical / Database
- **목적**: 1단계 영향 분석 결과를 바탕으로, 각 테이블에 필요한 역할별(본인/소속센터매니저/플랫폼관리자) 최소 접근 정책을 설계한다.
- **작업 범위**:
  - 테이블별 SELECT/INSERT/UPDATE/DELETE 정책 초안 작성
  - 기존 유사 테이블(center_members 등)의 정책 패턴 재사용 검토
- **제외 범위**:
  - 실제 SQL 적용(4단계)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: class_types, lockers, locker_assignments, membership_transfers, popup_notices, competitions, community_comments, leads, change_logs, staff_salaries, staff_schedules, schedule_memos, contract_templates, terms, contracts, messages, notification_logs
- **Acceptance Criteria**:
  - 17개 테이블 전부에 대해 정책 설계안(SQL 초안 포함)이 문서로 정리된다.
- **테스트 방법**: 해당 없음(설계 Task).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: [1/5] RLS 미적용 17개 테이블 영향 분석
- **위험 요소**: 없음

#### `E11-F1-T3` [Task] [3/5] RLS 역할별 회귀 테스트 스위트 구축

- **Epic / Feature**: System / RLS 전면 적용 및 회귀 테스트
- **구현 상태**: 미구현
- **Priority / Module**: Critical / Backend
- **목적**: RLS/RPC가 유일한 보안 경계인데도 이를 자동으로 검증하는 테스트가 없다(TODO P0-4). 정책을 실제 적용하기 전에 회귀 테스트부터 마련해, 적용 전/후 접근 허용·차단이 의도대로인지 비교 검증한다.
- **작업 범위**:
  - 회원/매니저/타센터매니저/플랫폼관리자 4개 역할 × 17개 테이블 + 기존 핵심 테이블(reservations, memberships, payments, admin_action_logs 등) 접근 시나리오 테스트 작성
- **제외 범위**:
  - 정책 실제 적용(4단계)
- **예상 수정 파일**: tests/integration/
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - CI에서 역할별 접근 테스트가 실행되고, 정책 적용 전 기준(현재 상태)으로 먼저 통과/실패가 기록된다.
- **테스트 방법**: 신규 테스트 실행 자체가 검증.
- **문서 업데이트 대상**: docs/TODO.md, tests/README.md
- **의존 작업**: [2/5] 테이블별 역할 기반 RLS 정책 설계
- **위험 요소**: 없음

#### `E11-F1-T4` [Task] [4/5] RLS 정책 단계적 적용

- **Epic / Feature**: System / RLS 전면 적용 및 회귀 테스트
- **구현 상태**: 미구현
- **Priority / Module**: Critical / Database
- **목적**: 17개 테이블에 정책을 한 번에 몰아서 적용하지 않고, 위험도 우선순위(1단계 분석 결과)에 따라 배치로 나눠 단계적으로 적용한다.
- **작업 범위**:
  - 신규 fix_missing_rls_batch1.sql 등 배치별 Migration 작성/적용
  - 각 배치 적용 후 3단계 회귀 테스트 재실행
- **제외 범위**:
  - 레거시 확정 예정 테이블(다른 Task에서 삭제 후보로 결론난 경우)은 이 단계에서 제외하고 별도 처리 가능
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: class_types, lockers, locker_assignments, membership_transfers, popup_notices, competitions, community_comments, leads, change_logs, staff_salaries, staff_schedules, schedule_memos, contract_templates, terms, contracts, messages, notification_logs
- **DB 변경 사항**:
  - 필요한 Migration: 배치별 fix_missing_rls_batchN.sql
  - RLS 영향: 신규 정책 다수 추가
  - 기존 데이터 영향: 기존 데이터 영향 없음(접근 제어만 추가)
  - Rollback 필요 여부: 배치 단위로 정책 삭제하여 원복 가능(단, 원복 시 노출 위험 재발)
- **Acceptance Criteria**:
  - 17개 테이블 모두 RLS가 활성화되고 최소 1개 이상의 정책이 존재한다.
  - 비인가 계정으로 각 테이블에 직접 조회/쓰기 시도 시 거부된다.
  - 각 배치 적용 후 회귀 테스트가 통과한다.
- **테스트 방법**: 각 배치 적용 후 3단계에서 만든 회귀 테스트 스위트 재실행.
- **문서 업데이트 대상**: docs/DATABASE.md, docs/CHANGELOG.md
- **의존 작업**: [3/5] RLS 역할별 회귀 테스트 스위트 구축
- **위험 요소**: 배치 적용 중간에 기존 정상 기능이 막힐 위험 — 배치마다 회귀 테스트 필수

#### `E11-F1-T5` [Task] [5/5] RLS 적용 QA 및 운영 DB 검증

- **Epic / Feature**: System / RLS 전면 적용 및 회귀 테스트
- **구현 상태**: 미구현
- **Priority / Module**: Critical / Database
- **목적**: 모든 배치 적용 완료 후, 실제 운영 Supabase에서 정책이 저장소 SQL과 일치하는지, 기존 정상 기능에 회귀가 없는지 최종 확인한다.
- **작업 범위**:
  - 운영 DB의 pg_policies를 저장소 정책과 diff
  - 기존 회원/매니저 핵심 시나리오(예약, 결제, 로그인) 수동 QA
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 운영 DB 정책이 저장소 SQL과 일치함이 확인된다.
  - 기존 핵심 기능에 회귀가 없음이 QA로 확인된다.
- **테스트 방법**: 운영 DB 정책 조회 + 핵심 시나리오 수동/자동 회귀 테스트 전체 실행(npm run test:all).
- **문서 업데이트 대상**: docs/DATABASE.md, docs/CHANGELOG.md
- **의존 작업**: [4/5] RLS 정책 단계적 적용
- **위험 요소**: 없음

#### `E11-F2-T1` [Docs] SQL 파일 적용 순서 정리

- **Epic / Feature**: System / 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리
- **구현 상태**: 미구현
- **Priority / Module**: High / Documentation
- **목적**: 73개 SQL 파일이 어떤 순서로 적용되어야 하는지(schema.sql → reservation_functions.sql → add_*/fix_*) 명확한 순서 목록이 없다(TODO P0-2 관련). 2026-07-31 의사결정: Prisma/Drizzle 등 마이그레이션 도구는 당분간 도입하지 않고 수동 SQL 방식을 유지한다.
- **작업 범위**:
  - 73개 SQL 파일을 의존관계 순서대로 나열한 목록 작성(파일명, 목적, 선행 파일)
- **제외 범위**:
  - 마이그레이션 도구 도입
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 신규 환경에 처음부터 적용할 때 따라야 할 정확한 파일 순서 목록이 docs/DATABASE.md에 존재한다.
- **테스트 방법**: 해당 없음(문서화 Task).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E11-F2-T2` [Docs] Migration history 정리(운영 적용 이력 ledger)

- **Epic / Feature**: System / 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리
- **구현 상태**: 미구현
- **Priority / Module**: High / Documentation
- **목적**: 73개 SQL 파일 중 실제로 운영 Supabase에 적용된 파일과 적용일 기록이 없다(TODO P0-2).
- **작업 범위**:
  - 각 파일의 운영 적용 여부/적용(추정)일을 기록하는 ledger 문서 신설
  - 향후 신규 SQL 파일 추가 시 ledger 갱신 절차를 docs/AI_PLAYBOOK.md에 명시
- **제외 범위**:
  - 마이그레이션 도구 도입
- **예상 수정 파일**: docs/DATABASE.md, docs/AI_PLAYBOOK.md
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - ledger 문서가 존재하고, 신규 SQL 추가 시 갱신 절차가 docs/AI_PLAYBOOK.md에 명시된다.
- **테스트 방법**: 해당 없음(문서화 Task).
- **문서 업데이트 대상**: docs/DATABASE.md, docs/AI_PLAYBOOK.md
- **의존 작업**: SQL 파일 적용 순서 정리
- **위험 요소**: 없음

#### `E11-F2-T3` [Docs] 운영 적용 체크리스트 작성

- **Epic / Feature**: System / 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Documentation
- **목적**: 신규 SQL 파일을 운영 Supabase SQL Editor에 적용할 때 따라야 할 절차(백업 확인, 적용 순서 확인, 적용 후 검증)가 문서화되어 있지 않다.
- **작업 범위**:
  - 적용 전/중/후 체크리스트 작성(백업, dry-run 가능 여부, 적용 후 스모크 테스트 항목)
- **예상 수정 파일**: docs/AI_PLAYBOOK.md
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 체크리스트가 docs/AI_PLAYBOOK.md에 존재한다.
- **테스트 방법**: 해당 없음(문서화 Task).
- **문서 업데이트 대상**: docs/AI_PLAYBOOK.md
- **의존 작업**: SQL 파일 적용 순서 정리
- **위험 요소**: 없음

#### `E11-F2-T4` [Docs] Migration rollback 기준 정리

- **Epic / Feature**: System / 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Documentation
- **목적**: 각 add_*/fix_*.sql 파일에 대한 rollback 방법(역순 SQL, 백업 복원 등)이 파일별로 정리되어 있지 않다.
- **작업 범위**:
  - 기존 마이그레이션 파일들을 유형별(컬럼 추가/함수 교체/데이터 백필 등)로 분류하고 유형별 표준 rollback 절차 정리
- **제외 범위**:
  - 기존 SQL 파일 자체 수정
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 마이그레이션 유형별 rollback 기준이 문서로 정리된다.
- **테스트 방법**: 해당 없음(문서화 Task).
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: SQL 파일 적용 순서 정리
- **위험 요소**: 없음

#### `E11-F2-T5` [Task] 중복 정의 핵심 RPC 22개 운영 최종본 확정

- **Epic / Feature**: System / 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리
- **구현 상태**: 검증 필요
- **Priority / Module**: High / Database
- **목적**: reserve_class, cancel_reservation, fulfill_order, manager_set_attendance 등 22개 함수가 여러 파일에서 반복 재정의되어 있어(reservation_functions.sql이 통합본으로 추정), 실제 운영 DB에 어떤 버전이 살아있는지 저장소만으로는 알 수 없다(TODO P0-3). trg_guard_center_status 등 중복 정의된 트리거도 함께 확정한다.
- **작업 범위**:
  - Supabase SQL Editor에서 pg_get_functiondef()로 각 함수 실제 본문 추출
  - 저장소의 최신 관련 파일과 diff
  - 불일치 발견 시 '운영 최종본'을 공식 지정하고 문서화
- **제외 범위**:
  - 불일치 발견 시 실제 코드 수정(별도 Task로 분리)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 22개 함수 + 중복 트리거 전부에 대해 운영 본문과 저장소 최신본의 일치/불일치 여부, 그리고 확정된 '운영 최종본' 파일명이 표로 정리된다.
- **테스트 방법**: 해당 없음(조사 Task).
- **문서 업데이트 대상**: docs/DATABASE.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 불일치 발견 시 예상보다 큰 수정 작업으로 이어질 수 있음

#### `E11-F3-T1` [Task] change_logs 사용처·FK·RLS 영향 조사 및 5종 레거시 테이블 최종 확정

- **Epic / Feature**: System / 레거시 테이블 5종 삭제 후보 최종 확정
- **구현 상태**: 검증 필요
- **Priority / Module**: Medium / Database
- **목적**: change_logs는 RLS 미적용 17개 테이블 중 하나이자 docs/DATABASE.md가 지목한 5개 레거시/불명확 테이블 중 하나이나, 별도 사용처 조사 Task가 없었다. 이 Task에서 change_logs를 직접 조사하고, product_passes/point_logs(포인트 원장 분석 Task)/reviews/chat_messages 각 투자 Task의 결론을 종합해 5종 전체의 삭제 후보 목록을 최종 확정한다. 2026-07-31 의사결정: 삭제 후보 확정까지만 수행, 실제 DROP은 범위 밖.
- **작업 범위**:
  - change_logs 코드/RPC 참조 여부 및 FK 영향 확인
  - product_passes/point_logs/reviews/chat_messages 각 조사 Task 결론 취합
  - 5종 테이블 전체에 대한 최종 삭제 후보 목록 및 근거 문서화
- **제외 범위**:
  - 실제 DROP 실행(별도 승인 필요 — 이 Task 범위 아님)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: change_logs, product_passes, point_logs, chat_messages, reviews
- **Acceptance Criteria**:
  - 5종 테이블 각각에 대해 사용처/FK/RPC/RLS 영향과 삭제 후보 여부가 하나의 표로 정리되어 docs/DATABASE.md에 반영된다.
  - 실제 DROP은 별도 승인이 필요하다는 점이 문서에 명시된다.
- **테스트 방법**: 코드 grep + 운영 DB 행 수/정책 확인.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: product_passes 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정, point_transactions / point_accounts / point_logs 역할·데이터흐름·중복·참조코드·RPC 분석, reviews 테이블 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정, chat_messages 사용처·FK·RLS 영향 조사 및 삭제 후보 확정
- **위험 요소**: 실제 DROP은 이 Task 완료 후 사용자 승인을 받아 별도 Task로 진행

#### `E11-F4-T1` [Refactor] Supabase 타입 자동 생성 도입

- **Epic / Feature**: System / 타입 안전성 확보 (any 사용 축소)
- **구현 상태**: 미구현
- **Priority / Module**: Medium / DevOps
- **목적**: 현재 프로젝트 전체에 as any/: any가 361건 존재하며 증가 추세다. supabase gen types typescript로 실제 스키마 기반 타입을 생성하면 신규 코드에서 any 의존을 없앨 수 있다.
- **작업 범위**:
  - supabase CLI로 타입 생성 스크립트 추가(package.json script)
  - 생성된 타입을 lib/supabaseClient.ts에 연결
- **제외 범위**:
  - 기존 361건의 any를 한 번에 제거하는 대규모 리팩터링(별도 승인 필요, rule 13 위반 소지)
- **예상 수정 파일**: lib/supabaseClient.ts, package.json
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - npm run gen:types 실행 시 스키마 기반 타입 파일이 생성된다.
  - 신규 작성 코드에서 해당 타입을 사용할 수 있다.
- **테스트 방법**: 타입 생성 후 tsc 빌드 통과 확인.
- **문서 업데이트 대상**: docs/DEVELOPMENT_RULES.md
- **의존 작업**: 없음
- **위험 요소**: 운영 Supabase 프로젝트 접근 권한(CLI 로그인) 필요

#### `E11-F4-T2` [Refactor] any 사용 최다 파일(lib/members.ts, lib/orders.ts, lib/classes.ts) 타입 개선

- **Epic / Feature**: System / 타입 안전성 확보 (any 사용 축소)
- **구현 상태**: 리팩터링 필요
- **Priority / Module**: Low / Frontend
- **목적**: 세 파일이 any 사용 상위 3개(각 37/27/26건)로, 생성된 Supabase 타입 도입 이후 우선 개선 대상이다.
- **작업 범위**:
  - 생성된 타입으로 any 캐스팅 대체
- **제외 범위**:
  - 나머지 51개 파일(향후 별도 Task로 순차 진행)
- **예상 수정 파일**: lib/members.ts, lib/orders.ts, lib/classes.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 세 파일의 any 사용 건수가 0에 가깝게 줄어든다.
  - npm run build 타입체크가 그대로 통과한다.
- **테스트 방법**: npm run build.
- **문서 업데이트 대상**: 없음
- **의존 작업**: Supabase 타입 자동 생성 도입
- **위험 요소**: 없음

#### `E11-F5-T1` [Task] eslint.config.js 신설

- **Epic / Feature**: System / 개발 환경/도구 정비
- **구현 상태**: 미구현
- **Priority / Module**: Medium / DevOps
- **목적**: npm run lint이 설정 파일 부재로 즉시 실패한다(CLAUDE.md에 이미 알려진 이슈로 기재됨).
- **작업 범위**:
  - Next.js 16 + TypeScript 기준 eslint.config.js 작성
- **제외 범위**:
  - 기존 코드 전체에 대한 대규모 lint 수정(별도 승인 필요)
- **예상 수정 파일**: eslint.config.js(신규)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - npm run lint이 에러 없이 실행된다(기존 위반 다수 발견 시 별도 Task로 분리).
- **테스트 방법**: npm run lint 실행.
- **문서 업데이트 대상**: CLAUDE.md, docs/DEVELOPMENT_RULES.md
- **의존 작업**: 없음
- **위험 요소**: 설정 도입 즉시 대량의 기존 위반이 드러날 수 있음 — 수정은 범위 밖

#### `E11-F5-T2` [Bug] Tailwind CSS 실제 적용 확인 및 연결

- **Epic / Feature**: System / 개발 환경/도구 정비
- **구현 상태**: 검증 필요
- **Priority / Module**: Medium / Frontend
- **목적**: Tailwind 패키지/설정은 있으나 globals.css에 @import "tailwindcss" 지시문이 없어 유틸리티 클래스가 죽은 코드일 가능성이 있다(TODO P2-8).
- **작업 범위**:
  - 실제 빌드 결과물에 Tailwind 클래스가 반영되는지 확인, 누락 시 import 추가
- **제외 범위**:
  - Tailwind로 전면 스타일 전환(별도 논의 필요)
- **예상 수정 파일**: app/globals.css
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - app/layout.tsx 등에서 사용 중인 Tailwind 클래스(flex, flex-col 등)가 실제로 스타일에 반영된다.
- **테스트 방법**: 빌드 후 브라우저에서 해당 클래스가 적용된 요소의 실제 스타일 확인.
- **문서 업데이트 대상**: docs/PROJECT_OVERVIEW.md, docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: import 추가 시 기존 커스텀 CSS와 클래스명이 충돌할 가능성

#### `E11-F5-T3` [Docs] .env.test.local.example 외 .env.local.example 신설

- **Epic / Feature**: System / 개발 환경/도구 정비
- **구현 상태**: 미구현
- **Priority / Module**: Low / Documentation
- **목적**: REQUIREMENTS/TODO 모두 .env.local.example 부재를 지적하고 있다(신규 개발자 온보딩 이슈).
- **작업 범위**:
  - 필요한 환경변수 이름만 포함한 예시 파일 작성(실제 값/비밀키 금지)
- **예상 수정 파일**: .env.local.example(신규)
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - .env.local.example이 저장소에 존재하고 실제 비밀값을 포함하지 않는다.
- **테스트 방법**: 파일 내용 검토.
- **문서 업데이트 대상**: docs/TODO.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E12-F1-T1` [Task] reservations/payments/memberships FK 인덱스 추가

- **Epic / Feature**: Infrastructure / 핵심 테이블 FK 인덱스 정비
- **구현 상태**: 미구현
- **Priority / Module**: High / Database
- **목적**: reservations.profile_id/membership_id, payments.profile_id/membership_id/product_pass_id/trainer_account_id, memberships 전체(4개 FK 컬럼 모두) 인덱스가 전혀 없다. reservations.profile_id는 RLS 정책(my_profile_ids())이 필터에 사용하는 컬럼이라 특히 성능에 직접 영향을 준다.
- **작업 범위**:
  - 각 컬럼에 create index (concurrently) 추가
- **제외 범위**:
  - 복합 인덱스 설계 최적화(운영 쿼리 패턴 분석 후 별도 진행 가능)
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: reservations, payments, memberships
- **DB 변경 사항**:
  - 필요한 Migration: add_core_table_indexes.sql
  - RLS 영향: 영향 없음
  - 기존 데이터 영향: 없음(인덱스 추가만)
  - Rollback 필요 여부: drop index로 원복 가능
- **Acceptance Criteria**:
  - reservations.profile_id 단독 조회가 인덱스를 사용한다(EXPLAIN으로 확인).
  - memberships.profile_id/center_id/product_id/trainer_account_id 각각 인덱스가 존재한다.
- **테스트 방법**: EXPLAIN ANALYZE로 인덱스 사용 여부 확인.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 운영 테이블 크기에 따라 create index concurrently 권장, 락 영향 최소화 필요

#### `E12-F1-T2` [Task] admin_action_logs/orders/notifications FK 인덱스 추가

- **Epic / Feature**: Infrastructure / 핵심 테이블 FK 인덱스 정비
- **구현 상태**: 미구현
- **Priority / Module**: Medium / Database
- **목적**: admin_action_logs.admin_id/member_profile_id/class_id/membership_id/source_unassigned_id, orders 전체(3개 FK), notifications.center_id에 인덱스가 없다.
- **작업 범위**:
  - 각 컬럼에 create index 추가
- **예상 수정 파일**: (신규 조사/문서 작업 — 특정 파일 없음)
- **관련 DB 테이블**: admin_action_logs, orders, notifications
- **DB 변경 사항**:
  - 필요한 Migration: add_core_table_indexes.sql (위 Task와 함께 하나의 파일로 처리 가능)
  - RLS 영향: 영향 없음
  - 기존 데이터 영향: 없음
  - Rollback 필요 여부: drop index
- **Acceptance Criteria**:
  - 나열된 각 FK 컬럼에 인덱스가 존재한다.
- **테스트 방법**: EXPLAIN ANALYZE로 확인.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E12-F2-T1` [Task] reset_test_data.sql / reset_class_products.sql / add_membership_rules.sql 전체삭제 구문 안전장치 문서화

- **Epic / Feature**: Infrastructure / 파괴적 SQL 스크립트 안전장치
- **구현 상태**: 부분 구현
- **Priority / Module**: Medium / Database
- **목적**: reset_test_data.sql(truncate cascade), reset_class_products.sql(delete no-where)은 이미 위험 경고가 문서화되어 있으나, add_membership_rules.sql:24-25의 delete from membership_schedule_rules where true(전체 삭제와 동일 효과)는 아직 별도 경고가 없다.
- **작업 범위**:
  - 세 스크립트를 별도 디렉터리(예: scripts/dangerous/)로 분리하거나 파일 상단에 통일된 경고 주석 형식 적용
  - docs/DATABASE.md에 add_membership_rules.sql 위험 표시 추가
- **제외 범위**:
  - 스크립트 로직 자체 변경
- **예상 수정 파일**: reset_test_data.sql, reset_class_products.sql, add_membership_rules.sql
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - 세 파일 모두 동일한 형식의 위험 경고 주석을 최상단에 갖는다.
  - docs/DATABASE.md의 위험 스크립트 목록에 add_membership_rules.sql이 추가된다.
- **테스트 방법**: 문서/파일 리뷰.
- **문서 업데이트 대상**: docs/DATABASE.md
- **의존 작업**: 없음
- **위험 요소**: 없음

#### `E12-F3-T1` [Refactor] 단위 테스트의 lib/supabaseClient.ts 초기화 결합 제거

- **Epic / Feature**: Infrastructure / CI/CD 안정화
- **구현 상태**: 리팩터링 필요
- **Priority / Module**: Low / Backend
- **목적**: tests/unit이 mock 없이 import하면 lib/supabaseClient.ts 초기화까지 실행되어, realtime-js의 네이티브 WebSocket 요구사항 때문에 Node 20에서 실패해 Node 22로 임시 우회한 상태다(TODO P2-10).
- **작업 범위**:
  - 단위 테스트 대상 모듈이 실제 Supabase 클라이언트를 초기화하지 않도록 의존성 주입 또는 모킹 경계 도입
- **제외 범위**:
  - 통합 테스트 구조 변경(이미 별도 config로 분리되어 있음)
- **예상 수정 파일**: lib/supabaseClient.ts, vitest.config.ts
- **관련 DB 테이블**: 없음
- **Acceptance Criteria**:
  - Node 20에서도 npm run test가 정상 통과한다.
- **테스트 방법**: Node 20 환경에서 npm run test 실행.
- **문서 업데이트 대상**: docs/TODO.md, .github/workflows/test.yml
- **의존 작업**: 없음
- **위험 요소**: 없음

## C. 생성 예정 Issue 요약

| 임시ID | Parent | Type | Title | Epic | Priority | Module | Status | 구현 상태 | 의존 작업 |
|---|---|---|---|---|---|---|---|---|---|
| E01 | - | Epic | [Epic] Authentication | Authentication | High | Documentation | Backlog | - | - |
| E01-F1 | E01 | Feature | 이메일 회원가입 및 로그인 | Authentication | High | Backend | Backlog | - | - |
| E01-F1-T1 | E01-F1 | Bug | 사업자등록증 업로드가 실제 Storage 저장 경로를 사용하는지 검증 | Authentication | High | Frontend | Backlog | 검증 필요 | - |
| E01-F1-T2 | E01-F1 | Refactor | 전역 인증 가드(미들웨어) 도입 | Authentication | High | Frontend | Backlog | 미구현 | - |
| E01-F2 | E01 | Feature | 소셜 로그인 방식 연결 및 해제 | Authentication | Medium | Frontend | Backlog | - | - |
| E01-F2-T1 | E01-F2 | Task | Kakao/Apple OAuth 운영 환경 설정 확인 및 문서화 | Authentication | Medium | DevOps | Backlog | 운영 설정 필요 | - |
| E01-F2-T2 | E01-F2 | Task | 네이버 소셜 로그인 연동 | Authentication | Low | Frontend | Backlog | 미구현 | - |
| E02 | - | Epic | [Epic] Organization & Multi Center | Organization & Multi Center | High | Documentation | Backlog | - | - |
| E02-F1 | E02 | Feature | 센터 등록 및 플랫폼 승인 처리 | Organization & Multi Center | High | Backend | Backlog | - | - |
| E02-F1-T1 | E02-F1 | Bug | /admin/categories, /admin/banners에 플랫폼 관리자 클라이언트 가드 추가 | Organization & Multi Center | High | Frontend | Backlog | 부분 구현 | - |
| E02-F2 | E02 | Feature | 센터 운영 정보 관리(소개/사진/연락처/위치) | Organization & Multi Center | Medium | Frontend | Backlog | - | - |
| E02-F2-T1 | E02-F2 | Task | center_contacts, schedule_templates 실사용 여부 확인 | Organization & Multi Center | Low | Backend | Backlog | 검증 필요 | - |
| E03 | - | Epic | [Epic] Member | Member | Medium | Documentation | Backlog | - | - |
| E03-F1 | E03 | Feature | 회원 목록 관리 및 CSV 내보내기 | Member | Medium | Frontend | Backlog | - | - |
| E03-F2 | E03 | Feature | 담당회원 및 상담고객(리드) 관리 | Member | Medium | Frontend | Backlog | - | - |
| E03-F2-T1 | E03-F2 | Task | 담당회원 배정 코드/DB 영향 분석 | Member | Medium | Backend | Backlog | 미구현 | - |
| E03-F2-T2 | E03-F2 | Task | 담당 관계 조인 테이블 생성 및 배정 UI 구현 | Member | Medium | Backend | Blocked | 미구현 | E03-F2-T1 |
| E03-F2-T3 | E03-F2 | Task | 상담고객(leads) CRUD 화면 구현 | Member | Medium | Frontend | Backlog | 미구현 | - |
| E04 | - | Epic | [Epic] Membership | Membership | High | Documentation | Backlog | - | - |
| E04-F1 | E04 | Feature | 수강권 발급 및 일시정지/재개 | Membership | High | Backend | Backlog | - | - |
| E04-F2 | E04 | Feature | 수강권 양도 | Membership | Low | Backend | Backlog | - | - |
| E04-F2-T1 | E04-F2 | Task | membership_transfers 기반 수강권 양도 플로우 구현 | Membership | Low | Backend | Backlog | 미구현 | - |
| E04-F3 | E04 | Feature | 포인트 원장 정합성 정리 | Membership | High | Database | Backlog | - | - |
| E04-F3-T1 | E04-F3 | Task | point_transactions / point_accounts / point_logs 역할·데이터흐름·중복·참조코드·RPC 분석 | Membership | High | Database | Backlog | 검증 필요 | - |
| E04-F3-T2 | E04-F3 | Task | product_passes 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정 | Membership | Low | Database | Backlog | 검증 필요 | - |
| E05 | - | Epic | [Epic] Reservation & Class | Reservation & Class | High | Documentation | Backlog | - | - |
| E05-F1 | E05 | Feature | 예약 생성과 중복 예약 방지 | Reservation & Class | High | Backend | Backlog | - | - |
| E05-F2 | E05 | Feature | 관리자 직접배치 및 무료 추가 배치 | Reservation & Class | High | Backend | Backlog | - | - |
| E05-F2-T1 | E05-F2 | Task | 용량초과(capacity-override) 2단계 확인 플로우 통합테스트 추가 | Reservation & Class | Medium | Backend | Backlog | 부분 구현 | - |
| E05-F3 | E05 | Feature | 예약 화면 공휴일 자동 반영 | Reservation & Class | Low | Backend | Backlog | - | - |
| E05-F3-T1 | E05-F3 | Bug | 예약 캘린더 공휴일을 하드코딩 대신 테이블/API 기반으로 전환 | Reservation & Class | Low | Frontend | Backlog | 미구현 | - |
| E05-F4 | E05 | Feature | 수업 유형 분류 및 복수 강사 배정 | Reservation & Class | Low | Frontend | Backlog | - | - |
| E05-F4-T1 | E05-F4 | Task | class_types / class_trainers 실사용 여부 확인 및 UI 연동 | Reservation & Class | Low | Frontend | Backlog | 검증 필요 | - |
| E06 | - | Epic | [Epic] Product & Payment | Product & Payment | Critical | Documentation | Backlog | - | - |
| E06-F1 | E06 | Feature | 실제 PG 결제 연동 준비 | Product & Payment | Critical | Backend | Backlog | - | - |
| E06-F1-T1 | E06-F1 | Task | Payment Provider 인터페이스 정리 | Product & Payment | High | Backend | Backlog | 검증 필요 | - |
| E06-F1-T2 | E06-F1 | Refactor | Mock Provider와 Production Provider 분리 | Product & Payment | Medium | Backend | Backlog | 리팩터링 필요 | E06-F1-T1 |
| E06-F1-T3 | E06-F1 | Task | Toss 웹훅 설계 | Product & Payment | High | Backend | Backlog | 미구현 | E06-F1-T1 |
| E06-F1-T4 | E06-F1 | Task | 결제 성공/실패/취소/환불 상태 모델 검토 | Product & Payment | Medium | Backend | Backlog | 검증 필요 | - |
| E06-F1-T5 | E06-F1 | Docs | 실 PG 연동 준비 체크리스트 작성 | Product & Payment | Medium | Documentation | Backlog | 미구현 | E06-F1-T3, E06-F1-T4 |
| E06-F1-T6 | E06-F1 | Task | TossPaymentProvider 실제 연동 구현 | Product & Payment | Critical | Backend | Blocked | 미구현 | E06-F1-T1, E06-F1-T2, E06-F1-T3, E06-F1-T4, E06-F1-T5 |
| E06-F1-T7 | E06-F1 | Refactor | fulfill_order()와 confirm_test_payment() 중복 로직 통합 설계 | Product & Payment | Medium | Backend | Backlog | 리팩터링 필요 | E06-F1-T6 |
| E06-F2 | E06 | Feature | 주문 취소 및 환불 정책 설정 | Product & Payment | Medium | Backend | Backlog | - | - |
| E06-F2-T1 | E06-F2 | Task | 미발급 주문 회원 셀프 취소 기능 | Product & Payment | Medium | Backend | Backlog | 미구현 | - |
| E06-F2-T2 | E06-F2 | Task | 센터별 환불 정책(기간/조건) 설정 기능 | Product & Payment | Low | Backend | Backlog | 미구현 | - |
| E07 | - | Epic | [Epic] Staff & Permission | Staff & Permission | High | Documentation | Backlog | - | - |
| E07-F1 | E07 | Feature | 센터별 직원 권한 관리 | Staff & Permission | High | Backend | Backlog | - | - |
| E07-F1-T1 | E07-F1 | Bug | /manager/staff/permissions에 오너 전용 클라이언트 가드 추가 | Staff & Permission | High | Frontend | Backlog | 부분 구현 | - |
| E07-F2 | E07 | Feature | 세부 권한 기반 UI 표시 제어 | Staff & Permission | Medium | Frontend | Backlog | - | - |
| E07-F2-T1 | E07-F2 | Task | 매니저 화면 전반에 effectiveState() 기반 메뉴/버튼 노출 제어 적용 | Staff & Permission | Medium | Frontend | Backlog | 미구현 | - |
| E07-F3 | E07 | Feature | 직원 급여 및 근무 스케줄 관리 | Staff & Permission | Low | Frontend | Backlog | - | - |
| E07-F3-T1 | E07-F3 | Task | staff_salaries / staff_schedules / schedule_memos 실사용 여부 확인 | Staff & Permission | Low | Backend | Backlog | 검증 필요 | - |
| E08 | - | Epic | [Epic] Notification | Notification | High | Documentation | Backlog | - | - |
| E08-F1 | E08 | Feature | 실시간 알림 인박스 | Notification | Medium | Frontend | Backlog | - | - |
| E08-F1-T1 | E08-F1 | Bug | /manager/inquiries, /manager/notifications에 fetchMyCenters() 가드 추가 | Notification | High | Frontend | Backlog | 부분 구현 | - |
| E08-F2 | E08 | Feature | 정기 알림 스케줄링(예약 임박, 수강권 만료) | Notification | High | Backend | Backlog | - | - |
| E08-F2-T1 | E08-F2 | Task | notify_upcoming_reservations()/notify_expiring_passes() 스케줄러 연결 | Notification | High | DevOps | Backlog | 미구현 | - |
| E08-F3 | E08 | Feature | 외부 푸시/알림톡 발송 연동 | Notification | Medium | Backend | Backlog | - | - |
| E08-F3-T1 | E08-F3 | Task | 알림 설정과 실제 발송 채널(FCM/알림톡) 연결 | Notification | Medium | Backend | Backlog | 미구현 | E08-F2-T1 |
| E09 | - | Epic | [Epic] Dashboard & Reports | Dashboard & Reports | Medium | Documentation | Backlog | - | - |
| E09-F1 | E09 | Feature | 매니저 대시보드 요약 통계 | Dashboard & Reports | Medium | Backend | Backlog | - | - |
| E09-F1-T1 | E09-F1 | Task | revenue_summary 뷰 실사용 여부 확인 | Dashboard & Reports | Low | Database | Backlog | 검증 필요 | - |
| E09-F2 | E09 | Feature | 관리자 활동기록 엑셀 내보내기 | Dashboard & Reports | Low | Frontend | Backlog | - | - |
| E09-F2-T1 | E09-F2 | Task | admin-assignments 화면에 CSV 내보내기 추가 | Dashboard & Reports | Low | Frontend | Backlog | 미구현 | - |
| E10 | - | Epic | [Epic] Community | Community | Low | Documentation | Backlog | - | - |
| E10-F1 | E10 | Feature | 레거시 테이블 정리(reviews, chat_messages) | Community | Medium | Database | Backlog | - | - |
| E10-F1-T1 | E10-F1 | Task | reviews 테이블 사용처·FK·RPC·RLS 영향 조사 및 삭제 후보 확정 | Community | Medium | Database | Backlog | 검증 필요 | - |
| E10-F1-T2 | E10-F1 | Bug | chat_messages 사용처·FK·RLS 영향 조사 및 삭제 후보 확정 | Community | Medium | Database | Backlog | 검증 필요 | - |
| E10-F2 | E10 | Feature | 커뮤니티 게시판 및 대회 정보 | Community | Low | Frontend | Backlog | - | - |
| E10-F2-T1 | E10-F2 | Task | 커뮤니티 게시판 MVP 구현 | Community | Low | Frontend | Backlog | 미구현 | - |
| E11 | - | Epic | [Epic] System | System | Critical | Documentation | Backlog | - | - |
| E11-F1 | E11 | Feature | RLS 전면 적용 및 회귀 테스트 | System | Critical | Database | Backlog | - | - |
| E11-F1-T1 | E11-F1 | Task | [1/5] RLS 미적용 17개 테이블 영향 분석 | System | Critical | Database | Backlog | 미구현 | - |
| E11-F1-T2 | E11-F1 | Task | [2/5] 테이블별 역할 기반 RLS 정책 설계 | System | Critical | Database | Backlog | 미구현 | E11-F1-T1 |
| E11-F1-T3 | E11-F1 | Task | [3/5] RLS 역할별 회귀 테스트 스위트 구축 | System | Critical | Backend | Backlog | 미구현 | E11-F1-T2 |
| E11-F1-T4 | E11-F1 | Task | [4/5] RLS 정책 단계적 적용 | System | Critical | Database | Backlog | 미구현 | E11-F1-T3 |
| E11-F1-T5 | E11-F1 | Task | [5/5] RLS 적용 QA 및 운영 DB 검증 | System | Critical | Database | Backlog | 미구현 | E11-F1-T4 |
| E11-F2 | E11 | Feature | 핵심 RPC/트리거 운영 최종본 검증 및 마이그레이션 이력 정리 | System | High | Database | Backlog | - | - |
| E11-F2-T1 | E11-F2 | Docs | SQL 파일 적용 순서 정리 | System | High | Documentation | Backlog | 미구현 | - |
| E11-F2-T2 | E11-F2 | Docs | Migration history 정리(운영 적용 이력 ledger) | System | High | Documentation | Backlog | 미구현 | E11-F2-T1 |
| E11-F2-T3 | E11-F2 | Docs | 운영 적용 체크리스트 작성 | System | Medium | Documentation | Backlog | 미구현 | E11-F2-T1 |
| E11-F2-T4 | E11-F2 | Docs | Migration rollback 기준 정리 | System | Medium | Documentation | Backlog | 미구현 | E11-F2-T1 |
| E11-F2-T5 | E11-F2 | Task | 중복 정의 핵심 RPC 22개 운영 최종본 확정 | System | High | Database | Backlog | 검증 필요 | - |
| E11-F3 | E11 | Feature | 레거시 테이블 5종 삭제 후보 최종 확정 | System | Medium | Database | Backlog | - | - |
| E11-F3-T1 | E11-F3 | Task | change_logs 사용처·FK·RLS 영향 조사 및 5종 레거시 테이블 최종 확정 | System | Medium | Database | Backlog | 검증 필요 | E04-F3-T2, E04-F3-T1, E10-F1-T1, E10-F1-T2 |
| E11-F4 | E11 | Feature | 타입 안전성 확보 (any 사용 축소) | System | Medium | Frontend | Backlog | - | - |
| E11-F4-T1 | E11-F4 | Refactor | Supabase 타입 자동 생성 도입 | System | Medium | DevOps | Backlog | 미구현 | - |
| E11-F4-T2 | E11-F4 | Refactor | any 사용 최다 파일(lib/members.ts, lib/orders.ts, lib/classes.ts) 타입 개선 | System | Low | Frontend | Backlog | 리팩터링 필요 | E11-F4-T1 |
| E11-F5 | E11 | Feature | 개발 환경/도구 정비 | System | Medium | DevOps | Backlog | - | - |
| E11-F5-T1 | E11-F5 | Task | eslint.config.js 신설 | System | Medium | DevOps | Backlog | 미구현 | - |
| E11-F5-T2 | E11-F5 | Bug | Tailwind CSS 실제 적용 확인 및 연결 | System | Medium | Frontend | Backlog | 검증 필요 | - |
| E11-F5-T3 | E11-F5 | Docs | .env.test.local.example 외 .env.local.example 신설 | System | Low | Documentation | Backlog | 미구현 | - |
| E12 | - | Epic | [Epic] Infrastructure | Infrastructure | High | Documentation | Backlog | - | - |
| E12-F1 | E12 | Feature | 핵심 테이블 FK 인덱스 정비 | Infrastructure | High | Database | Backlog | - | - |
| E12-F1-T1 | E12-F1 | Task | reservations/payments/memberships FK 인덱스 추가 | Infrastructure | High | Database | Backlog | 미구현 | - |
| E12-F1-T2 | E12-F1 | Task | admin_action_logs/orders/notifications FK 인덱스 추가 | Infrastructure | Medium | Database | Backlog | 미구현 | - |
| E12-F2 | E12 | Feature | 파괴적 SQL 스크립트 안전장치 | Infrastructure | Medium | Database | Backlog | - | - |
| E12-F2-T1 | E12-F2 | Task | reset_test_data.sql / reset_class_products.sql / add_membership_rules.sql 전체삭제 구문 안전장치 문서화 | Infrastructure | Medium | Database | Backlog | 부분 구현 | - |
| E12-F3 | E12 | Feature | CI/CD 안정화 | Infrastructure | Low | DevOps | Backlog | - | - |
| E12-F3-T1 | E12-F3 | Refactor | 단위 테스트의 lib/supabaseClient.ts 초기화 결합 제거 | Infrastructure | Low | Backend | Backlog | 리팩터링 필요 | - |

## D. 통계

- Epic 수: **12**
- Feature 수: **33**
- Task 수: **36**
- Bug 수: **7**
- Refactor 수: **6**
- Docs 수: **6**
- 전체 생성 예정 Issue 수(Epic 포함): **100**

**Priority별 개수**
- Critical: 8
- High: 23
- Medium: 36
- Low: 21

**Module별 개수**
- Backend: 30
- Frontend: 25
- Database: 21
- DevOps: 6
- Documentation: 6

**Epic별 Feature 개수**
- Authentication: 2
- Organization & Multi Center: 2
- Member: 2
- Membership: 3
- Reservation & Class: 4
- Product & Payment: 2
- Staff & Permission: 3
- Notification: 3
- Dashboard & Reports: 2
- Community: 2
- System: 5
- Infrastructure: 3

## E. 실제 생성 전에 확인이 필요한 질문

1. **RLS 미적용 17개 테이블(E12-F1-T1)을 Critical/최우선으로 처리하는 데 동의하시나요?** 개인정보 성격의 컬럼(`leads`, `contracts`, `terms` 등)이 포함되어 있어 저는 최우선으로 분류했지만, 실제 운영 데이터가 비어 있거나 미사용 확정이면 우선순위를 낮출 수 있습니다.
2. **`point_transactions`/`point_accounts`/`point_logs` 포인트 원장을 통합할지, 역할을 분리 유지할지** — 이 결정에 따라 Task 범위가 크게 달라집니다. 지금은 "정합성 검증 후 결정"으로 열어뒀습니다.
3. **커뮤니티 게시판/대회 정보 기능에 지금 착수할지, 계속 보류할지** — 스키마만 있고 코드가 전혀 없어 우선순위(Low)로만 등록했습니다. 제품 로드맵상 우선순위를 올려야 하면 알려주세요.
4. **담당회원 기능의 데이터 모델(담당자 배정을 어느 테이블/컬럼에 저장할지)이 아직 미확정**입니다 — 신규 컬럼(`center_members.assigned_staff_id` 등) 또는 별도 조인 테이블 중 선호 방식이 있나요?
5. **실PG(Toss/PortOne) 연동 착수 시점** — 사업자 등록 완료 여부에 따라 이 Epic의 Critical Task들을 지금 Backlog에 올릴지, 사업자 등록 완료 후에 올릴지 결정이 필요합니다.
6. **마이그레이션 관리 방식**: 현재처럼 수동 SQL 파일(`add_*.sql`/`fix_*.sql`)을 계속 쓸지, Prisma/Drizzle 등 마이그레이션 도구를 도입할지 — 이 백로그에는 도구 도입을 별도 Task로 넣지 않고 이 질문으로만 남겨뒀습니다.
7. **레거시 테이블 5개(`product_passes`, `point_logs`, `change_logs`, `chat_messages`, `reviews`) 삭제 여부** — 운영 데이터 확인 후 삭제 여부를 결정해야 하며, 삭제는 규칙상 반드시 별도 승인이 필요합니다. 이번 백로그에는 "정리/확정" Task까지만 포함했고 삭제 자체는 포함하지 않았습니다.
8. **Sprint 배정**: 규칙에 따라 이번 생성에서는 Sprint 필드를 비워두고 실제로 생성하지 않습니다. Sprint 1부터 채우고 싶은 항목이 있다면 별도로 알려주시면 생성 시 함께 반영하겠습니다.

## F. 생성 계획 (승인 후 진행 순서)

1. **Epic 12개 GitHub Issue 생성** (label: `epic`) — Project에 추가, Status=Backlog, 각 Epic/Priority 필드 입력.
2. **Feature 33개 GitHub Issue 생성**, 각 Issue 본문에 Epic 링크 + Acceptance Criteria 포함. GitHub Sub-issues 기능으로 상위 Epic Issue에 연결(Parent-child).
3. **Task/Bug/Refactor/Docs 43개 GitHub Issue 생성**, 각 Issue 본문에 `tmp/github-backlog-plan.json`의 `body` 그대로 사용. 상위 Feature Issue에 Sub-issue로 연결.
4. **Project(#1) 필드 입력**: 모든 신규 Issue를 Project에 추가한 뒤 Status=Backlog(전체 동일), Epic/Priority/Type/Module 필드를 JSON 값 그대로 입력. Sprint 필드는 비워둠(규칙 13).
5. **의존 관계 표시**: `dependencies` 배열에 있는 항목은 Issue 본문에 "Depends on #N" 형태로 상호 링크(GitHub이 자동으로 참조 추적).
6. **생성 순서**: 상위(Epic) → 중위(Feature) → 하위(Task) 순으로 생성해야 Sub-issue 연결 시 상위 Issue 번호가 이미 존재합니다.
7. 생성 완료 후 Issue 번호 매핑표(임시ID → 실제 GitHub Issue 번호)를 별도로 보고합니다.

**지금은 이 순서대로 아무것도 실행하지 않았습니다** — 사용자 승인 후에만 진행합니다.
