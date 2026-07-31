# API

## 1. 계약

- 기본 형식: HTTPS JSON REST, `/api/v1`
- 인증: 보안 쿠키 또는 `Authorization: Bearer`
- 센터 범위: `/centers/{centerId}/...`
- 시각: ISO 8601 UTC, 센터 시간대는 IANA 이름
- 목록: cursor pagination (`data`, `page.next_cursor`, `page.has_more`)
- 쓰기 멱등성: `Idempotency-Key` 헤더
- 낙관적 동시성: 예약/설정 변경에 `version` 또는 `If-Match`
- 모든 응답에 추적 가능한 `request_id`

오류 형식:

```json
{
  "error": {
    "code": "BOOKING_SLOT_UNAVAILABLE",
    "message": "선택한 시간이 더 이상 예약 가능하지 않습니다.",
    "details": {},
    "request_id": "req_..."
  }
}
```

클라이언트는 메시지 문자열이 아니라 안정적인 `code`를 기준으로 분기한다. 권한이 없는 리소스는 정보 노출을 막기 위해 상황에 따라 `404`를 반환한다.

## 2. 인증 및 계정

| Method | Path | 설명 |
|---|---|---|
| POST | `/auth/sign-up` | 이메일 가입 및 인증 메일 발송 |
| POST | `/auth/email/verify` | 이메일 인증 토큰 사용 |
| POST | `/auth/sign-in` | 이메일/비밀번호 로그인 |
| POST | `/auth/social/{provider}/start` | PKCE/State 기반 인증 시작 |
| GET/POST | `/auth/social/{provider}/callback` | 공급자 콜백 완료 |
| POST | `/auth/token/refresh` | Refresh Token 회전 |
| POST | `/auth/sign-out` | 현재 세션 철회 |
| POST | `/auth/sign-out-all` | 현재 또는 전체 세션 철회(정책 옵션) |
| POST | `/auth/password/forgot` | 존재 여부를 숨긴 재설정 요청 |
| POST | `/auth/password/reset` | 1회용 토큰으로 비밀번호 변경 |
| GET | `/me` | 현재 사용자와 사용 가능한 센터 |
| PATCH | `/me` | 프로필 수정 |
| GET | `/me/identities` | 연결된 로그인 수단 |
| POST | `/me/identities/{provider}/link/start` | 재인증 후 연결 시작 |
| POST | `/me/identities/{provider}/link/complete` | 연결 완료 |
| DELETE | `/me/identities/{identityId}` | 로그인 수단 연결 해제 |
| GET | `/me/sessions` | 기기/세션 목록 |
| DELETE | `/me/sessions/{sessionId}` | 특정 세션 철회 |

비밀번호 찾기 응답은 계정 존재 여부와 관계없이 동일한 상태·문구·유사한 처리 시간을 사용한다. 소셜 콜백에서 이메일 충돌이 발견되면 자동 병합하지 않고 `ACCOUNT_LINK_REQUIRED`와 짧은 수명의 linking ticket을 반환한다.

## 3. 센터 및 관리자

| Method | Path | 권한 |
|---|---|---|
| POST | `/centers` | 플랫폼 정책상 허용된 사용자/Platform Admin |
| GET/PATCH | `/centers/{centerId}` | `center.read` / `center.update` |
| GET | `/centers/{centerId}/members` | `member.read` |
| PATCH | `/centers/{centerId}/members/{membershipId}` | `member.manage` |
| DELETE | `/centers/{centerId}/members/{membershipId}` | `member.manage` |
| POST | `/centers/{centerId}/invitations` | `invitation.create` |
| GET | `/centers/{centerId}/invitations` | `invitation.read` |
| POST | `/centers/{centerId}/invitations/{id}/resend` | `invitation.create` |
| DELETE | `/centers/{centerId}/invitations/{id}` | `invitation.revoke` |
| GET | `/invitations/{token}/preview` | 공개, 제한·마스킹 |
| POST | `/invitations/{token}/accept` | 로그인/가입 후 이메일 일치 |
| GET | `/centers/{centerId}/audit-logs` | `audit.read` |

초대 생성은 이메일, 역할, 만료기간을 받는다. 기존 pending 초대는 중복 생성하지 않고 재전송 흐름을 사용한다. 마지막 활성 Owner의 강등/삭제는 거부한다.

## 4. 서비스, 가용성, 예약

| Method | Path | 설명 |
|---|---|---|
| GET/POST | `/centers/{centerId}/services` | 서비스 조회/관리 |
| GET/POST | `/centers/{centerId}/staff` | 직원 조회/관리 |
| PUT | `/centers/{centerId}/business-hours` | 영업시간 저장 |
| POST/DELETE | `/centers/{centerId}/time-off...` | 휴무 관리 |
| GET | `/centers/{centerId}/availability` | service/staff/date 범위 슬롯 조회 |
| POST | `/centers/{centerId}/bookings` | 예약 생성; 멱등 키 필수 |
| GET | `/centers/{centerId}/bookings` | 권한에 맞는 예약 목록 |
| GET | `/centers/{centerId}/bookings/{id}` | 예약 상세 |
| PATCH | `/centers/{centerId}/bookings/{id}` | 시간/직원/메모 변경 |
| POST | `/centers/{centerId}/bookings/{id}/confirm` | 예약 확정 |
| POST | `/centers/{centerId}/bookings/{id}/cancel` | 취소 사유와 함께 취소 |
| POST | `/centers/{centerId}/bookings/{id}/complete` | 완료 |
| POST | `/centers/{centerId}/bookings/{id}/no-show` | 노쇼 |

예약 생성 성공은 동일 멱등 키 재요청에 같은 결과를 반환한다. 같은 키에 다른 payload가 오면 `IDEMPOTENCY_KEY_REUSED`를 반환한다.

## 5. 권한 매트릭스

| 권한 | Owner | Admin | Staff | Customer |
|---|---:|---:|---:|---:|
| 센터 설정/소유권 | ✓ | 제한 | - | - |
| 관리자 초대/권한 변경 | ✓ | 정책상 허용 | - | - |
| 직원 관리 | ✓ | ✓ | - | - |
| 서비스/영업시간 관리 | ✓ | ✓ | 제한 | - |
| 전체 예약 조회/관리 | ✓ | ✓ | 정책상 허용 | - |
| 본인 배정 예약 | ✓ | ✓ | ✓ | - |
| 본인 예약 | - | - | - | ✓ |
| 감사 로그 | ✓ | 정책상 허용 | - | - |

실제 검사는 역할명이 아니라 권한 문자열을 사용한다. Admin이 다른 Admin을 관리할 수 있는지 등 세부 정책은 센터 정책으로 완화할 수 있지만 Owner 보호 규칙은 우회할 수 없다.

## 6. Rate Limit과 웹훅

- 로그인, forgot/reset, 초대, 소셜 콜백은 IP+계정/이메일 기반 제한을 적용한다.
- `429`와 `Retry-After`를 반환한다.
- 외부 웹훅은 서명, timestamp, replay 방지를 검증하고 원문 payload의 최소 보존 원칙을 따른다.
- API 변경은 하위 호환을 우선하며 breaking change는 `/v2` 또는 승인된 마이그레이션 기간을 둔다.

