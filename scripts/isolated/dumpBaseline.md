# baseline 재생성 (공유 DEV 스키마-only 덤프, 데이터 없음)

공유 DEV(`mwhabit-ci-dev`)의 `public` 구조가 바뀌어 baseline 을 갱신해야 할 때만 한다. **Production 에는 접속하지 않는다**(이 저장소 워크트리의 Supabase CLI link 는 Production 이므로 `--linked` 를 `--project-ref` 없이 쓰지 말고 `supabase link` 를 바꾸지 않는다).

1. 빈 임시 디렉터리에서: `supabase db dump --project-ref jdglfvwdnkjnraqdxuuj --schema public -f dev_public_schema.sql` (`--data-only` 금지 — 스키마만).
2. 검사(하나라도 나오면 커밋하지 않는다): `grep -cE '^(INSERT INTO|COPY )'`, `grep -cE 'eyJ[A-Za-z0-9_-]{20,}'`, 이메일/`https?://`/프로젝트 ref(`bxntqgg…`, `jdglfvw…`) 문자열.
3. `isolated-supabase/supabase/migrations/20261027000000_baseline_public_schema.sql` 을 새 덤프로 교체하고 첫 줄 주석(날짜·검사 결과)을 갱신한다.
4. `supabase db reset --workdir isolated-supabase` 후 `node scripts/isolated/verifyBaselineParity.mjs` → "PARITY: 구조·권한 차이 0".
5. Storage 정책/버킷이 바뀌었으면 `20261027000001_baseline_storage_policies.sql`·`config.toml` 의 `[storage.buckets.*]` 를 맞춘다. 카탈로그는 `node scripts/isolated/extractCatalogSeed.mjs isolated-supabase/supabase/seed.sql`.
