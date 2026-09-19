"use client";
import { useEffect } from "react";
const dirtyScopes = new Set<symbol>();
let confirming = false;
let allowedAnchor: HTMLAnchorElement | null = null;
export async function confirmDiscardChanges(): Promise<boolean> {
  if (!dirtyScopes.size) return true;
  if (confirming) return false;
  confirming = true;
  try { return await globalThis.appConfirm("저장하지 않은 내용이 있습니다. 이 화면을 떠날까요?"); }
  finally { confirming = false; }
}
function unload(event: BeforeUnloadEvent) {
  if (dirtyScopes.size) { event.preventDefault(); event.returnValue = ""; }
}
function click(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!anchor || anchor === allowedAnchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
  const url = new URL(anchor.href, location.href);
  if (url.pathname === location.pathname && url.search === location.search && url.origin === location.origin) return;
  if (!dirtyScopes.size) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void confirmDiscardChanges().then((ok) => {
    if (!ok || !anchor.isConnected) return;
    allowedAnchor = anchor;
    try { anchor.click(); } finally { allowedAnchor = null; }
  });
}
/** Explicit dirty state, not DOM heuristics. Does not modify history or native back. */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const token = Symbol();
    if (!dirtyScopes.size) { window.addEventListener("beforeunload", unload); document.addEventListener("click", click, true); }
    dirtyScopes.add(token);
    return () => {
      dirtyScopes.delete(token);
      if (!dirtyScopes.size) { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); }
    };
  }, [dirty]);
}
