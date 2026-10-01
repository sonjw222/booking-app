/*
  app/manager/subscription/page.tsx — 플랫폼 구독 결제 QA(2026-10-01)에서 확인된 UI 문제 2개:
  1) "카드 등록과 첫 결제가 완료돼서 구독이 시작됐어요."가 빨간 error-toast로 표시됨
  2) "구독 취소" 버튼이 다른 set-row와 정렬 없이 왼쪽 아래에 단독으로 떠 있음
  결제/빌링 business logic(confirmCenterBilling, billing key, next_billing_date 등)은 건드리지
  않았다는 점도 함께 확인한다. 렌더링 도구 없이 소스 텍스트로 검증(이 프로젝트 기존 관례).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/manager/subscription/page.tsx"), "utf-8");
const cssRaw = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
// 설명 주석이 forbidden-pattern 검사에 오탐하지 않도록 JSX/코드 영역만 본다.
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function notice(type: string, message: string) {
  return `setBillingNotice({ type: "${type}", message: ${message} })`;
}

describe("1. 안내 메시지 종류 구분 (success / error / info)", () => {
  it("BillingNotice 타입이 success|error|info로 정의돼 있다", () => {
    expect(source).toContain('type BillingNotice = { type: "success" | "error" | "info"; message: string };');
    expect(source).toContain("useState<BillingNotice | null>(null)");
  });

  it("billing=success 처리 후 성공 메시지는 type: success다(error 아님)", () => {
    expect(code).toContain(notice("success", '"카드 등록과 첫 결제가 완료돼서 구독이 시작됐어요."'));
  });

  it("billing=fail → error", () => {
    expect(code).toContain(notice("error", '"카드 등록이 취소됐거나 실패했어요. 다시 시도해주세요."'));
  });

  it("authKey/customerKey 누락 → error", () => {
    expect(code).toContain(notice("error", '"카드 등록 응답이 올바르지 않아요. 다시 시도해주세요."'));
  });

  it("confirmCenterBilling 실패(catch) → error", () => {
    const catchBlock = code.slice(code.indexOf("await confirmCenterBilling("), code.indexOf("await confirmCenterBilling(") + 500);
    expect(catchBlock).toContain('setBillingNotice({ type: "error", message: e.message ?? "카드 등록 확정에 실패했어요" })');
  });

  it("처리 중 → info", () => {
    expect(code).toContain(notice("info", '"카드 등록을 확인하는 중이에요..."'));
  });

  it("문자열을 그대로 setBillingNotice에 넘기는 옛 방식이 남아있지 않다", () => {
    expect(code).not.toMatch(/setBillingNotice\(\s*["'`]/);
  });
});

describe("1. 렌더링 — 성공/info는 error-toast를 쓰지 않는다", () => {
  const render = code.slice(code.indexOf("billingNotice && (billingNotice.type"), code.indexOf("billingNotice && (billingNotice.type") + 900);

  it("error 타입만 error-toast(role=alert)로 그린다", () => {
    expect(render).toContain('billingNotice.type === "error" ?');
    expect(render).toContain('<div className="error-toast" role="alert">');
  });

  it("success/info는 status-toast(role=status)로 그리고 is-{type} 변형을 쓴다", () => {
    expect(render).toContain("className={`status-toast is-${billingNotice.type}`} role=\"status\"");
  });

  it("성공에는 체크 아이콘이 붙는다", () => {
    expect(render).toContain('billingNotice.type === "success" && <UiIcon name="check"');
  });

  it("두 갈래 모두 닫기(X) 버튼을 제공한다", () => {
    expect((render.match(/setBillingNotice\(null\)/g) ?? []).length).toBe(2);
  });

  it("billingNotice를 error-toast에 문자열로 직접 꽂는 옛 렌더가 없다", () => {
    expect(code).not.toContain('<div className="error-toast">{billingNotice}');
  });
});

describe("1. CSS — 새 색 체계 없이 기존 success/info 토큰만 재사용", () => {
  it(".status-toast 변형이 기존 --success/--info 토큰 쌍을 쓴다", () => {
    expect(css).toMatch(/\.status-toast\.is-success\s*\{[^}]*var\(--success-soft\)[^}]*var\(--success-line\)[^}]*var\(--success\)/);
    expect(css).toMatch(/\.status-toast\.is-info\s*\{[^}]*var\(--info-soft\)[^}]*var\(--info-line\)[^}]*var\(--info\)/);
  });

  it(".status-toast 규칙 블록에 하드코딩 색(#hex)이 없다", () => {
    const blocks = css.match(/\.status-toast[^{]*\{[^}]*\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("2. 구독 취소 UI — 정렬된 구독 관리 row", () => {
  const row = source.slice(source.indexOf('data-testid="subscription-manage-row"') - 120, source.indexOf('data-testid="subscription-manage-row"') + 1100);

  it("취소 버튼이 set-row sub-manage-row 안에 있고 왼쪽 label+설명 / 오른쪽 버튼 구조다", () => {
    expect(row).toContain('className="set-row sub-manage-row"');
    expect(row.indexOf("구독 관리")).toBeLessThan(row.indexOf("구독 취소</button>") === -1 ? row.indexOf("구독 취소\n") : row.indexOf("구독 취소"));
    expect(row).toContain("다음 결제일부터 자동결제를 중단할 수 있어요.");
  });

  it("단독으로 떠 있던 profile-del 버튼은 더 이상 쓰지 않는다", () => {
    expect(code).not.toContain("profile-del");
  });

  it("destructive 표시는 기존 quiet-action danger(테두리+danger 글자)를 쓰고 solid 빨강(danger-btn/primary)은 쓰지 않는다", () => {
    expect(row).toContain('className="quiet-action danger"');
    expect(row).not.toContain("danger-btn");
  });

  it("행은 active뿐 아니라 canceled가 아닌 모든 상태에서 보이고(기존 정책), canceled에서는 없다", () => {
    expect(code).toContain('subscription.status !== "canceled" && (');
  });

  it("실결제 연동 전(billingEnabled=false)에는 같은 행에서 비활성화 + 안내 문구(기존 동작 유지)", () => {
    expect(row).toContain("disabled={subBusy || !billingEnabled}");
    expect(row).toContain("구독 취소는 아직 지원하지 않아요");
  });

  it("좁은 화면에서 줄바꿈되고 터치 영역은 44px 이상이다", () => {
    expect(css).toMatch(/\.sub-manage-row\s*\{\s*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.sub-manage-row \.quiet-action\.danger\s*\{[^}]*min-height:\s*44px/);
  });
});

describe("3. 구독 취소 확인 문구", () => {
  const confirm = code.slice(code.indexOf("globalThis.appConfirm("), code.indexOf("globalThis.appConfirm(") + 260);

  it("이미 결제한 기간까지 이용 가능하다는 의미가 들어있다", () => {
    expect(confirm).toContain("이미 결제한 이용 기간까지는 계속 사용할 수 있어요");
  });

  it("다음 결제일부터 자동결제 중단이라는 의미가 들어있다", () => {
    expect(confirm).toContain("다음 결제일부터 자동결제가 중단돼요");
  });

  it("제목은 '구독을 취소할까요?'다(첫 줄이 dialog 제목, 취소 단어로 확인 버튼이 danger 처리됨)", () => {
    expect(confirm).toContain('"구독을 취소할까요?\\n');
  });

  it("appConfirm이 message만 받으므로(커스텀 label 미지원) API를 확장하지 않았다", () => {
    const provider = readFileSync(join(__dirname, "../../app/components/AppConfirmProvider.tsx"), "utf-8");
    expect(provider).toContain("var appConfirm: (message: string) => Promise<boolean>;");
    expect(confirm).not.toMatch(/appConfirm\([^)]*,[^)]*\)/);
  });
});

describe("4/5. 상태별 UI·결제 로직은 그대로(회귀 없음)", () => {
  it("past_due / payment_failed / pending_billing_setup 분기와 버튼 문구가 그대로다", () => {
    expect(code).toContain('subscription.status === "past_due" && (');
    expect(code).toContain("새 카드로 다시 등록");
    expect(code).toContain('subscription.status === "payment_failed" && (');
    expect(code).toContain("새 카드 등록하고 재개");
    expect(code).toContain('subscription.status === "pending_billing_setup" && (');
  });

  it("active 상태의 다음 결제일/등록 카드 표시 로직을 건드리지 않았다", () => {
    expect(code).toContain('subscription.status === "active" && subscription.nextBillingDate && (');
    expect(code).toContain("{subscription.nextBillingDate}");
    expect(code).toContain("subscription.cardLast4 && (");
  });

  it("빌링 처리 호출은 그대로다(confirmCenterBilling 인자, handleCancel의 centerCancelOwnSubscription)", () => {
    expect(code).toContain("await confirmCenterBilling(authKey, customerKey, qsCenterId);");
    expect(code).toContain("await centerCancelOwnSubscription(centerId);");
    expect(code).toContain("if (!centerId || !billingEnabled) return;");
  });

  it("빌링 관련 서버 파일은 이번 변경 대상이 아니다(billing 로직 import만 유지)", () => {
    expect(code).toContain('from "../../../lib/centerSubscription"');
  });
});
