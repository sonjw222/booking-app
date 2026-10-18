// 공유 DEV 계정의 is_platform_admin을 임시 승격하거나 전역 기본 요금제를 바꾸는 통합 테스트용 게이트.
// 일반 CI(vitest.integration.config.ts)에서는 켜지지 않는다: 아래 변수는 어떤 workflow도 설정하지 않으며,
// 수동 러너(vitest.integration.privileged.config.ts + privilegedPreflight.ts)가 읽기 전용 사전검사를 통과시킨 뒤에만 의미를 가진다.
// 게이트가 꺼져 있으면 해당 테스트는 PASS가 아니라 SKIP으로 보고된다(실행하지 않은 것을 통과로 세지 않는다).
import { it } from "vitest";

export const PRIVILEGED_DEV_TESTS_ENABLED = process.env.ALLOW_PRIVILEGED_DEV_TESTS === "1";
export const itPrivileged = it.skipIf(!PRIVILEGED_DEV_TESTS_ENABLED);
