#!/usr/bin/env bash
# 격리 QA 인프라(로컬 Docker: PostgreSQL 16 + PostgREST + 프록시). 운영/DEV 접속 없음. 사용: tests/ui-real/run.sh up|down
set -euo pipefail
cd "$(dirname "$0")"
SECRET="qa-secret-qa-secret-qa-secret-1234567890"
case "${1:-}" in
  up)
    docker network create qa-ui-net >/dev/null 2>&1 || true
    docker rm -f qa-ui-pg qa-ui-rest >/dev/null 2>&1 || true
    docker run -d --name qa-ui-pg --network qa-ui-net -e POSTGRES_PASSWORD=qa_local_only -e POSTGRES_DB=qa postgres:16-alpine >/dev/null
    until docker exec qa-ui-pg pg_isready -U postgres -d qa >/dev/null 2>&1; do sleep 1; done; sleep 3
    docker exec -i qa-ui-pg psql -v ON_ERROR_STOP=1 -U postgres -d qa < schema.sql >/dev/null
    docker exec -i qa-ui-pg psql -v ON_ERROR_STOP=1 -U postgres -d qa < seed.sql >/dev/null
    docker run -d --name qa-ui-rest --network qa-ui-net -p 127.0.0.1:3202:3000 -e PGRST_DB_URI="postgres://authenticator:qa_authenticator@qa-ui-pg:5432/qa" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" postgrest/postgrest:v12.2.3 >/dev/null
    for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:3202/" && break; sleep 1; done
    nohup node proxy.mjs > /tmp/qa-ui-proxy.log 2>&1 &
    echo $! > /tmp/qa-ui-proxy.pid
    echo ok ;;
  down)
    [ -f /tmp/qa-ui-proxy.pid ] && kill "$(cat /tmp/qa-ui-proxy.pid)" 2>/dev/null || true
    docker rm -f qa-ui-pg qa-ui-rest >/dev/null 2>&1 || true
    docker network rm qa-ui-net >/dev/null 2>&1 || true ;;
  token) node -e 'const c=require("crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const role=process.argv[2]||"anon",sub=process.argv[3];const h=b({alg:"HS256",typ:"JWT"}),p=b({role,iss:"qa",exp:4102444800,...(sub?{sub,aud:"authenticated"}:{})});console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[1]).update(h+"."+p).digest("base64url"))' "$SECRET" "${2:-anon}" "${3:-}" ;;
  *) echo "usage: run.sh up|down|token"; exit 1 ;;
esac
