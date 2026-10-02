/*
  Apple App Site Association — Universal Link 범위를 결제 복귀 콜백 두 경로로만 제한한다.
  https://mwhabit.com/.well-known/apple-app-site-association (인증/redirect 없이 200, application/json).
  appID = <Apple Team ID>.com.mwhabit.app (Team ID는 ios/App/App.xcodeproj의 DEVELOPMENT_TEAM). 비밀값은 포함하지 않는다.
  쿼리스트링이 붙은 실제 콜백도 path 기준으로 매칭된다("/" 컴포넌트는 query를 보지 않는다).
*/
export const AASA_TEAM_ID = "6TKYLJJSD5";
export const AASA_BUNDLE_ID = "com.mwhabit.app";

export const AASA = {
  applinks: {
    details: [
      {
        appIDs: [`${AASA_TEAM_ID}.${AASA_BUNDLE_ID}`],
        components: [{ "/": "/checkout/success" }, { "/": "/checkout/fail" }],
      },
    ],
  },
};

export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(AASA), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}
