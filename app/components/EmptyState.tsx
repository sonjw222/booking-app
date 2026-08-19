import type { ReactNode } from "react";
import UiIcon, { type IconName } from "./UiIcon";

export default function EmptyState({ icon, title, description, action }: {
  icon: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return <div className="app-empty-state">
    <span className="app-empty-icon"><UiIcon name={icon} size={25} /></span>
    <b>{title}</b>
    {description && <p>{description}</p>}
    {action && <div className="app-empty-action">{action}</div>}
  </div>;
}
