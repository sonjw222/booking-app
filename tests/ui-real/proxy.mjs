// Supabase URL 모양(/rest/v1/*)을 로컬 PostgREST 로 전달하는 격리 QA용 프록시. /auth/v1/* 는 "세션 없음"으로 응답한다.
import http from "node:http";
const PORT = Number(process.env.PROXY_PORT ?? 3201), TARGET = Number(process.env.POSTGREST_PORT ?? 3202);
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS,HEAD,PATCH,DELETE", "access-control-expose-headers": "content-range" };
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.url.startsWith("/auth/v1/")) {
    // /auth/v1/user: Bearer 토큰이 authenticated 롤이면 그 sub 의 사용자를, 아니면 "세션 없음"(401)을 돌려준다(격리 QA 전용 — 서명 검증은 PostgREST 쪽이 한다).
    try {
      const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, ""); const pl = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString());
      if (req.url.startsWith("/auth/v1/user") && pl.role === "authenticated" && pl.sub) { res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify({ id: pl.sub, aud: "authenticated", role: "authenticated", email: "qa@example.com", app_metadata: { provider: "email" }, user_metadata: {} })); }
    } catch { /* 토큰 없음/형식 오류 */ }
    res.writeHead(401, { ...cors, "content-type": "application/json" }); return res.end('{"msg":"no session"}');
  }
  const m = req.url.match(/^\/rest\/v1\/(.*)$/);
  if (!m) { res.writeHead(404, cors); return res.end(); }
  const up = http.request({ host: "127.0.0.1", port: TARGET, path: "/" + m[1], method: req.method, headers: { ...req.headers, host: `127.0.0.1:${TARGET}` } }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res); });
  up.on("error", () => { res.writeHead(502, cors); res.end(); });
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`proxy ${PORT} -> ${TARGET}`));
