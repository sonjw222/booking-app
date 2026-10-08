import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WebView localStorage(Supabase 세션 토큰)가 클라우드 백업/기기 이전에 실리지 않게 한다(보안 감사 P2, 2026-10-08).
const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const noComments = manifest.replace(/<!--[\s\S]*?-->/g, "");

describe("AndroidManifest — 백업", () => {
  it("allowBackup은 false", () => {
    expect(noComments).toMatch(/<application[^>]*android:allowBackup="false"/);
    expect(noComments).not.toMatch(/android:allowBackup="true"/);
  });
  it("백업을 되살리는 규칙(fullBackupContent/dataExtractionRules)이 따로 지정돼 있지 않다", () => {
    expect(noComments).not.toMatch(/android:fullBackupContent=|android:dataExtractionRules=/);
  });
  it("앱은 서버 URL을 로드하는 구조라 로컬 백업 의존이 없다(capacitor server.url)", () => {
    expect(readFileSync("capacitor.config.ts", "utf8")).toMatch(/url:\s*"https:\/\//);
  });
});
