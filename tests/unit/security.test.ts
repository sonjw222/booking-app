// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { sanitizeRichText } from "../../lib/security";

describe("sanitizeRichText", () => {
  it("removes <script> tags", () => {
    const dirty = 'hello<script>alert(1)</script>world';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("alert(1)");
  });

  it("removes quoted onerror handlers", () => {
    const dirty = '<img src="x" onerror="alert(1)">';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/onerror/i);
  });

  it("removes unquoted onerror handlers", () => {
    const dirty = "<img src=x onerror=alert(1)>";
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/onerror/i);
  });

  it("removes unquoted onload handlers (e.g. <svg onload=...>)", () => {
    const dirty = "<svg onload=alert(1)>";
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/onload/i);
  });

  it("removes onclick handlers", () => {
    const dirty = '<div onclick="alert(1)">click me</div>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).toContain("click me");
  });

  it("removes javascript: URI schemes", () => {
    const dirty = '<a href="javascript:alert(1)">link</a>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/javascript:/i);
  });

  it("removes iframe/object/embed tags", () => {
    const dirty = '<iframe src="https://evil.example"></iframe>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toContain("<iframe");
  });

  it("preserves bold/italic/underline formatting produced by the editor", () => {
    const html = "<b>굵게</b> <i>기울임</i> <u>밑줄</u>";
    const clean = sanitizeRichText(html);
    expect(clean).toContain("<b>굵게</b>");
    expect(clean).toContain("<i>기울임</i>");
    expect(clean).toContain("<u>밑줄</u>");
  });

  it("preserves span with inline color style produced by the editor", () => {
    const html = '<span style="color: rgb(123, 45, 67)">글자색</span>';
    const clean = sanitizeRichText(html);
    expect(clean).toContain("글자색");
    expect(clean).toMatch(/<span[^>]*style="[^"]*color/);
  });

  it("preserves line breaks and plain div/br structure", () => {
    const html = "<div>줄1</div><div>줄2<br></div>";
    const clean = sanitizeRichText(html);
    expect(clean).toContain("줄1");
    expect(clean).toContain("줄2");
    expect(clean).toContain("<br");
  });

  it("returns empty string for empty/undefined-ish input", () => {
    expect(sanitizeRichText("")).toBe("");
  });

  it("upgrades legacy <font color> to the standard <span style=color> form", () => {
    const dirty = '<font color="#7B2D3B">색깔</font>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toContain("<font");
    expect(clean).toContain("색깔");
    expect(clean).toMatch(/<span style="color: #7B2D3B">색깔<\/span>/i);
  });

  it("preserves <span style=color> as-is", () => {
    const dirty = '<span style="color:#7B2D3B">색깔</span>';
    const clean = sanitizeRichText(dirty);
    expect(clean).toContain("색깔");
    expect(clean).toMatch(/style="color:\s*#7B2D3B"/i);
  });

  it("strips background:url(...) from style entirely", () => {
    const dirty = '<div style="background:url(https://evil.example/x)">hi</div>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/background/i);
    expect(clean).not.toMatch(/url\(/i);
    expect(clean).toContain("hi");
  });

  it("keeps only color when style mixes color with background:url(...)", () => {
    const dirty = '<div style="color:#ff0000;background:url(https://evil.example/x)">hi</div>';
    const clean = sanitizeRichText(dirty);
    expect(clean).toMatch(/style="color:\s*#ff0000"/i);
    expect(clean).not.toMatch(/background/i);
    expect(clean).not.toMatch(/url\(/i);
  });

  it("strips legacy CSS attack keywords (expression/behavior/-moz-binding) from style", () => {
    const cases = [
      '<div style="width:expression(alert(1))">a</div>',
      '<div style="behavior:url(xss.htc)">b</div>',
      '<div style="-moz-binding:url(xss.xml#xss)">c</div>',
    ];
    for (const dirty of cases) {
      const clean = sanitizeRichText(dirty);
      expect(clean).not.toMatch(/expression/i);
      expect(clean).not.toMatch(/behavior/i);
      expect(clean).not.toMatch(/-moz-binding/i);
      expect(clean).not.toMatch(/\.htc/i);
    }
  });

  it("removes data-* attributes even though ALLOWED_ATTR only lists style", () => {
    const dirty = '<div style="color:#ff0000" data-x="y">hi</div>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/data-x/i);
    expect(clean).toMatch(/style="color:\s*#ff0000"/i);
  });

  it("removes case-varied <ScRiPt> tags", () => {
    const dirty = "<ScRiPt>alert(1)</sCrIpT>";
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/script/i);
    expect(clean).not.toContain("alert(1)");
  });

  it("removes HTML-comment-based bypass attempts", () => {
    const dirty = "<!--><img src=x onerror=alert(1)>";
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/onerror/i);
    expect(clean).not.toContain("alert(1)");
  });

  it("removes <script> nested inside disallowed <svg>", () => {
    const dirty = "<svg><script>alert(1)</script></svg>";
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/<svg/i);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toContain("alert(1)");
  });

  // --- UI-001: 선택 영역 부분 글자 크기(font-size) ---

  it("preserves font-size:16px on its own", () => {
    const dirty = '<span style="font-size:16px">글자</span>';
    const clean = sanitizeRichText(dirty);
    expect(clean).toContain("글자");
    expect(clean).toMatch(/style="font-size:\s*16px"/i);
  });

  it("preserves every allowed toolbar size (12/14/16/18/20/24/28/32px)", () => {
    for (const px of [12, 14, 16, 18, 20, 24, 28, 32]) {
      const clean = sanitizeRichText(`<span style="font-size:${px}px">글자</span>`);
      expect(clean, `size ${px}px should be preserved`).toMatch(
        new RegExp(`style="font-size:\\s*${px}px"`, "i")
      );
    }
  });

  it("preserves both color and font-size together, output containing both", () => {
    const dirty = '<span style="color:#7B2D3B;font-size:18px">글자</span>';
    const clean = sanitizeRichText(dirty);
    expect(clean).toMatch(/color:\s*#7B2D3B/i);
    expect(clean).toMatch(/font-size:\s*18px/i);
  });

  it("preserves color and font-size regardless of declaration order in the input", () => {
    const orderA = sanitizeRichText('<span style="color:#7B2D3B;font-size:18px">a</span>');
    const orderB = sanitizeRichText('<span style="font-size:18px;color:#7B2D3B">b</span>');
    for (const clean of [orderA, orderB]) {
      expect(clean).toMatch(/color:\s*#7B2D3B/i);
      expect(clean).toMatch(/font-size:\s*18px/i);
    }
  });

  it("strips font-size above the allowed maximum (999px)", () => {
    const clean = sanitizeRichText('<span style="font-size:999px">글자</span>');
    expect(clean).not.toMatch(/font-size/i);
    expect(clean).toContain("글자");
  });

  it("strips font-size below the allowed minimum (7px)", () => {
    const clean = sanitizeRichText('<span style="font-size:7px">글자</span>');
    expect(clean).not.toMatch(/font-size/i);
    expect(clean).toContain("글자");
  });

  it("strips font-size with a non-px unit (16em)", () => {
    const clean = sanitizeRichText('<span style="font-size:16em">글자</span>');
    expect(clean).not.toMatch(/font-size/i);
    expect(clean).toContain("글자");
  });

  it("strips font-size using calc()", () => {
    const clean = sanitizeRichText('<span style="font-size:calc(10px + 1em)">글자</span>');
    expect(clean).not.toMatch(/font-size/i);
    expect(clean).not.toMatch(/calc\(/i);
    expect(clean).toContain("글자");
  });

  it("keeps only font-size when mixed with background:url(...)", () => {
    const dirty = '<div style="font-size:20px;background:url(https://evil.example/x)">hi</div>';
    const clean = sanitizeRichText(dirty);
    expect(clean).toMatch(/style="font-size:\s*20px"/i);
    expect(clean).not.toMatch(/background/i);
    expect(clean).not.toMatch(/url\(/i);
  });

  it("degrades a legacy <font size='N'> (pasted content) without guessing a px value", () => {
    const dirty = '<font size="4">옛글자</font>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toContain("<font");
    expect(clean).not.toMatch(/font-size/i);
    expect(clean).toContain("옛글자");
  });

  it("still promotes color on a legacy <font color size='N'> while dropping the size", () => {
    const dirty = '<font color="#7B2D3B" size="5">옛글자</font>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toContain("<font");
    expect(clean).toMatch(/color:\s*#7B2D3B/i);
    expect(clean).not.toMatch(/font-size/i);
    expect(clean).toContain("옛글자");
  });
});
