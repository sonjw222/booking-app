/*
  사용자 입력 HTML(공지사항 등 서식 있는 리치텍스트) 저장 전 정화(sanitize)

  허용 범위(최소):
  - 태그: b, i, u, br, div, span, p (RichTextEditor가 실제로 생성하는 태그)
  - 속성: style 하나뿐이며, 그 안에서도 "color"와 "font-size" 선언만 허용한다
    (background/background-image/position/behavior/expression/-moz-binding 등
     그 외 모든 CSS 속성·값은 무조건 제거 — 배경 이미지 URL을 통한 외부 추적/
     유출 벡터를 차단하기 위함). font-size는 8px~72px 범위의 정수 px 값만
     허용하고(em/rem/%/calc()/음수/범위 밖 값은 전부 제거), color는 hex 또는
     rgb()/rgba() 함수 표기만 허용한다.
  - data-*, aria-* 속성은 DOMPurify 기본값이 허용 목록과 무관하게 통과시키므로
    ALLOW_DATA_ATTR / ALLOW_ARIA_ATTR을 명시적으로 꺼서 차단한다.

  레거시 <font color="..."> / <font size="..."> 처리:
  - execCommand('foreColor'/'fontSize', ...)는 styleWithCSS 없이 쓰면 각각
    <font color>, <font size="7">(RichTextEditor가 크기 선택 직후 실제 px로
    직접 치환)를 생성한다. 이 sanitizer는 그 정규화를 거치지 않고 들어온
    <font> 태그(붙여넣기 등)에 대해 방어적으로:
      - color 속성이 안전한 형식이면 <span style="color:..">로 승격
      - size 속성은 어떤 값이든 절대 px로 추측 변환하지 않고 그냈다 버린다
        (레거시 1~7 상대값은 실제 px 매핑표가 없어 신뢰할 수 없으므로,
         정보를 잃더라도 안전한 일반 span/텍스트로 강등)
    두 속성이 모두 없거나 안전하지 않으면 서식 없는 일반 span으로 강등된다.

  실행 환경:
  - 브라우저: window가 있으므로 그대로 동작
  - Vitest(jsdom): 테스트 환경의 window로 동작
  - 순수 Node(윈도우 없음): 이 함수는 DOM이 필요하므로, 조용히 깨지는 대신
    명확한 에러를 던진다(서버/Node에서 직접 호출하지 말라는 신호).
*/

import createDOMPurify from "dompurify";

type Purifier = ReturnType<typeof createDOMPurify>;

const ALLOWED_TAGS = ["b", "i", "u", "br", "div", "span", "p"];
const ALLOWED_ATTR = ["style"];

const MIN_FONT_SIZE_PX = 8;
const MAX_FONT_SIZE_PX = 72;

// #rgb / #rgba / #rrggbb / #rrggbbaa, 또는 rgb()/rgba() 함수 표기만 허용.
// url(), expression(), javascript: 등은 이 정규식에 절대 매치되지 않는다.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR_RE =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;

// 숫자 + "px"만(공백/소수점/다른 단위/calc() 등은 전부 불일치) 허용하고,
// 범위(8~72)는 파싱해서 별도로 검사한다.
const FONT_SIZE_PX_RE = /^(\d{1,3})px$/;

function isSafeColorValue(value: string): boolean {
  const v = value.trim();
  return HEX_COLOR_RE.test(v) || RGB_COLOR_RE.test(v);
}

function isSafeFontSizeValue(value: string): boolean {
  const m = FONT_SIZE_PX_RE.exec(value.trim());
  if (!m) return false;
  const n = Number(m[1]);
  return n >= MIN_FONT_SIZE_PX && n <= MAX_FONT_SIZE_PX;
}

