import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("iOS 왼쪽 가장자리 back 전용 (소스 계약)", () => {
  const plugin = readFileSync("ios/App/App/NavigationPolicyPlugin.swift", "utf8");
  const scene = readFileSync("ios/App/App/SceneDelegate.swift", "utf8");
  it("내장 양방향 제스처를 켜지 않는다", () => {
    expect(scene).not.toMatch(/allowsBackForwardNavigationGestures\s*=\s*true/);
    expect(plugin).not.toMatch(/allowsBackForwardNavigationGestures\s*=\s*(true|enabled)/);
    expect(plugin).toContain("allowsBackForwardNavigationGestures = false");
  });
  it("공개 API 왼쪽 가장자리 인식기가 웹 back 브리지를 호출한다", () => {
    expect(plugin).toContain("UIScreenEdgePanGestureRecognizer");
    expect(plugin).toContain("edges = .left");
    expect(plugin).toContain("window.__mwhabitBack");
  });
  it("NICEPAY Safe Area 처리를 유지한다", () => {
    expect(plugin).toContain("NicepaySafeAreaObserver");
    expect(scene).toContain("NicepaySafeAreaObserver");
  });
});
