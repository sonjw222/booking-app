export default function BusinessInfoPage() {
  return (
    <div className="app-shell settings-page-v2">
      <div className="back-header">
        <a className="side" href="/legal">‹</a>
        <div className="title">사업자 정보</div>
        <div className="side" />
      </div>

      <div className="legal-page">
        <div className="legal-note">
          통신판매업 신고번호는 신고 절차 진행 중입니다. 신고가 완료되는 대로 이 페이지를
          갱신할 예정입니다.
        </div>

        <table>
          <tbody>
            <tr><th>서비스명</th><td>모하빗</td></tr>
            <tr><th>상호</th><td>손장욱</td></tr>
            <tr><th>대표자</th><td>손장욱</td></tr>
            <tr><th>사업자등록번호</th><td>589-77-00451</td></tr>
            <tr><th>통신판매업 신고번호</th><td>신고 진행 중</td></tr>
            <tr><th>사업장 소재지</th><td>경기도 성남시 분당구 중앙공원로 20, 420동 702호</td></tr>
            <tr><th>고객센터</th><td>010-6505-8700</td></tr>
            <tr><th>이메일</th><td>sonjw222@naver.com</td></tr>
            <tr><th>호스팅 서비스</th><td>Vercel Inc. / Supabase Inc.</td></tr>
          </tbody>
        </table>

        <h2>통신판매중개자로서의 지위</h2>
        <p>
          모하빗은 회원과 센터(스튜디오·체육관 등 서비스 제공자) 간의 수업 예약 및
          수강권·상품 거래를 위한 플랫폼을 제공하는 통신판매중개자입니다. 각 수업·수강권·상품의
          내용, 이행, 하자 등에 대한 책임은 원칙적으로 이를 제공하는 센터에 있으며, 모하빗은
          「전자상거래 등에서의 소비자보호에 관한 법률」 제20조의2에 따라 거래 당사자가
          아님을 고지합니다.
        </p>
        <p>
          다만 회원의 결제 대금 수납은 모하빗이 결제대행사(토스페이먼츠)를 통해 직접
          처리하며, 이와 관련한 사항은 <a href="/legal/refund">환불·취소 정책</a>을 따릅니다.
        </p>

        <h2>사업자등록 확인</h2>
        <p>
          국세청 홈택스의 사업자등록상태 조회 서비스를 통해 위 사업자등록번호의 등록 여부를
          직접 확인하실 수 있습니다.
        </p>
      </div>
    </div>
  );
}
