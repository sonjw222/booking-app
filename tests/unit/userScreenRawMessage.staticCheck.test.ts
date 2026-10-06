/*
  사용자 화면(app 아래 모든 tsx)에서 catch한 오류의 raw `.message`를 그대로 setError/toast/alert 등에 넘기지 않는지 정적으로 검증한다(2026-10-06).
  - 허용: toUserMessage(e[, 폴백]) 경유, 서버가 만든 결과 객체의 message(예: 결제 provider result.message, 요약 sum.message),
    login 화면의 자체 includes 매핑 후 toUserMessage 폴백.
  - 금지: setX(e.message), `text: e.message`, `"…: " + e.message`, `e.message ?? "…"` 같은 raw 노출.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toUserMessage } from "../../lib/userError";

const root = path.resolve(__dirname, "../../app");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(root).filter((f) => f.endsWith(".tsx"));
const V = "(?<![\\w.])(?:e|err|error|cause|ex|verifyErr)";   // 앞에 식별자/점이 붙은 scheduleState.message 같은 결과 객체는 제외

describe("사용자 화면 raw .message 노출 금지", () => {
  it("catch/에러 변수의 .message를 setter/toast/alert/객체 text·message 속성으로 직접 넘기지 않는다", () => {
    const bad: string[] = [];
    const pats = [
      new RegExp(`\\b(?:set[A-Za-z]*|showToast|alert|toast|onError|notify|fail)\\(\\s*${V}\\??\\.message\\s*\\)`),
      new RegExp(`\\b(?:text|message|msg|error):\\s*${V}\\??\\.message\\b`),
      new RegExp(`${V}\\??\\.message\\s*(?:\\?\\?|\\|\\|)\\s*"`),
      new RegExp(`"[^"\\n]*"\\s*\\+\\s*${V}\\??\\.message\\b`),
      new RegExp(`${V} instanceof Error \\? ${V}\\.message`),
    ];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => { if (!/^\s*(\/\/|\*|\/\*)/.test(l) && pats.some((p) => p.test(l))) bad.push(`${path.relative(root, f)}:${i + 1}: ${l.trim().slice(0, 100)}`); });
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
  it("toUserMessage를 쓰는 모든 파일은 lib/userError를 import한다(누락 시 빌드 오류 대신 정적 확인)", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/\btoUserMessage\(/.test(src)) expect(src, path.relative(root, f)).toMatch(/import\s*\{[^}]*toUserMessage[^}]*\}\s*from\s*"[./]+\/lib\/userError"/);
    }
  });
  it("toUserMessage 기존 동작 유지: 한글 메시지는 그대로, 영문 raw/DB 오류는 안전한 문구로", () => {
    expect(toUserMessage(new Error("이미 등록된 회원이에요"))).toBe("이미 등록된 회원이에요");
    expect(toUserMessage({ message: 'duplicate key value violates unique constraint "x"' }, "저장 실패")).toBe("저장 실패");
    expect(toUserMessage(new Error("TypeError: Failed to fetch"))).toBe("네트워크 연결을 확인한 후 다시 시도해 주세요.");
    expect(toUserMessage(new Error("JWT expired"))).toMatch(/문제가 발생했어요/);
    expect(toUserMessage(new Error("some english sdk error"), "폴백")).toBe("폴백");
    expect(toUserMessage(null, "폴백")).toBe("폴백");
    expect(toUserMessage("메시지를 불러오지 못했어요: 권한이 없어요")).toBe("메시지를 불러오지 못했어요: 권한이 없어요");
  });
});
