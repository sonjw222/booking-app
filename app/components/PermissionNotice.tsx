import type { GateState } from "../../lib/permissionGate";

/* 권한 게이트 안내 — allowed 가 아닐 때 화면 본문 대신 보여 준다. loading/error 도 허용으로 보지 않는다. */
export default function PermissionNotice({ state, what }: { state: Exclude<GateState, "allowed">; what: string }) {
  if (state === "loading") return <div className="daylist-empty" role="status" aria-live="polite" style={{ paddingTop: 60 }}>권한을 확인하고 있어요…</div>;
  if (state === "error") return <div className="daylist-empty" role="alert" style={{ paddingTop: 60 }}>권한을 확인하지 못했어요. 새로고침하거나 잠시 후 다시 시도해 주세요.</div>;
  return <div className="daylist-empty" role="status" style={{ paddingTop: 60 }}>{what} 화면을 볼 권한이 없어요. 센터 오너에게 권한을 요청하세요.</div>;
}
