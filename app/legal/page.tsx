/*
  약관 및 정책 — 이용약관/개인정보처리방침/사업자정보/환불·취소 정책 허브.
  전자상거래법상 사업자정보·약관은 로그인 없이도 접근 가능해야 해서 이 화면과
  하위 화면 전부 인증 체크 없이 공개.
*/

const ITEMS = [
  { href: "/legal/terms", label: "이용약관" },
  { href: "/legal/privacy", label: "개인정보처리방침" },
  { href: "/legal/business", label: "사업자 정보" },
  { href: "/legal/refund", label: "환불·취소 정책" },
];

export default function LegalHubPage() {
  return (
    <div className="app-shell settings-page-v2">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">약관 및 정책</div>
        <div className="side" />
      </div>

      {ITEMS.map((item) => (
        <a key={item.href} className="list-row" href={item.href}>
          <div className="left">{item.label}</div>
          <span className="chevron">›</span>
        </a>
      ))}
    </div>
  );
}
