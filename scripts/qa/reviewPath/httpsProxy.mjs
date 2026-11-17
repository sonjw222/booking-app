/*
  심사 경로 격리 브라우저 QA 전용 — 앱은 심사 인증창 origin 을 https://mwhabit.com 으로 고정 검사하므로, Chromium 의 host-resolver-rules 로 mwhabit.com:443 을 이 프록시(127.0.0.1:3217, 자체 서명 인증서)로 돌리고
  프록시는 로컬 Next(127.0.0.1:3216)로만 전달한다. 실제 mwhabit.com 으로는 아무 요청도 나가지 않는다. 사용: node httpsProxy.mjs <cert.pem> <key.pem>
*/
import https from "node:https"; import http from "node:http"; import { readFileSync } from "node:fs";
const [cert, key] = process.argv.slice(2);
https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const up = http.request({ host: "127.0.0.1", port: 3216, method: req.method, path: req.url, headers: { ...req.headers, host: "127.0.0.1:3216" } }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
  up.on("error", () => { res.writeHead(502); res.end("upstream down"); }); req.pipe(up);
}).listen(3217, "127.0.0.1", () => console.log("https proxy 3217 -> 3216"));
