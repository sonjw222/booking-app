import AdminChrome from "../components/AdminChrome";
import AdminNav from "../components/AdminNav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="admin-v3"><AdminNav /><AdminChrome /><main className="admin-v3-content">{children}</main></div>;
}
