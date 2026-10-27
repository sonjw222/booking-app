// 회귀 시험 전용 preload: 프로세스가 시도한 모든 네트워크 요청(fetch/http/https/net/dns)을 세어 종료 시 NET_COUNT_FILE 에 기록한다. 요청 자체는 막지 않는다(막지 않고도 0 이어야 한다).
import fs from "node:fs"; import http from "node:http"; import https from "node:https"; import net from "node:net"; import dns from "node:dns";
let n = 0; const bump = () => { n++; };
const f = globalThis.fetch; globalThis.fetch = (...a) => { bump(); return f(...a); };
for (const m of [http, https]) { const r = m.request, g = m.get; m.request = (...a) => { bump(); return r.apply(m, a); }; m.get = (...a) => { bump(); return g.apply(m, a); }; }
const c = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...a) { bump(); return c.apply(this, a); };
const l = dns.lookup; dns.lookup = (...a) => { bump(); return l(...a); };
process.on("exit", () => { try { fs.writeFileSync(process.env.NET_COUNT_FILE, String(n)); } catch {} });
