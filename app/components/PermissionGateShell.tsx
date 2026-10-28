import Link from "next/link";
import PermissionNotice from "./PermissionNotice";
import type { GateState } from "../../lib/permissionGate";
import type { ManagedCenter } from "../../lib/manager";

/* 권한이 없거나(denied)·확인 중(loading)·확인 실패(error)일 때 화면 본문 대신 그리는 껍데기. 센터가 여러 개면 다른 센터로 전환할 수 있게 칩을 남긴다. */
export default function PermissionGateShell({ title, backHref, state, what, centers, centerId, onSelectCenter, error }: {
  title: string; backHref: string; state: Exclude<GateState, "allowed">; what: string;
  centers?: ManagedCenter[]; centerId?: string | null; onSelectCenter?: (id: string) => void; error?: string | null;
}) {
  return (
    <div className="app-shell">
      <div className="back-header">
        <Link className="side" href={backHref} prefetch={false}>‹</Link>
        <div className="title">{title}</div>
        <div className="side" />
      </div>
      {centers && centers.length > 1 && onSelectCenter && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button aria-pressed={c.id === centerId} key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => onSelectCenter(c.id)}>{c.name}</button>
          ))}
        </div>
      )}
      {error && <div className="daylist-empty" role="alert" style={{ margin: "0 20px 10px" }}>{error}</div>}
      <PermissionNotice state={state} what={what} />
    </div>
  );
}
