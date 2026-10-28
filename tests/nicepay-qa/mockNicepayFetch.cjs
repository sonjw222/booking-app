/* eslint-disable @typescript-eslint/no-require-imports -- Node --require 로 주입하는 CommonJS 전처리 파일(앱 번들 아님) */
/* 격리 브라우저 QA 전용 — Next 서버 프로세스에 --require 로 주입하는 fetch 가로채기(앱 코드 아님, 운영 번들에 포함되지 않음).
   서버가 NICEPAY 승인/망취소 API(허용 호스트)를 호출하면 외부로 나가지 않고 이 모의 응답으로 대체한다. 실제 NICEPAY 호출 0건.
   모의 동작은 NICEPAY_QA_CONTROL(JSON 파일)로 제어, 호출 기록은 NICEPAY_QA_LOG(JSONL: 비밀값 없음 — 서명·키·AuthToken 원문은 기록하지 않음).
   가맹점 키(NICEPAY_MERCHANT_KEY)는 로컬 QA 용 무작위 가짜 값이며 응답 서명 생성에만 쓴다. */
const crypto = require("node:crypto"); const fs = require("node:fs");
const HOSTS = new Set(["dc1-api.nicepay.co.kr", "dc2-api.nicepay.co.kr", "pg-api.nicepay.co.kr", "webapi.nicepay.co.kr"]);
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const orig = globalThis.fetch;
const ctl = () => { try { return JSON.parse(fs.readFileSync(process.env.NICEPAY_QA_CONTROL, "utf8")); } catch { return {}; } };
const log = (o) => { try { fs.appendFileSync(process.env.NICEPAY_QA_LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch {} };
globalThis.fetch = async function patched(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (!HOSTS.has(host)) {
    if (/nicepay\.co\.kr/i.test(host)) { log({ kind: "BLOCKED_EXTERNAL", host }); throw new Error("QA: 허용되지 않은 NICEPAY 호스트"); }
    return orig(input, init);
  }
  const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  const c = ctl(); const key = process.env.NICEPAY_MERCHANT_KEY, mid = process.env.NICEPAY_MID;
  const moid = String(body.AuthToken || "").startsWith("QATOK_") ? String(body.AuthToken).slice(6) : "";
  const isNet = body.NetCancel === "1"; const kind = isNet ? "NETCANCEL" : "APPROVE";
  log({ kind, host, mid: body.MID === mid, amt: body.Amt, hasTid: !!body.TID, moid });
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
  if (isNet) { const mode = c.netcancel || "ok"; if (mode === "fail") return json({ ResultCode: "9999", ErrorCD: "9999" }); return json({ ResultCode: "2001", ResultMsg: "취소 성공", TID: body.TID, Amt: body.Amt, CancelDate: "20261031120000" }); }
  const mode = c.approve || "ok";
  if (mode === "timeout") throw new Error("QA: 응답 없음(네트워크 오류)");
  if (mode === "http500") return json({}, 502);
  if (mode === "reject") return json({ ResultCode: "3011", ResultMsg: "한도초과" });
  const amt = mode === "wrongamt" ? String(Number(body.Amt) + 1) : body.Amt;
  const sig = mode === "badsig" ? "0".repeat(64) : sha(body.TID + mid + amt + key);
  return json({ ResultCode: "3001", ResultMsg: "카드 승인 성공", Amt: amt, MID: mid, Moid: mode === "wrongmoid" ? "00000000-0000-4000-8000-000000000000" : moid, TID: body.TID, Signature: sig, AuthCode: "123456", AuthDate: "261031120000", PayMethod: "CARD" });
};
