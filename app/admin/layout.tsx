import AdminChrome from "../components/AdminChrome";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="admin-v3"><AdminChrome /><main className="admin-v3-content">{children}</main></div>;
}
