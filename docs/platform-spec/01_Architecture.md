# Architecture

## 1. 목표 구조

v1은 배포와 트랜잭션을 단순화한 **모듈형 모놀리스**를 기본안으로 한다. 각 모듈의 경계와 이벤트 계약을 명확히 하여 필요 시 독립 서비스로 분리할 수 있게 한다.

```text
Customer Web/App ─┐
Admin Console ────┼─> API / BFF ─> Application Modules ─> Relational DB
Platform Console ─┘       │              │
                          │              ├─> Cache / Rate Limit
                          │              ├─> Job Queue / Worker
                          │              ├─> Email / Push Provider
                          │              └─> Social IdP
                          └─> Observability / Audit
```

## 2. 모듈 경계

| 모듈 | 책임 |
|---|---|
| Identity | 가입, 로그인, 이메일 인증, 소셜 OAuth/OIDC, Account Linking |
| Session | Access/Refresh 토큰, 회전, 기기, 철회 |
| Organization | 센터, Membership, 역할, 초대 |
| Catalog | 서비스, 직원, 제공 가능 서비스 |
| Availability | 영업시간, 휴무, 직원 일정, 예약 가능 슬롯 계산 |
| Booking | 예약 생성·변경·취소, 상태 전이, 중복 방지 |
| Notification | 이메일/푸시 템플릿, 비동기 발송, 재시도 |
| Audit | 감사 이벤트, 보안 이벤트, 관리자 조회 |
| Platform Admin | 플랫폼 수준 센터/사용자 운영 |

모듈은 다른 모듈의 테이블을 직접 수정하지 않는다. 동일 프로세스 내 명시적 서비스 계약 또는 도메인 이벤트를 사용한다.

## 3. 요청 컨텍스트와 멀티센터

인증 미들웨어는 `actor_user_id`, `session_id`를 검증한다. 센터 범위 API는 경로의 `centerId`를 신뢰하지 않고 Membership을 조회해 `center_id`, 역할, 권한을 요청 컨텍스트에 주입한다.

- 고객의 공개 조회도 노출 가능한 센터/서비스만 반환한다.
- 플랫폼 관리자는 전역 권한을 별도 검사하며 자동으로 센터 회원으로 간주하지 않는다.
- 센터 전환은 토큰의 권한을 바꾸는 행위가 아니라 다음 요청의 대상 센터를 선택하는 UI 행위다.
- 저장소 계층은 센터 소유 엔티티 조회 시 `center_id`를 필수 인자로 받는다.
- DB Row Level Security 사용 여부와 무관하게 애플리케이션 검증을 유지한다.

## 4. 인증 구조

- 짧은 수명의 Access Token과 회전형 Refresh Token을 사용한다.
- 웹은 `HttpOnly`, `Secure`, 적절한 `SameSite` 쿠키를 기본안으로 한다.
- Refresh Token 원문은 저장하지 않고 해시와 토큰 패밀리만 저장한다.
- 소셜 로그인은 Authorization Code + PKCE, `state`, `nonce` 검증을 사용한다.
- 동일 이메일이라는 이유만으로 계정을 자동 병합하지 않는다. 기존 로그인 재인증 또는 검증된 linking ticket이 필요하다.
- 비밀번호 재설정 성공 시 기존 세션을 기본적으로 모두 철회하고 새 로그인으로 유도한다.

상세 정책은 [Security](./05_Security.md)를 따른다.

## 5. 예약 정합성

슬롯 조회는 힌트이며 예약 생성 시 서버가 다음을 같은 트랜잭션에서 재검증한다.

1. 센터·서비스·직원 활성 상태
2. 영업시간, 휴무, 직원 근무시간
3. 서비스 소요시간과 버퍼
4. 기존 예약과 시간 범위 충돌
5. 중복 요청 멱등성

지원 DB가 제공하는 배타 제약 또는 잠금으로 겹치는 활성 예약을 차단한다. 애플리케이션의 사전 조회만으로 동시성을 해결하지 않는다.

## 6. 비동기 처리

이메일, 푸시, 분석 이벤트는 트랜잭셔널 아웃박스를 거쳐 워커가 처리한다.

- 도메인 변경과 outbox 기록은 하나의 DB 트랜잭션이다.
- 소비자는 이벤트 ID로 중복 처리를 방지한다.
- 지수 백오프와 최대 재시도 후 Dead Letter Queue로 이동한다.
- 알림 실패는 예약 트랜잭션을 되돌리지 않는다.

## 7. 운영 및 확장

- 구조화 로그에 `request_id`, `actor_id`, `center_id`, `session_id`를 포함하되 토큰/비밀번호/민감정보는 제외한다.
- 핵심 지표: 로그인 성공률, 비밀번호 재설정, 초대 수락, 예약 성공/충돌, API 오류율·지연, 큐 적체.
- DB 자동 백업과 시점 복구를 사용하고 정기 복구 훈련을 한다.
- 무중단 호환 마이그레이션(Expand → Migrate → Contract)을 사용한다.
- 환경은 local/development, staging, production으로 분리하고 비밀값과 소셜 콜백 URL을 환경별로 격리한다.

## 8. 기술 선택 보류

웹/모바일 프레임워크, 서버 언어, 관계형 DB 제품, 클라우드, 이메일 및 소셜 공급자는 미확정이다. 선택 전까지 이 문서의 계약을 특정 벤더 기능에 종속시키지 않는다.

