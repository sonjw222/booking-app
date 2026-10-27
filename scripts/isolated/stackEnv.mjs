#!/usr/bin/env node
/*
  실행 중인 일회용 로컬 Supabase 스택(isolated-supabase)의 접속 값을 `supabase status` 에서 읽어 ISOLATED_* 환경변수 줄로 출력한다.
  출력의 키는 `supabase start` 가 로컬 스택마다 내는 공개 데모 키(iss=supabase-demo)이며 호스팅 프로젝트의 비밀이 아니다. 가드(isolatedTargetGuard)가 이 성질을 검사한다.
  사용: node scripts/isolated/stackEnv.mjs >> "$GITHUB_ENV"   (또는 > 파일)
*/
import { execFileSync } from "node:child_process";
const raw = execFileSync("supabase", ["status", "--workdir", "isolated-supabase", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const s = JSON.parse(raw.slice(raw.indexOf("{")));
const need = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]; for (const k of need) if (!s[k]) { console.error(`supabase status 에 ${k} 없음 — 스택이 실행 중인지 확인`); process.exit(1); }
console.log(`ISOLATED_KIND=ephemeral-local-stack\nISOLATED_SUPABASE_URL=${s.API_URL}\nISOLATED_SUPABASE_PROJECT_REF=local:mwhabit-isolated\nISOLATED_SUPABASE_ANON_KEY=${s.ANON_KEY}\nISOLATED_SUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`);
