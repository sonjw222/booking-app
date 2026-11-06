#!/usr/bin/env bash
# 심사 경로 QA 전용 "세 번째" 로컬 Supabase 스택 — 다른 작업이 쓰는 mwhabit-isolated(5442x)·mwhabit-adminqa(5452x)와 겹치지 않게 project_id=mwhabit-reviewpath, 포트 +200(5462x)으로 복제한다.
# 사용: stack.sh up|down|env.  ⚠ 다른 스택(supabase_*_mwhabit-isolated, *_adminqa)과 3100·터널은 건드리지 않는다. down 은 mwhabit-reviewpath 만 멈춘다.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SRC=isolated-supabase; DST="${REVIEWPATH_STACK_DIR:-$HOME/.cache/mwhabit-reviewpath-stack}"
case "${1:-}" in
  up)
    rm -rf "$DST"; cp -R "$SRC" "$DST"; ln -sfn "$PWD/supabase/functions" "$DST/supabase/functions" 2>/dev/null || true
    python3 - "$DST/supabase/config.toml" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
s=s.replace('project_id = "mwhabit-isolated"','project_id = "mwhabit-reviewpath"')
s=re.sub(r'^((?:port|shadow_port|inspector_port|smtp_port|pop3_port) = )(\d+)', lambda m: f"{m.group(1)}{int(m.group(2))+200}", s, flags=re.M)
open(p,'w').write(s)
PY
    supabase start --workdir "$DST" --exclude studio,imgproxy,vector,logflare,supavisor,postgres-meta ;;
  down) supabase stop --no-backup --workdir "$DST" ;;
  env)
    raw=$(supabase status --workdir "$DST" -o json 2>/dev/null); raw=${raw#*\{}; raw="{$raw"
    node -e '
      const s=JSON.parse(process.argv[1]);
      console.log(`ISOLATED_KIND=ephemeral-local-stack\nISOLATED_SUPABASE_URL=${s.API_URL}\nISOLATED_SUPABASE_PROJECT_REF=local:mwhabit-isolated\nISOLATED_SUPABASE_ANON_KEY=${s.ANON_KEY}\nISOLATED_SUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`);' "$raw" ;;
  *) echo "usage: $0 up|down|env"; exit 2 ;;
esac
