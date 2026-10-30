import { describe, expect, it } from "vitest";
import { checkNicepayEnvPresence, parseEnvFile, NICEPAY_V3_REQUIRED } from "../../scripts/ci/nicepayEnvPresence.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// MID·MerchantKey·토큰 시크릿은 값이 어디에도 출력되면 안 된다(존재 여부만).
const SECRET_SENTINELS = ["SENTINEL_MID_abc123", "SENTINEL_KEY_def456", "SENTINEL_TOKEN_ghi789"];
const env = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "sandbox", NICEPAY_RETURN_BASE_URL: "https://example.test", PAYMENT_RETURN_TOKEN_SECRET: SECRET_SENTINELS[2], NICEPAY_MID: SECRET_SENTINELS[0], NICEPAY_MERCHANT_KEY: SECRET_SENTINELS[1] };

describe("nicepayEnvPresence — 존재 여부만", () => {
  it("모두 있으면 allRequiredPresent, 하나라도 비면 false", () => {
    expect(checkNicepayEnvPresence(env).allRequiredPresent).toBe(true);
    for (const it of NICEPAY_V3_REQUIRED) expect(checkNicepayEnvPresence({ ...env, [it.name]: "" }).allRequiredPresent, it.name).toBe(false);
    expect(checkNicepayEnvPresence({}).allRequiredPresent).toBe(false);
  });
  it("결과 객체·CLI 출력 어디에도 비밀 값이 없다", () => {
    const json = JSON.stringify(checkNicepayEnvPresence(env));
    for (const s of SECRET_SENTINELS) expect(json).not.toContain(s);
    const f = path.join(os.tmpdir(), `np-env-${process.pid}.env`); fs.writeFileSync(f, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
    try {
      const out = execFileSync("node", [path.resolve(__dirname, "../../scripts/ci/nicepayEnvPresence.mjs"), "--env-file", f], { encoding: "utf8" });
      for (const s of SECRET_SENTINELS) expect(out).not.toContain(s);
      expect(out).toContain("NICEPAY_MERCHANT_KEY"); expect(out).toContain("present");
    } finally { fs.rmSync(f, { force: true }); }
  });
  it("env 파일 파서: 주석·따옴표·export 처리", () => {
    expect(parseEnvFile('# c\nexport A="1"\nB=2\n')).toEqual({ A: "1", B: "2" });
  });
});
