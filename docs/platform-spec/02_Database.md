# Database

## 1. 공통 규칙

- 기본 키는 외부 추측이 어려운 UUID/ULID를 사용한다.
- 모든 시각은 UTC로 저장하고 UI에서 센터 시간대로 표시한다.
- 센터 소유 테이블은 `center_id NOT NULL`과 적절한 복합 인덱스를 가진다.
- 이메일은 표시 원문과 검색용 정규화 값을 분리한다. 정규화 규칙 변경 가능성을 고려한다.
- 개인정보 삭제는 법적 보존 대상과 운영 데이터를 분리해 익명화한다.
- 모든 테이블에 필요한 `created_at`, `updated_at`을 두며 중요 상태 변경은 감사 로그로 보완한다.

## 2. 핵심 엔티티

### Identity

| 테이블 | 핵심 필드 / 제약 |
|---|---|
| `users` | `id`, `email`, `normalized_email`, `email_verified_at`, `display_name`, `status`, `password_changed_at`; 활성 이메일 고유 |
| `password_credentials` | `user_id PK/FK`, `password_hash`, `failed_attempts`, `locked_until` |
| `auth_identities` | `id`, `user_id`, `provider`, `provider_subject`, `provider_email`, `provider_email_verified`; `UNIQUE(provider, provider_subject)` |
| `email_verification_tokens` | `user_id`, `token_hash`, `expires_at`, `used_at` |
| `password_reset_tokens` | `user_id`, `token_hash`, `expires_at`, `used_at`, `requested_ip_hash`; 1회 사용 |
| `account_link_tickets` | `user_id`, `provider`, `token_hash`, `expires_at`, `used_at`, `initiating_session_id` |

`users`는 사람을 나타내며 로그인 수단은 `password_credentials`와 `auth_identities`에 분리한다. 최소 하나의 사용 가능한 로그인 수단을 남기지 않는 unlink는 금지한다.

### Center와 권한

| 테이블 | 핵심 필드 / 제약 |
|---|---|
| `centers` | `id`, `name`, `slug`, `timezone`, `status`, `settings_json`; 활성 slug 고유 |
| `memberships` | `id`, `center_id`, `user_id`, `role`, `status`; `UNIQUE(center_id, user_id)` |
| `invitations` | `id`, `center_id`, `email`, `normalized_email`, `role`, `token_hash`, `expires_at`, `status`, `invited_by`, `accepted_by`; 동일 센터/이메일의 pending 1개 |
| `role_permissions` | 확장 시 역할-권한 매핑. v1 기본 역할은 코드/시드로 고정 |

기본 역할은 `center_owner`, `center_admin`, `staff`, `customer`다. `platform_admin`은 센터 역할과 분리된 전역 권한 저장소로 관리한다.

### 예약

| 테이블 | 핵심 필드 / 제약 |
|---|---|
| `services` | `id`, `center_id`, `name`, `duration_minutes`, `buffer_before`, `buffer_after`, `status` |
| `staff_profiles` | `id`, `center_id`, `user_id`, `status`; 센터 내 사용자 고유 |
| `staff_services` | `center_id`, `staff_id`, `service_id`; 복합 고유 |
| `business_hours` | `center_id`, `day_of_week`, `opens_at`, `closes_at`, `is_closed` |
| `staff_schedules` | `center_id`, `staff_id`, 반복/단일 근무 구간 |
| `time_off` | `center_id`, `staff_id?`, `starts_at`, `ends_at`, `reason` |
| `customers` | `id`, `center_id`, `user_id?`, 연락처와 동의 상태; 센터별 프로필 |
| `bookings` | `id`, `center_id`, `customer_id`, `service_id`, `staff_id`, `starts_at`, `ends_at`, `status`, `version`, 취소 정보 |
| `booking_status_history` | `booking_id`, 이전/새 상태, `actor_id`, `reason`, `created_at` |
| `idempotency_keys` | `scope`, `key_hash`, `request_hash`, `response_ref`, `expires_at`; scope/key 고유 |

활성 예약(`pending`, `confirmed`)의 직원별 시간 범위가 겹치지 않도록 DB 제약 또는 직렬화 가능한 잠금 전략을 적용한다.

### 세션과 감사

| 테이블 | 핵심 필드 / 제약 |
|---|---|
| `sessions` | `id`, `user_id`, `refresh_token_hash`, `token_family_id`, `device_id`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `revoke_reason`, IP/UA 요약 |
| `devices` | `id`, `user_id`, `device_name`, `platform`, `first_seen_at`, `last_seen_at`, `trusted_at?` |
| `audit_logs` | append-only: `id`, `occurred_at`, `actor_id`, `actor_type`, `center_id?`, `action`, `target_type/id`, 결과, 요청 메타, 변경 요약 |
| `outbox_events` | `id`, `type`, `aggregate_type/id`, `payload`, `created_at`, `published_at`, 재시도 정보 |

## 3. 삭제와 보존

- 센터/사용자는 기본적으로 soft delete 또는 상태 전이를 사용한다.
- Refresh Token, 인증·재설정·초대 토큰은 해시만 저장하고 만료 후 정리한다.
- 감사 로그 보존 기간은 법률/사업 정책 확정 후 환경 설정으로 관리한다.
- 계정 삭제 시 인증 식별자와 프로필 PII를 제거/익명화하되 예약 회계·분쟁에 필요한 최소 데이터는 정책에 따라 보존한다.
- 백업에서도 삭제가 최종 반영되는 최대 기간을 개인정보 처리방침에 공개한다.

## 4. 인덱스 기준

- 모든 FK에 인덱스
- `memberships(user_id, status)`, `memberships(center_id, role, status)`
- `bookings(center_id, starts_at)`, `bookings(center_id, staff_id, starts_at, ends_at)`
- `sessions(user_id, revoked_at, expires_at)`
- `invitations(center_id, normalized_email, status)`
- `audit_logs(center_id, occurred_at DESC)`, `audit_logs(actor_id, occurred_at DESC)`

## 5. 마이그레이션

마이그레이션은 버전 관리하고 운영 데이터에서 되돌릴 수 있는 계획을 포함한다. 파괴적 컬럼 삭제/이름 변경은 최소 두 번의 배포로 나누며, seed는 재실행 가능해야 한다.

