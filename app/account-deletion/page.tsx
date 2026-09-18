/*
  계정 및 데이터 삭제 안내 — Google Play Console "데이터 보안 > 계정 삭제 URL"에 제출하는
  공개 페이지. 로그인 없이 누구나(앱 설치 여부와 무관하게, 웹 브라우저로) 접근할 수 있어야
  하므로 다른 /legal/* 페이지와 동일하게 인증 체크를 두지 않는다.

  내용은 실제 탈퇴 구현(app/mypage/info/page.tsx, lib/accountDeletion.ts,
  supabase/functions/delete-account/index.ts)을 코드로 확인한 뒤 그대로 반영한 것이며,
  이 페이지 자체는 탈퇴 로직을 호출하지 않는 순수 안내 페이지다(추측 금지 원칙).
*/

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "모하빗 계정 및 데이터 삭제",
  description: "모하빗(MWHABIT) 계정 및 데이터 삭제 방법 안내",
};

export default function AccountDeletionPage() {
  return (
    <div className="app-shell settings-page-v2">
      <div className="back-header">
        <a className="side" href="/">‹</a>
        <div className="title">계정 및 데이터 삭제</div>
        <div className="side" />
      </div>

      <div className="legal-page">
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: "4px 0 4px" }}>
          모하빗 계정 및 데이터 삭제
        </h1>
        <div className="legal-updated">Google Play 계정 삭제 안내 페이지 · mwhabit.com</div>

        <p>
          이 페이지는 <strong>모하빗(MWHABIT)</strong> 앱(iOS/Android/웹, 도메인{" "}
          <strong>mwhabit.com</strong>)의 계정 및 데이터 삭제 방법을 안내하는 공식 페이지입니다.
          앱을 설치하지 않았거나 로그인할 수 없는 상태에서도 이 페이지를 통해 계정 삭제
          절차를 확인할 수 있습니다.
        </p>

        <h2>1. 앱에서 직접 계정 탈퇴하기</h2>
        <p>모하빗 앱에 로그인한 상태라면 아래 경로에서 바로 계정을 탈퇴할 수 있습니다.</p>
        <div className="perm-guide">
          <b>마이 → 내 정보 관리 → 계정 탈퇴</b>
        </div>
        <p>
          해당 화면에서 본인 확인(이메일 계정은 현재 비밀번호 재확인, 소셜 로그인 계정은
          확인 문구 입력) 절차를 거치면 탈퇴가 즉시 처리됩니다. 별도 승인 대기 기간 없이
          바로 반영됩니다.
        </p>

        <h2>2. 앱에 로그인할 수 없는 경우 삭제 요청하기</h2>
        <p>
          비밀번호를 잊었거나 더 이상 로그인할 수 없는 등의 이유로 앱에서 직접 탈퇴할 수
          없다면, 아래 이메일로 삭제를 요청할 수 있습니다.
        </p>
        <div className="perm-guide">
          <div>이메일: <b>contact@mwhabit.com</b></div>
          <div>제목 예시: <b>[모하빗 계정 삭제 요청]</b></div>
        </div>
        <p>
          본인 확인을 위해 가입 시 사용한 이메일 주소 또는 휴대폰 번호 등 계정을 특정할 수
          있는 정보를 알려주셔야 처리가 가능할 수 있습니다. 다만{" "}
          <strong>비밀번호, 인증번호(OTP), 결제 비밀번호 등 민감한 인증정보는 이메일로 보내지
          말아 주세요</strong> — 저희는 이러한 정보를 요청하지 않으며, 본인 확인은 계정 식별
          정보만으로 진행합니다.
        </p>

        <h2>3. 삭제되는 데이터</h2>
        <p>계정 탈퇴가 완료되면 다음 정보가 삭제되거나 더 이상 알아볼 수 없도록 처리됩니다.</p>
        <ul>
          <li>이름, 휴대폰 번호, 주소 등 계정에 등록된 개인 식별정보 (알아볼 수 없는 값으로
            대체)</li>
          <li>프로필(가족 프로필 포함)의 이름, 닉네임, 휴대폰 번호, 주소, 프로필 사진, 메모,
            생년월일, 라벨 등 개인정보</li>
          <li>프로필 사진 등 업로드된 이미지 파일</li>
          <li>기기 푸시 알림 토큰·구독 정보 (탈퇴 후 더 이상 알림이 발송되지 않음)</li>
          <li>계정 인증 정보 자체(로그인 수단)를 삭제하여, 이후 같은 이메일·휴대폰 번호·소셜
            계정으로 재가입이 가능해집니다.</li>
        </ul>

        <h2>4. 보관될 수 있는 데이터</h2>
        <p>
          다음 항목은 관계 법령상 보존 의무 및 정산·분쟁 처리 목적으로 탈퇴 이후에도 일정
          기간 보관될 수 있습니다. 보관 시에는 위 개인 식별정보와 분리되어, 실제 신원과
          연결되지 않는 형태로만 남습니다.
        </p>
        <ul>
          <li>예약 내역</li>
          <li>구매·결제 내역</li>
          <li>정산 및 거래 관련 기록</li>
        </ul>
        <p>
          구체적인 보관 기간 및 법적 근거는{" "}
          <a href="/legal/privacy" style={{ color: "var(--accent)", textDecoration: "underline" }}>개인정보처리방침</a>의
          "개인정보의 보유 및 이용 기간" 항목을 참고해 주세요.
        </p>

        <h2>5. 개인정보처리방침</h2>
        <p>
          모하빗의 개인정보 수집·이용·보관에 대한 전체 내용은{" "}
          <a href="/legal/privacy" style={{ color: "var(--accent)", textDecoration: "underline" }}>개인정보처리방침</a>에서
          확인할 수 있습니다.
        </p>

        <h2>6. 문의</h2>
        <p>
          계정 삭제 또는 개인정보 처리와 관련해 궁금한 점이 있다면 아래로 문의해 주세요.
        </p>
        <div className="perm-guide">
          <div>이메일: <b>contact@mwhabit.com</b></div>
        </div>
      </div>
    </div>
  );
}
