/**
 * 수강권 이름 "표시 전용" 정규화.
 * 같은 수강권이 횟수별 상품(예: "필라테스 1회", "필라테스 4회", "필라테스 8회")으로 나뉘어 있을 때
 * 목록에서 한 줄로 합쳐 보여준다. DB·가격·이용 자격·발급 로직은 건드리지 않는다(표시만).
 * 개월(예: "1개월", "3개월") 은 서로 다른 상품이므로 합치지 않는다.
 */

// 이름 끝의 횟수 표기: "8회", "8회권", "(8회)", "- 8회", "8 회" 등. 개월/일 표기는 매칭하지 않는다.
const TRAILING_COUNT = /[\s\-–·/]*[(\[]?\s*\d+\s*회\s*(?:권|이용권|패스)?\s*[)\]]?\s*$/;

/** "필라테스 8회권" → "필라테스". 횟수 표기가 없거나 제거하면 빈 문자열이 되면 원본(공백 정리)을 유지한다. */
export function stripPassCount(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const stripped = trimmed.replace(TRAILING_COUNT, "").trim();
  return stripped.length > 0 ? stripped : trimmed;
}

/** 표시용 이름 목록: 횟수만 다른 항목을 하나로 합치고 첫 등장 순서를 유지한다. */
export function mergePassNamesForDisplay(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (!raw) continue;
    const base = stripPassCount(raw);
    const key = base.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(base);
  }
  return out;
}
