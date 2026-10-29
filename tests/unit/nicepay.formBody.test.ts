import { describe, expect, it } from "vitest";
import { parseUrlencodedBody, readNicepayForm } from "../../lib/payments/server/nicepay/formBody";

const bytes = (s: string) => new TextEncoder().encode(s);
describe("NICEPAY returnUrl 본문 파서 — EUC-KR 호환", () => {
  it("EUC-KR 퍼센트 인코딩('한글' = %C7%D1%B1%DB)을 charset 지정/미지정 모두에서 올바르게 푼다", () => {
    const body = bytes("Moid=abc&GoodsName=%C7%D1%B1%DB&AuthResultCode=0000");
    expect(parseUrlencodedBody(body, "euc-kr").GoodsName).toBe("한글");
    expect(parseUrlencodedBody(body, null).GoodsName).toBe("한글");   // charset 헤더가 없어도(유효한 UTF-8 이 아니므로) EUC-KR 로 해석
    expect(parseUrlencodedBody(body, null).Moid).toBe("abc");
  });
  it("UTF-8 본문('한글' = %ED%95%9C%EA%B8%80)과 ASCII 는 그대로", () => {
    expect(parseUrlencodedBody(bytes("GoodsName=%ED%95%9C%EA%B8%80"), null).GoodsName).toBe("한글");
    expect(parseUrlencodedBody(bytes("GoodsName=%ED%95%9C%EA%B8%80"), "utf-8").GoodsName).toBe("한글");
    expect(parseUrlencodedBody(bytes("A=1+2&B=x%20y"), null)).toEqual({ A: "1 2", B: "x y" });
  });
  it("중복 필드는 첫 값만(서명 필드 덮어쓰기 방지), 프로토타입 키 무시, 빈 키 무시", () => {
    const r = parseUrlencodedBody(bytes("Signature=good&Signature=evil&__proto__=x&=y&constructor=z"), null);
    expect(r.Signature).toBe("good"); expect(Object.keys(r)).toEqual(["Signature"]);
  });
  it("Content-Type 의 charset 을 존중하고, 너무 큰 본문은 거부(빈 객체)", async () => {
    const mk = (body: BodyInit, ct: string) => new Request("http://x.test/", { method: "POST", headers: { "content-type": ct }, body });
    expect((await readNicepayForm(mk("GoodsName=%C7%D1%B1%DB", "application/x-www-form-urlencoded; charset=EUC-KR"))).GoodsName).toBe("한글");
    expect(await readNicepayForm(mk("A=" + "x".repeat(70_000), "application/x-www-form-urlencoded"))).toEqual({});
    const fd = new FormData(); fd.set("Moid", "m1"); expect((await readNicepayForm(new Request("http://x.test/", { method: "POST", body: fd }))).Moid).toBe("m1");
  });
});
