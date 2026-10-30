import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "온라인 결제대행사 변경 사전 안내",
  description: "모하빗의 NICEPAY 결제 도입에 따른 이용약관·개인정보처리방침 변경 사전 안내.",
  alternates: { canonical: "/legal/notices/nicepay-20261030" },
};

/**
 * NICEPAY 변경 사전 안내 — 현재 약관/개인정보처리방침보다 먼저 공개되어야 한다.
 * 시행 예정일 2026-11-09: 공지 게시일(2026-10-30)로부터 7일 이상 확보.
 * 실제 배포일이 2026-11-02 이후로 밀리면 시행일을 다시 검토해야 한다.
 * 결제 기능/개인정보 전송 활성화가 아님. 관련 PR #254는 시행일 이후 별도 검증·병합.
 */
export default function NicepayAdvanceNoticePage() {
  return (
    <div className="app-shell settings-page-v2">
      <div className="back-header">
        <Link className="side" href="/legal" prefetch={false}>‹</Link>
        <div className="title">결제대행사 변경 안내</div>
        <div className="side" />
      </div>
      <div className="legal-page">
        <h1>온라인 결제대행사 도입 관련 사전 안내</h1>
        <div className="legal-updated">
          공지일: 2026년 10월 30일
          <br />
          약관·개인정보처리방침 변경 예정일: 2026년 11월 9일
        </div>
        <p>모하빗은 온라인 카드 결제 도입을 준비하고 있습니다. 이용약관과 개인정보처리방침의 결제 관련 내용을 아래와 같이 변경할 예정입니다.</p>

        <h2>변경 예정 내용</h2>
        <ul>
          <li>이용약관 제9조: 신규 온라인 카드 결제 서비스의 결제대행사로 NICEPAY를 안내합니다. 제공되는 결제수단은 실제 구매 화면에서 확인할 수 있습니다.</li>
          <li>환불·취소 정책 제4항: 신규 NICEPAY 거래와 과거 토스페이먼츠 거래의 결제 취소·환불 처리 구분을 명확히 합니다.</li>
          <li>개인정보처리방침: NICEPAY 결제 활성화 시 결제 승인·취소 처리의 위탁 관련 안내를 추가하며, 과거 토스페이먼츠 거래 처리는 유지합니다.</li>
        </ul>
        <p>기존 거래의 환불 조건이나 센터 직접결제 방식 자체를 변경하는 것은 아닙니다.</p>

        <h2>온라인 카드 결제 이용 가능 시점</h2>
        <p>현재 일반 회원용 NICEPAY 온라인 카드 결제는 비활성화되어 있습니다. 정책 변경 예정일은 카드 결제 서비스 개시일을 의미하지 않습니다. 이용 가능 시점은 연동 및 심사 완료 후 별도 안내하겠습니다.</p>

        <h2>현재 적용 중인 정책</h2>
        <p>
          변경 예정일까지는 기존에 게시된 <Link href="/legal/terms" prefetch={false}>이용약관</Link>,
          {" "}<Link href="/legal/privacy" prefetch={false}>개인정보처리방침</Link>,
          {" "}<Link href="/legal/refund" prefetch={false}>환불·취소 정책</Link>이 적용됩니다.
          새 정책의 확정 문구와 시행일은 적용 전에 다시 안내할 예정입니다.
        </p>
        <p>정확한 결제대행사 법인명과 위탁 처리 범위 등은 계약 정보 확인 후 공개 정책에 반영합니다.</p>
        <p>문의: <Link href="/legal/business" prefetch={false}>사업자 정보 및 고객센터</Link></p>
      </div>
    </div>
  );
}
