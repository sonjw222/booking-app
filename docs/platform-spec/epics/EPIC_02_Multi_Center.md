# EPIC 02 — Multi-Center

## 1. 목표

한 사용자가 여러 센터에 서로 다른 역할로 참여하고 빠르게 전환할 수 있게 하면서, 센터 데이터가 API·DB·캐시·검색·작업 큐·UI 어디에서도 섞이지 않게 한다.

## 2. 도메인 규칙

- Center는 테넌트 경계이며 고유 ID, slug, IANA timezone, 상태를 가진다.
- User는 전역 계정이고 Membership이 센터별 역할과 상태를 가진다.
- 동일 사용자에게 센터당 Membership은 하나다.
- 센터가 정지/보관되거나 Membership이 비활성화되면 센터 접근을 차단한다.
- 한 센터의 Customer/Staff 프로필은 다른 센터로 자동 공유되지 않는다.
- Platform Admin 권한은 Membership과 별도다.

## 3. 사용자 스토리와 수용 기준

### MCT-01 센터 생성

- 허용된 주체만 센터를 생성한다.
- 이름, 고유 slug, timezone을 필수로 받는다.
- 생성자에게 원자적으로 활성 Owner Membership을 부여한다.
- 중간 실패 시 센터만 또는 Membership만 남지 않는다.
- 생성 이벤트를 감사하고 기본 설정을 멱등하게 초기화한다.

### MCT-02 센터 목록과 전환

- `/me`는 활성 Membership 센터와 해당 역할/권한 요약만 반환한다.
- 선택한 센터는 클라이언트 선호로 저장할 수 있으나 권한의 근거가 아니다.
- 전환 시 이전 센터의 캐시, 선택 항목, 실시간 구독을 폐기한다.
- 접근 권한이 사라진 센터가 현재 선택이면 안전한 선택 화면으로 보낸다.

### MCT-03 데이터 격리

- 센터 소유 조회/변경에는 검증된 center context가 필수다.
- A센터 사용자가 B센터의 추측 가능한 ID를 사용해도 존재 여부나 데이터를 얻지 못한다.
- body/query의 `center_id` 위조로 범위를 바꿀 수 없다.
- export, 검색, 통계, 알림, 파일, audit에도 같은 경계를 적용한다.
- 자동화 테스트에 A/B 센터 교차 접근 매트릭스를 유지한다.

### MCT-04 센터 상태

- `active → suspended → active`와 `active/suspended → archived` 전이를 지원한다.
- suspended/archived 센터는 신규 예약과 일반 운영 접근을 차단한다.
- archived는 즉시 물리 삭제하지 않으며 보존 정책에 따라 처리한다.
- 상태 변경은 Platform Admin 권한, 사유, 최근 재인증, 감사 로그를 요구한다.

### MCT-05 센터별 설정

- timezone, 영업시간, 서비스, 직원, 휴무, 예약 정책을 센터 단위로 관리한다.
- timezone 변경은 기존 예약의 UTC 시각을 바꾸지 않으며 영향 경고를 표시한다.
- 설정 변경은 version을 사용해 덮어쓰기 충돌을 감지한다.

## 4. 격리 체크리스트

| 계층 | 규칙 |
|---|---|
| Route/API | 경로 center와 Membership/permission 검증 |
| Application | center context 없는 센터 use case 실행 금지 |
| Repository | `(center_id, id)` 조회, center 포함 unique/index |
| Database | FK/제약, 선택 시 RLS는 추가 방어 |
| Cache | center가 포함된 key/namespace |
| Search | center 필터 강제, 사용자가 제거 불가 |
| Queue/Event | payload에 center, consumer에서 다시 검증 |
| File | center별 prefix와 권한 있는 signed URL |
| Logs/Analytics | 최소화된 center 식별과 접근 통제 |
| UI | 전환 시 상태 초기화, 현재 센터 지속 표시 |

## 5. 운영 및 마이그레이션

- 센터별 데이터량, 오류율, 예약 충돌을 관측한다.
- 대형 센터를 고려해 모든 목록을 pagination하고 N+1을 피한다.
- 향후 shard를 고려해 center ID를 주요 접근 키로 유지한다.
- 기존 단일 센터 데이터가 생긴 후 전환할 경우 default center 생성, backfill, NOT NULL 적용, 격리 검증 순으로 마이그레이션한다.

## 6. 완료 기준

- Center/Membership 상태와 제약 구현
- 모든 센터 엔티티의 scope 검토
- A/B 센터 교차 API·DB·캐시·검색 테스트
- 센터 전환 E2E 및 접근성 검증
- 정지/보관/복구 runbook과 감사 이벤트 확인

## 7. 제외

센터 간 통합 리포트, 공유 고객 프로필, 프랜차이즈 계층, 센터 간 직원 이동 자동화는 후속 범위다.

