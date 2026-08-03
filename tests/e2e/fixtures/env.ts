// E2E(Playwright) 전용 환경변수 로더.
// tests/integration/loadEnv.ts와 동일한 규칙(.env.test.local 로컬 로드, CI는 Secrets 직접 주입)을
// 따르되, E2E가 실제로 로그인에 쓰는 두 계정(TEST_MANAGER_A/TEST_USER_A)만 필수로 검증한다.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), ".env.test.local") });

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "TEST_MANAGER_A_EMAIL",
  "TEST_MANAGER_A_PASSWORD",
  "TEST_USER_A_EMAIL",
  "TEST_USER_A_PASSWORD",
];

export function requireE2eEnv(): void {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `E2E 테스트에 필요한 환경변수가 없습니다: ${missing.join(", ")}\n` +
        `.env.test.local.example을 복사해 .env.test.local을 만들고 값을 채워주세요 ` +
        `(로컬 실행). GitHub Actions에서는 동일한 이름으로 Repository Secrets에 등록하세요.`
    );
  }
}

// [임시 진단 — permission denied 조사 전용, 이 조사가 끝나면 제거한다]
// DB 쪽에서는 service_role에 4개 테이블 GRANT가 실제로 있음을 사용자가 직접 확인했는데도
// CI는 여전히 "permission denied for table center_settings"를 낸다 — 즉 CI가 실제로는
// 그 DB를 안 보고 있거나(SUPABASE_URL이 다른 프로젝트), service_role 키 자체가 다른
// 프로젝트/다른 값일 가능성이 남는다. 비밀값 자체는 절대 전체를 출력하지 않고(민감정보
// 노출 금지), "프로젝트를 구분할 수 있는 정도"만 남긴다 — URL은 원래도 공개 값(브라우저에
// 노출됨)이라 전체 출력 안전, 키는 앞 10글자 + JWT라면 ref/role claim만 디코드한다(사용자가
// 이 정도 노출은 명시적으로 승인함).
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    return JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}
function projectRefFromUrl(url: string): string | null {
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}
{
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(미설정)";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const anonClaims = decodeJwtClaims(anonKey);
  const serviceClaims = decodeJwtClaims(serviceKey);
  // eslint-disable-next-line no-console
  console.log(
    "[E2E-DIAG] " +
      JSON.stringify({
        supabaseUrl: url,
        urlProjectRef: projectRefFromUrl(url),
        anonKeyPrefix: anonKey.slice(0, 12),
        anonKeyRefClaim: anonClaims?.ref ?? null,
        anonKeyRoleClaim: anonClaims?.role ?? null,
        serviceKeyPrefix: serviceKey.slice(0, 12),
        serviceKeyRefClaim: serviceClaims?.ref ?? null,
        serviceKeyRoleClaim: serviceClaims?.role ?? null,
        serviceKeyLooksLikeJwt: serviceKey.split(".").length === 3,
      })
  );
}
