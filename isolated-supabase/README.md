# isolated-supabase — live 테스트용 일회용 Supabase 스택 (#240)

`supabase start --workdir isolated-supabase` 가 띄우는 **로컬 Supabase 전체 스택**(Postgres 17 + GoTrue(Auth) + PostgREST + Storage + Realtime + Edge Runtime + Kong)이다.
CI 에서는 live E2E/Integration job 마다 러너 안에 하나씩 만들어지고 job 이 끝나면 `supabase stop --no-backup` 으로 사라진다. **공유 DEV·Production·호스팅 프로젝트·GitHub Secrets 를 쓰지 않는다.**

| 구성 | 위치 | 설명 |
|---|---|---|
| 설정 | `supabase/config.toml` | project_id `mwhabit-isolated`, 포트 5442x(다른 로컬 Supabase 와 충돌 방지), 이메일 확인 OFF·가입 허용(공유 DEV 요구사항과 동일), Auth 레이트리밋 상향, 버킷 3개, Edge 비밀 `PHONE_OTP_TEST_BYPASS_PREFIX=0100000` |
| 권한 초기화 | `supabase/migrations/20261026235900_reset_default_privileges.sql` | 로컬 이미지의 public 기본 권한(anon/authenticated 자동 부여)을 걷어내 baseline 의 객체별 ACL 이 그대로 재현되게 한다 |
| baseline | `supabase/migrations/20261027000000_baseline_public_schema.sql` | 공유 DEV `public` 스키마의 **스키마-only 덤프**(2026-10-27, 데이터 없음: INSERT/COPY 0건, JWT·이메일·URL·ref 0건 확인). 생성 방법: `scripts/isolated/dumpBaseline.md` |
| Storage 정책 | `supabase/migrations/20261027000001_baseline_storage_policies.sql` | `storage.objects` 정책 7개(구조만 읽기 전용으로 확인해 재작성) |
| 카탈로그 시드 | `supabase/seed.sql` | permissions 121 · subscription_plans 1 · service_categories 9 — **저장소 루트 SQL 의 INSERT 문장에서 생성**(`scripts/isolated/extractCatalogSeed.mjs`). 공유 DEV/운영 데이터를 복사하지 않았고, 권한 키 이름 집합이 공유 DEV 와 동일함을 이름만 대조해 확인했다 |
| Edge Functions | `supabase/functions` → `../../supabase/functions`(심볼릭 링크) | `send-phone-otp`, `check-signup-email`, `delete-account` 외 저장소의 함수 전부. ALIGO 등 외부 발송 자격증명이 이 환경에 없어 외부 SMS/알림톡/웹푸시가 나갈 수 없다(OTP 는 `0100000` 접두 번호만 우회 코드 반환) |

## 로컬에서 쓰기
```bash
supabase start --workdir isolated-supabase --exclude studio,imgproxy,vector,logflare,supavisor,postgres-meta
set -a; eval "$(node scripts/isolated/stackEnv.mjs)"; set +a      # ISOLATED_* (로컬 데모 키 — 비밀 아님)
node scripts/ci/isolatedTargetGuard.mjs                            # OK (kind=ephemeral-local-stack) 여야 한다
node scripts/isolated/bootstrapEphemeral.mjs --out .tmp/isolated.env   # 테스트 계정·센터·상품 생성(비밀번호는 실행마다 새로, 0600, 커밋 금지)
set -a; . .tmp/isolated.env; set +a; npm run test:integration
supabase stop --no-backup --workdir isolated-supabase               # 데이터까지 삭제
```
## 호스팅 Supabase 프로젝트와의 차이(숨기지 않는다)
- 같은 GoTrue/PostgREST/Storage/Realtime/Edge Runtime 이미지를 쓰지만 **호스팅 인프라가 아니다**: 네트워크 지연, 프로젝트 설정 UI/Management API, 백업, 대시보드 전용 설정, 호스팅 전용 확장은 재현하지 않는다. Edge Functions 는 로컬 Deno 런타임에서 돈다.
- 공유 DEV 에도 `pg_net`/`pg_cron` 이 없어(실측) 예약 발송 같은 DB 내 외부 호출 경로는 DEV 와 동일하게 존재하지 않는다.
- baseline 은 공유 DEV 의 **구조·권한**과 같다(`scripts/isolated/verifyBaselineParity.mjs` 로 함수 171·릴레이션 94·정책 200·컬럼 850·Storage 정책/버킷 차이 0 확인). 공유 DEV 의 **데이터**(회원·센터 등)는 가져오지 않았다.
