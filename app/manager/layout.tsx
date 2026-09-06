import ManagerChrome from "../components/ManagerChrome";
import ManagerNav from "../components/ManagerNav";
import PendingApprovalBanner from "../components/PendingApprovalBanner";

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="manager-v3">
      <ManagerChrome />
      <PendingApprovalBanner />
      <main className="manager-v3-content">{children}</main>
      <ManagerNav />
    </div>
  );
}
