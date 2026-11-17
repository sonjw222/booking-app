/*
  catch 블록의 unknown 오류에서 `.message` 문자열만 안전하게 꺼내는 헬퍼.
  기존 `catch (e: any) { e.message }` 와 같은 값을 돌려주되(문자열 message 가 있으면 그대로),
  message 가 없으면 빈 문자열을 돌려준다. 사용자 문구 치환이 필요하면 lib/userError 의 toUserMessage 를 쓴다.
*/
export function errMsg(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}
