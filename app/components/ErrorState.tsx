import type { ReactNode } from "react";
import UiIcon from "./UiIcon";

// UI 감사(P1-7) 대응 — 그동안 화면마다 에러 상태가 회색 텍스트 한 줄로 제각각이었고,
// 특히 /checkout(파라미터 없이 진입)·/manager/staff/permissions(권한 거부) 같은 화면은
// 복구 수단(뒤로가기/다시 시도 등) 없이 사용자를 막다른 길에 두었다(UX 감사 A-15, B-5).
// EmptyState와 같은 시각 언어를 쓰되 danger 톤 아이콘을 써서 "찾는 게 없음"과
// "뭔가 잘못됨"을 구분한다.
export default function ErrorState({ title, description, action }: {
  title: string;
  description?: string;
  action: ReactNode;
}) {
  return <div className="app-empty-state app-error-state">
    <span className="app-empty-icon app-error-icon"><UiIcon name="alert" size={25} /></span>
    <b>{title}</b>
    {description && <p>{description}</p>}
    <div className="app-empty-action">{action}</div>
  </div>;
}
