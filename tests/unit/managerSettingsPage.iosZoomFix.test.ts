/*
  app/manager/settings/page.tsx ("예약 운영 설정") — iPhone 14 Pro 실기기 QA(2026-10-01):
  1) 숫자 input focus 시 viewport 자동 확대
  2) "예약대기 자동 예약 시간" 시/분 input이 영구 disabled라 눌러도 반응이 없음
  3) 숫자 input에 일반(한글) 키보드가 뜸
  세 root cause를 코드 텍스트로 검증한다(렌더링 도구 없음 — 이 프로젝트 기존 관례).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(__dirname, "../../app/manager/settings/page.tsx"), "utf-8");
const cssRaw = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
// 주석 안의 설명 문구(예: "이렇게는 안 했다")가 실제 규칙처럼 매칭되지 않도록 CSS 주석을 제거한 뒤 검사한다.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const layout = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf-8");

describe("A/B. 예약대기 자동 예약 시간 — 더 이상 영구 disabled 아님", () => {
  it("waitlistAutoHours/Minutes를 렌더하는 numInput 호출에 disabled=true가 없다", () => {
    const block = page.slice(page.indexOf("예약대기 자동 예약 시간"), page.indexOf("예약 대기 가능 횟수"));
    expect(block).toContain("numInput(s.waitlistAutoHours, (n) => up(\"waitlistAutoHours\", n))");
    expect(block).toContain("numInput(s.waitlistAutoMinutes, (n) => up(\"waitlistAutoMinutes\", n))");
    expect(block).not.toMatch(/waitlistAutoHours[^)]*\),\s*\d+,\s*true\)/);
    expect(block).not.toMatch(/waitlistAutoMinutes[^)]*\),\s*\d+,\s*true\)/);
  });

  it("같은 근본 원인(더 이상 유효하지 않은 '스케줄러 없음' 전제)이었던 당일 예약 변경 시간도 함께 풀렸다", () => {
    const block = page.slice(page.indexOf("당일 예약 변경 가능 시간"), page.indexOf("수업 폐강 시간"));
    expect(block).not.toMatch(/sameDayChangeHours[^)]*\),\s*\d+,\s*true\)/);
    expect(block).not.toMatch(/sameDayChangeMinutes[^)]*\),\s*\d+,\s*true\)/);
  });

  it("0 값은 여전히 유효하다 — min=0만 유지하고 0을 막는 새 validation이 없다(0=취소시간 적용의 의미 보존)", () => {
    expect(page).toContain("공석 발생 시, 시작 전까지 자동 예약 (0이면 취소시간 적용)");
    const numInputFn = page.slice(page.indexOf("const numInput ="), page.indexOf("// Track 4"));
    expect(numInputFn).toContain("min={0}");
    expect(numInputFn).not.toMatch(/min=\{1\}|val === 0|=== 0 ?\?/);
  });

  it("자동 폐강 시간 input(이미 토글로 조건부 활성화되던 기존 정상 필드)은 이번 수정 대상이 아니라 그대로다 — width 인자(56)는 기존 그대로, disabled 인자만 애초에 없었다(회귀 없음)", () => {
    const block = page.slice(page.indexOf("최소 인원 미달 시"), page.indexOf("예약대기 자동 예약 시간"));
    expect(block).toContain("numInput(s.autocancelHours, (n) => up(\"autocancelHours\", n), 56)");
    expect(block).toContain("numInput(s.autocancelMinutes, (n) => up(\"autocancelMinutes\", n), 56)");
    expect(block).not.toMatch(/autocancelHours[^)]*,\s*true\)/);
    expect(block).not.toMatch(/autocancelMinutes[^)]*,\s*true\)/);
  });
});

describe("C. 숫자 input이 iOS에서 숫자 키패드를 확정적으로 띄운다", () => {
  const numInputFn = page.slice(page.indexOf("const numInput ="), page.indexOf("const toggle ="));

  it("type=\"number\" + inputMode=\"numeric\" + pattern=\"[0-9]*\" 조합을 쓴다", () => {
    expect(numInputFn).toContain('type="number"');
    expect(numInputFn).toContain('inputMode="numeric"');
    expect(numInputFn).toContain('pattern="[0-9]*"');
  });

  it("이 페이지의 시간(time) input은 숫자 키패드를 억지로 적용하지 않는다(time input은 그대로)", () => {
    const timeInputs = page.match(/<input type="time"[^>]*>/g) ?? [];
    expect(timeInputs.length).toBeGreaterThan(0);
    for (const tag of timeInputs) expect(tag).not.toContain("inputMode");
  });

  it("값 파싱/검증 로직(음수 방지)은 그대로다 — 회귀 없음", () => {
    expect(numInputFn).toContain('Math.max(0, parseInt(e.target.value || "0", 10))');
  });
});

describe("D. iOS auto-zoom을 유발하는 15px 이하 font-size가 이 화면 control에 없다", () => {
  it(".set-num/.set-time의 font-size가 16px 이상이다(iOS 임계값)", () => {
    const numBlock = css.slice(css.indexOf("\n.set-num {"), css.indexOf("\n.set-num {") + 300);
    const timeBlock = css.slice(css.indexOf("\n.set-time {"), css.indexOf("\n.set-time {") + 300);
    const numSize = Number(numBlock.match(/font-size:\s*(\d+)px/)?.[1]);
    const timeSize = Number(timeBlock.match(/font-size:\s*(\d+)px/)?.[1]);
    expect(numSize).toBeGreaterThanOrEqual(16);
    expect(timeSize).toBeGreaterThanOrEqual(16);
  });

  it("13px(이전 버그 값)로 되돌아가지 않았다", () => {
    const numBlock = css.slice(css.indexOf("\n.set-num {"), css.indexOf("\n.set-num {") + 300);
    const timeBlock = css.slice(css.indexOf("\n.set-time {"), css.indexOf("\n.set-time {") + 300);
    expect(numBlock).not.toContain("font-size: 13px");
    expect(timeBlock).not.toContain("font-size: 13px");
  });

  it("이 수정은 .set-num/.set-time 두 클래스로만 한정된다 — 전역 input{font-size:16px} 규칙을 새로 추가하지 않았다", () => {
    expect(css).not.toMatch(/(?<![\w-])input\s*\{[^}]*font-size:\s*16px/); // 부정형 lookbehind로 .search-input 같은 기존 클래스 오탐 방지
  });
});

describe("E. viewport 확대 차단(user-scalable=no 등) 우회책을 쓰지 않았다", () => {
  it("app/layout.tsx의 viewport 설정에 userScalable/maximumScale이 없다(사용자 핀치줌 유지)", () => {
    expect(layout).not.toMatch(/userScalable/i);
    expect(layout).not.toMatch(/maximumScale/i);
  });

  it("globals.css에 실제 @viewport 규칙(줌 차단에 쓰이는 레거시 CSS at-rule)이 없다 — 위 두 코드 주석은 '이 방식을 쓰지 않았다'는 설명일 뿐 실제 사용이 아님", () => {
    expect(css).not.toMatch(/@viewport\s*\{/);
    expect(css).not.toMatch(/@-ms-viewport\s*\{/);
  });
});

describe("F. 자동 폐강 토글 ON 시 강제 focus가 없다(조건부 렌더만, autoFocus/focus() 없음)", () => {
  it("자동 폐강 관련 input에 autoFocus가 없다", () => {
    const block = page.slice(page.indexOf('"수업 폐강 시간"'), page.indexOf("예약대기 자동 예약 시간"));
    expect(block).not.toMatch(/autoFocus/);
    expect(block).not.toMatch(/\.focus\(\)/);
  });

  it("페이지 전체에 autoFocus/ref.focus()/scrollIntoView를 쓰는 곳이 없다(토글 ON이 강제 포커스를 유발하지 않음)", () => {
    expect(page).not.toMatch(/autoFocus/);
    expect(page).not.toMatch(/\.focus\(\)/);
    expect(page).not.toMatch(/scrollIntoView/);
  });

  it("자동 폐강 input들은 여전히 toggle 상태에 따른 조건부 렌더({s.autocancelEnabled && (...)})로만 나타난다(회귀 없음)", () => {
    expect(page).toContain("{s.autocancelEnabled && (");
  });
});

describe("G. 토글 ON/OFF에 따른 조건부 input state는 기존 구조를 유지한다", () => {
  it("당일 예약/일일 예약 제한/프라이빗 동시 수업 제한도 동일한 조건부 렌더 패턴", () => {
    expect(page).toContain("{s.allowSameDayBooking && (");
    expect(page).toContain("{s.dailyBookLimitEnabled && (");
    expect(page).toContain("{s.privateMaxConcurrentEnabled && (");
  });
});

describe("데이터 저장 흐름 — 별도 저장 버튼, per-keystroke DB 호출 없음(회귀 없음)", () => {
  it("onChange는 로컬 state만 갱신하고(up()), 실제 저장은 handleSave() 버튼에서만 호출된다", () => {
    const onChangeCount = (page.match(/onChange=\{.*?up\(/g) ?? []).length;
    expect(onChangeCount).toBeGreaterThan(5);
    expect(page).toContain("async function handleSave()");
    expect(page).toContain("await saveSettings(centerId, s);");
    // up()은 saveSettings를 직접 호출하지 않는다 — state만 바꾸고 dirty 플래그만 세운다.
    const upFn = page.slice(page.indexOf("function up<K"), page.indexOf("async function handleSave"));
    expect(upFn).not.toContain("saveSettings");
  });
});
