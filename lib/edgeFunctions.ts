// supabase.functions.invoke()가 Edge Function에서 non-2xx 응답을 받으면 error.message는
// "Edge Function returned a non-2xx status code" 같은 일반 문구로 고정된다 — 실제 이유는
// error.context(원본 Response)를 다시 읽어야 나온다. 우리 Edge Function들은 전부
// { error: "..." } 형태로 이유를 돌려주므로(supabase/functions/*/index.ts), 그 문구를
// 우선 꺼내 쓰고 실패하면 기본 메시지로 되돌아간다.
export async function edgeFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      const body = await context.json();
      if (body?.error) return String(body.error);
    } catch {
      // 본문이 JSON이 아니면 무시하고 기본 메시지를 쓴다.
    }
  }
  return (error as { message?: string } | null)?.message ?? fallback;
}
