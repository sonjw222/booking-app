// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import CategoryIcon from "../../app/components/categoryIcons";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("renders tennis artwork with the shared themed surface and ink filter", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(CategoryIcon, { label: "테니스" })));
  expect(host.querySelector("img")).toBeNull();
  const artwork = host.querySelector("image")!;
  expect(artwork.getAttribute("href")).toBe("/icons/categories/tennis.png");
  expect(artwork.getAttribute("filter")).toMatch(/^url\(#.+-ink\)$/);
  expect(host.querySelector("svg > circle")!.getAttribute("fill")).toBe("var(--surface)");
  expect(host.querySelector("feFlood")!.getAttribute("flood-color")).toBe("currentColor");
  act(() => artwork.dispatchEvent(new Event("error")));
  expect(host.querySelector("image")).toBeNull();
  expect(host.querySelector("svg")).not.toBeNull();
  act(() => root.unmount());
});

it("keeps SVG filter references unique when the same artwork appears twice", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement("div", {},
    createElement(CategoryIcon, { label: "피겨스케이팅" }),
    createElement(CategoryIcon, { label: "피겨스케이팅" }))));
  const ids = [...host.querySelectorAll("[id]")].map(el => el.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const image of host.querySelectorAll("image")) {
    const ref = image.getAttribute("filter")!.slice(5, -1);
    expect(ids).toContain(ref);
    expect(image.getAttribute("href")).toBe("/icons/categories/skate.png");
  }
  act(() => root.unmount());
});

it("falls back on image failure without hiding a different category rendered later", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(CategoryIcon, { label: "피겨스케이팅" })));
  act(() => host.querySelector("image")!.dispatchEvent(new Event("error")));
  expect(host.querySelector("image")).toBeNull();
  expect(host.querySelector("svg")).not.toBeNull();
  act(() => root.render(createElement(CategoryIcon, { label: "수영" })));
  expect(host.querySelector("image")!.getAttribute("href")).toBe("/icons/categories/swim.png");
  act(() => root.unmount());
});
