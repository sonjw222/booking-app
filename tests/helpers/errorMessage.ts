/** catch 절의 unknown 값에서 사람이 읽을 메시지를 안전하게 꺼낸다(테스트 정리/진단 공용). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