// "color: red; font-size: 16px; background: url(x); ..." 형태의 style
// 문자열에서 안전한 color/font-size 선언만 뽑아 재조립한다(순서는 입력과
// 무관하게 항상 color, font-size 순으로 출력 — 존재하는 것만 포함).
// 유효한 선언이 하나도 없으면 null(= style 속성 자체를 제거).
function extractSafeStyleDeclaration(styleValue: string): string | null {
  const declarations = styleValue.split(";");
  let color: string | null = null;
  let fontSize: string | null = null;
  for (const decl of declarations) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop === "color" && !color && isSafeColorValue(value)) {
      color = value;
    } else if (prop === "font-size" && !fontSize && isSafeFontSizeValue(value)) {
      fontSize = value;
    }
  }
  const parts: string[] = [];
  if (color) parts.push(`color: ${color}`);
  if (fontSize) parts.push(`font-size: ${fontSize}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

function hasDomEnvironment(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

let cachedPurifier: Purifier | null = null;

function getPurifier(): Purifier {
  if (cachedPurifier) return cachedPurifier;
  if (!hasDomEnvironment()) {
    throw new Error(
      "sanitizeRichText()는 브라우저 또는 DOM(window/document)이 있는 환경에서만 " +
        "동작해요. 서버/Node 스크립트나 environment: \"node\" 테스트에서 직접 " +
        "호출하지 마세요(필요하면 jsdom 환경에서 호출하거나, 애초에 클라이언트 " +
        "쪽에서만 호출하도록 구조를 유지하세요)."
    );
  }
  const purify = createDOMPurify(window);

  // style 속성은 color/font-size 선언만 남기고 전부 제거한다(배경 이미지
  // URL을 통한 추적/유출, 레거시 IE 전용 CSS 공격(expression/behavior/
  // -moz-binding) 등을 값 형태와 무관하게 원천 차단).
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "style") return;
    const safe = extractSafeStyleDeclaration(data.attrValue);
    if (safe) {
      data.attrValue = safe;
    } else {
      data.keepAttr = false;
    }
  });

  cachedPurifier = purify;
  return purify;
}

// <font color="X" size="N">...</font> -> <span style="color: X">...</span>
// (X가 안전한 색상 값이 아니면 색상 없는 일반 span으로 강등). DOMPurify에
// 넘기기 전에 문자열 단계에서 미리 변환해, sanitizer가 <font> 자체를 허용
// 목록에 넣지 않고도 표준 형식(span+style)으로 승격할 수 있게 한다.
//
// size 속성은 의도적으로 절대 읽지 않는다 — 레거시 <font size="1~7">은
// 상대값이라 실제 px으로 신뢰성 있게 매핑할 방법이 없으므로, 크기 정보는
// 조용히 버리고 안전한 일반 span(또는 색상만 보존된 span)으로 강등한다.
// (RichTextEditor가 직접 생성하는 <font size="7">은 선택 직후, 실제 px 값을
// 아는 시점에 RichTextEditor 자신이 <span style="font-size:..">로 즉시
// 치환하므로 이 sanitizer에는 애초에 도달하지 않는다.)
function normalizeFontColorToSpan(html: string, doc: Document): string {
  const container = doc.createElement("div");
  container.innerHTML = html;
  const fonts = Array.from(container.querySelectorAll("font"));
  for (const f of fonts) {
    const span = doc.createElement("span");
    const color = f.getAttribute("color");
    if (color && isSafeColorValue(color)) {
      span.setAttribute("style", `color: ${color}`);
    }
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  }
  return container.innerHTML;
}

export function sanitizeRichText(html: string): string {
  if (!html) return "";
  const purify = getPurifier();
  const normalized = normalizeFontColorToSpan(html, window.document);
  return purify.sanitize(normalized, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

// 서식 HTML에서 태그를 제거한 실제 표시 글자만 뽑아낸다. 보안 sanitizer가
// 아니라 "빈 내용인지/글자 수가 몇 자인지" 같은 UI 검증 목적의 순수 텍스트
// 추출 유틸이다(예: "<p><b>좋아요</b></p>" -> "좋아요").
export function extractPlainText(html: string): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}
