/*
  iOS 시뮬레이터 안전 영역(Safe Area) QA 하니스 — 운영·NICEPAY 와 무관한 로컬 페이지 2개. 앱(WKWebView) server.url 을 이 서버로 돌린 "QA 전용 번들"에서만 쓴다(저장소의 capacitor.config.ts 는 바꾸지 않는다).
    GET /     → 모하빗 화면 모의(host=localhost, viewport-fit=cover, env(safe-area-inset-top) 로 상단 여백을 스스로 처리)  + "결제창 열기" 링크
    GET /b    → NICEPAY 결제창 모의(host=127.0.0.1, viewport-fit 없음, safe area 미처리, 상단 고정 헤더 + 오른쪽 X 닫기 버튼)  + "앱으로 돌아가기" 링크(host=localhost)
    POST /log → 페이지가 측정값(JSON)을 보내면 파일(LOG_FILE)에 한 줄씩 저장
  사용: LOG_FILE=<경로> node harness.mjs [포트=3299]
*/
import http from "node:http"; import fs from "node:fs";
const PORT = Number(process.argv[2] ?? 3299), LOG = process.env.LOG_FILE ?? "/tmp/ios-safearea-log.jsonl", AUTO_GO = process.env.AUTO_GO === "1" || process.env.AUTO_GO === "2", AUTO_BACK = process.env.AUTO_GO === "2";   // AUTO_GO=2: 거기에 더해 결제창 모의가 9초 뒤 앱 화면(?returned=1)으로 돌아온다   // AUTO_GO=1: 모의 앱 화면이 2초 뒤 스스로 "결제창 열기" 링크로 이동(시뮬레이터에서 탭 없이 재현)
const probe = (name) => `<script>
(function(){function m(){var x=document.getElementById('x');var r=x?x.getBoundingClientRect():null;var h=document.getElementById('hdr');var hr=h?h.getBoundingClientRect():null;
var p=document.createElement('div');p.style.cssText='position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top);visibility:hidden';document.body.appendChild(p);var env=p.getBoundingClientRect().height;p.remove();
var cx=r?r.left+r.width/2:0,cy=r?r.top+r.height/2:0;var hit=document.elementFromPoint(cx,cy);
var d={page:'${name}',host:location.host,ua:navigator.userAgent.slice(0,40),innerW:innerWidth,innerH:innerHeight,vvTop:window.visualViewport&&visualViewport.offsetTop,vvH:window.visualViewport&&visualViewport.height,envTop:env,xTop:r&&r.top,xBottom:r&&r.bottom,hdrTop:hr&&hr.top,hitId:hit&&hit.id,t:Date.now()};
fetch('/log',{method:'POST',body:JSON.stringify(d)});}
addEventListener('load',function(){try{window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.SplashScreen&&Capacitor.Plugins.SplashScreen.hide()}catch(e){};setTimeout(m,600)});addEventListener('resize',function(){setTimeout(m,300)});})();
</script>`;
const A = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>모하빗 모의</title>
<style>body{margin:0;font:16px system-ui;background:#fbfbfa;color:#202124}header{padding:calc(env(safe-area-inset-top) + 12px) 16px 12px;background:#0a2545;color:#fff;font-weight:800}main{padding:16px}a{display:block;padding:14px;margin:12px 0;background:#0a2545;color:#fff;border-radius:12px;text-align:center;text-decoration:none}</style></head>
<body><header id="hdr">모하빗(모의) · 상단은 env(safe-area-inset-top)로 처리</header><main><p>이 화면은 기존 모하빗 화면처럼 안전 영역을 CSS 로 직접 처리합니다.</p><a id="go" href="http://127.0.0.1:${PORT}/b">결제창 열기(NICEPAY 모의로 이동)</a></main>${probe("A-app")}${AUTO_GO ? `<script>if(location.search.indexOf("returned=1")<0){setTimeout(function(){location.href="http://127.0.0.1:${PORT}/b"},2500)}</script>` : ""}</body></html>`;
const B = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,minimum-scale=1.0,maximum-scale=1.0,user-scalable=yes"><title>NICEPAY 모의</title>
<style>body{margin:0;font:16px system-ui;background:#fff;color:#111}#hdr{position:fixed;top:0;left:0;right:0;height:56px;background:#00479a;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 12px;box-sizing:border-box;font-weight:800}#x{width:44px;height:44px;border:0;border-radius:22px;background:#fff;color:#00479a;font-size:22px;font-weight:900}main{padding:72px 16px 16px}a{display:block;padding:14px;margin:12px 0;background:#eee;border-radius:12px;text-align:center;color:#111;text-decoration:none}</style></head>
<body><div id="hdr"><span>NICEPAY(모의) 모하빗 센터 이용권</span><button id="x" onclick="location.href='http://localhost:${PORT}/'">✕</button></div><main><p>결제수단 · 카드사 목록(모의). 이 페이지는 viewport-fit 이 없고 안전 영역을 처리하지 않습니다.</p><a id="back" href="http://localhost:${PORT}/">앱으로 돌아가기</a></main>${probe("B-nicepay-standin")}${AUTO_BACK ? `<script>setTimeout(function(){location.href="http://localhost:${PORT}/?returned=1"},9000)</script>` : ""}</body></html>`;
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/log") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { fs.appendFileSync(LOG, b + "\n"); res.writeHead(204).end(); }); return; }
  const u = new URL(req.url, "http://x"); const body = u.pathname === "/b" ? B : u.pathname === "/" ? A : null;
  if (!body) { res.writeHead(404).end("nf"); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(body);
}).listen(PORT, "127.0.0.1", () => console.log(`harness :${PORT}`));
