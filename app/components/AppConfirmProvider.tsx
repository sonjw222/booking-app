"use client";

import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";

type Request = { message: string; resolve: (value: boolean) => void };

declare global {
  // eslint-disable-next-line no-var
  var appConfirm: (message: string) => Promise<boolean>;
}

export default function AppConfirmProvider() {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Request[]>([]);
  useEffect(() => {
    globalThis.appConfirm = (message) => new Promise<boolean>((resolve) => {
      const next = { message, resolve };
      setRequest((current) => {
        if (current) { pending.current.push(next); return current; }
        return next;
      });
    });
    return () => { globalThis.appConfirm = async () => false; };
  }, []);
  function close(value: boolean) {
    request?.resolve(value);
    setRequest(pending.current.shift() ?? null);
  }
  const lines = request?.message.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
  return <ConfirmDialog open={!!request} title={lines[0] ?? "계속할까요?"}
    description={lines.slice(1).join(" · ") || undefined}
    confirmLabel={/승인|발급|복사/.test(request?.message ?? "") ? "계속하기" : "확인"}
    danger={/삭제|취소|환불|제외/.test(request?.message ?? "")}
    onCancel={() => close(false)} onConfirm={() => close(true)} />;
}
