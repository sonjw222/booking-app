import ManagerChrome from "../components/ManagerChrome";

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return <div className="manager-v3"><ManagerChrome /><main className="manager-v3-content">{children}</main></div>;
}
