/*
  MockPaymentProvider - 테스트 결제 환경(P0-1)의 실제 동작 구현체
  - 4개 메서드 모두 실동작(구조만이 아님)
  - success / failed / cancelled 3가지 시나리오를 시뮬레이션 가능
    (NEXT_PUBLIC_PAYMENT_SCENARIO 환경변수, 또는 생성자 인자로 즉시 override)
*/

import type {
  CancelPaymentResult,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentScenario,
  PaymentStatusResult,
} from "./types";
import { cancelTestPaymentRpc, confirmTestPaymentRpc, fetchOrderPaymentStatus } from "./mockPaymentApi";

const VALID_SCENARIOS: PaymentScenario[] = ["success", "failed", "cancelled"];

export function resolveScenarioFromEnv(): PaymentScenario {
  const raw = process.env.NEXT_PUBLIC_PAYMENT_SCENARIO;
  return (VALID_SCENARIOS as string[]).includes(raw ?? "") ? (raw as PaymentScenario) : "success";
}

export class MockPaymentProvider implements PaymentProvider {
  private readonly scenario: PaymentScenario;

  // scenario를 생략하면 NEXT_PUBLIC_PAYMENT_SCENARIO 값을 읽음(기본 "success").
  // 테스트나 QA 시 재빌드 없이 즉시 바꾸고 싶으면 이 인자로 override.
  constructor(scenario?: PaymentScenario) {
    this.scenario = scenario ?? resolveScenarioFromEnv();
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // 실제 PG라면 여기서 결제창 세션/클라이언트 토큰을 발급받음. Mock은 즉시 참조값만 생성.
    return {
      paymentKey: `mock_${input.orderId}_${crypto.randomUUID()}`,
      status: "pending",
    };
  }

  async confirmPayment(paymentKey: string, orderId: string, _amount?: number): Promise<ConfirmPaymentResult> {
    switch (this.scenario) {
      case "failed":
        // 결제 자체가 실패한 경우 — 아무 것도 확정하지 않음(주문은 pending 그대로 남아 재시도 가능)
        return { status: "failed", message: "(Mock) 결제가 실패했어요. 다시 시도해주세요." };

      case "cancelled":
        // 결제 도중 취소된 경우 — 주문을 cancelled로 전환
        await cancelTestPaymentRpc(orderId);
        return { status: "cancelled", message: "(Mock) 결제가 취소됐어요." };

      case "success":
      default: {
        const { membershipId } = await confirmTestPaymentRpc(orderId, paymentKey);
        return { status: "paid", membershipId: membershipId ?? undefined };
      }
    }
  }

  async cancelPayment(orderId: string): Promise<CancelPaymentResult> {
    await cancelTestPaymentRpc(orderId);
    return { status: "cancelled" };
  }

  async getPaymentStatus(orderId: string): Promise<PaymentStatusResult> {
    const status = await fetchOrderPaymentStatus(orderId);
    return { orderId, status };
  }
}
