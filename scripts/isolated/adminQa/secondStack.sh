#!/usr/bin/env bash
# 관리자 QA 전용 "두 번째" 로컬 Supabase 스택 — 다른 작업이 쓰는 isolated-supabase 스택(project_id mwhabit-isolated, 포트 5442x)과 겹치지 않게
# project_id=mwhabit-adminqa, 포트 +100(5452x)으로 복제 설정을 만들어 띄운다. Edge 비밀로 알리고 프록시 주소를 "로컬 대체 서버"(host.docker.internal:54999)로 지정해
# 실제 외부 전송이 불가능하게 한다(스텁은 테스트가 직접 띄운다).  사용: secondStack.sh up|down|env
# ⚠ 다른 스택(supabase_*_mwhabit-isolated)은 건드리지 않는다. down 은 mwhabit-adminqa 만 멈춘다.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SRC=isolated-supabase; DST="${ADMINQA_STACK_DIR:-$HOME/.cache/mwhabit-adminqa-stack}"; PID=mwhabit-adminqa   # 저장소 밖(tsc·빌드가 복제본을 스캔하지 않게)
case "${1:-}" in
  up)
    rm -rf "$DST"; cp -R "$SRC" "$DST"; ln -sfn "$PWD/supabase/functions" "$DST/supabase/functions"   # 함수는 저장소의 것을 그대로(절대 경로 링크)
    python3 - "$DST/supabase/config.toml" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
s=s.replace('project_id = "mwhabit-isolated"','project_id = "mwhabit-adminqa"')
def bump(m): return f"{m.group(1)}{int(m.group(2))+100}"
s=re.sub(r'^((?:port|shadow_port|inspector_port|smtp_port|pop3_port) = )(\d+)', bump, s, flags=re.M)
s=s.replace('[edge_runtime.secrets]','[edge_runtime.secrets]\nALIGO_PROXY_URL = "http://host.docker.internal:54999"\nALIGO_PROXY_TOKEN = "local-stub-token-not-a-secret"',1)
open(p,'w').write(s)
PY
    supabase start --workdir "$DST" --exclude studio,imgproxy,vector,logflare,supavisor,postgres-meta ;;
  down) supabase stop --no-backup --workdir "$DST" ;;
  env)
    raw=$(supabase status --workdir "$DST" -o json 2>/dev/null); raw=${raw#*\{}; raw="{$raw"
    node -e '
      const s=JSON.parse(process.argv[1]);
      console.log(`ISOLATED_KIND=ephemeral-local-stack\nISOLATED_SUPABASE_URL=${s.API_URL}\nISOLATED_SUPABASE_PROJECT_REF=local:mwhabit-isolated\nISOLATED_SUPABASE_ANON_KEY=${s.ANON_KEY}\nISOLATED_SUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`)' "$raw" ;;
  *) echo "usage: $0 up|down|env"; exit 2 ;;
esac
