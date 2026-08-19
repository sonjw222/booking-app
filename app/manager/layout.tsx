import ManagerChrome from "../components/ManagerChrome";
import ManagerNav from "../components/ManagerNav";

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="manager-v3">
      <ManagerChrome />
      <main className="manager-v3-content">{children}</main>
      <ManagerNav />
    </div>
  );
}
