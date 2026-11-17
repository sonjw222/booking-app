import Link from "next/link";
import NicepaySubscriptionReview from "../../../components/NicepaySubscriptionReview";

export default function NicepaySubscriptionReviewPage() {
  return <div className="app-shell">
    <div className="back-header"><Link className="side" href="/manager/subscription" prefetch={false} aria-label="플랫폼 구독으로 돌아가기">‹</Link><div className="title">플랫폼 구독</div><div className="side" /></div>
    <NicepaySubscriptionReview />
  </div>;
}
