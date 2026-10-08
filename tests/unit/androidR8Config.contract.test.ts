import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Play Console "DEX 코드 최적화가 기준점 미만"(2027-02 기한): release에서 R8이 꺼져 있으면(minifyEnabled false) mapping/r8.json이 없어
// 난독화·최적화·축소 비율이 안 잡힌다. 설정이 되돌려지거나 규칙이 광범위해져 R8 효과가 사라지는 것을 막는다.
const gradle = readFileSync("android/app/build.gradle", "utf8");
const release = gradle.slice(gradle.indexOf("release {", gradle.indexOf("buildTypes")));
const rules = readFileSync("android/app/proguard-rules.pro", "utf8");
const activeRules = rules.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n");

describe("android release R8 설정", () => {
  it("release는 minify + shrinkResources + optimize 규칙을 쓴다", () => {
    expect(release).toMatch(/minifyEnabled true/);
    expect(release).toMatch(/shrinkResources true/);
    expect(release).toContain("getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'");
    expect(release).not.toMatch(/minifyEnabled false/);
  });
  it("앱 규칙에 R8을 무력화하는 광범위한 규칙이 없다", () => {
    for (const bad of [/-keep\s+class\s+\*\*/, /-keep\s+class\s+\*\s*\{/, /-keep\s+class\s+com\.mwhabit\.\*\*/, /-dontobfuscate/, /-dontshrink/, /-dontoptimize/, /-keepnames\s+class\s+\*\*/]) {
      expect(activeRules, String(bad)).not.toMatch(bad);
    }
  });
  it("크래시 복원용 줄 번호는 유지하고 원본 파일명만 숨긴다", () => {
    expect(activeRules).toContain("-keepattributes SourceFile,LineNumberTable");
    expect(activeRules).toContain("-renamesourcefileattribute SourceFile");
  });
});

// Android 15 edge-to-edge 경고(@capacitor/status-bar 플러그인 내부의 deprecated 호출)와 별개로, "앱 코드"가 deprecated 시스템 바 API를 직접 쓰지 않는다는 것을 고정한다.
describe("앱 직접 코드의 edge-to-edge", () => {
  it("앱 native/theme에 deprecated 시스템 바 API/속성이 없다", () => {
    const files = ["MainActivity", "GoogleSignInPlugin", "CalendarEventPlugin", "AppSettingsPlugin", "AndroidStatusBarBackgroundPlugin", "MwhabitMessagingService"]
      .map((n) => readFileSync(`android/app/src/main/java/com/mwhabit/app/${n}.java`, "utf8")).join("\n")
      + readFileSync("android/app/src/main/res/values/styles.xml", "utf8") + readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
    for (const api of ["setStatusBarColor", "setNavigationBarColor", "setNavigationBarDividerColor", "setDecorFitsSystemWindows", "layoutInDisplayCutoutMode", "systemUiVisibility", "screenOrientation", "resizeableActivity", "minAspectRatio", "maxAspectRatio"]) {
      expect(files, api).not.toContain(api);
    }
  });
  it("앱 JS는 StatusBar 색 변경 API를 호출하지 않는다(스타일만)", () => {
    const js = readFileSync("lib/nativeTheme.ts", "utf8");
    expect(js).toContain("StatusBar.setStyle(");
    expect(js).not.toMatch(/StatusBar\.(setBackgroundColor|setOverlaysWebView)/);
  });
});
