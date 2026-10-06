import { describe, expect, it, vi } from "vitest";

// DB unique index 위반(23505)은 친절한 한국어 메시지로, 그 외 오류는 기존 접두어 유지.
let result: { data: unknown; error: { code?: string; message: string } | null } = { data: { id: "t1" }, error: null };
vi.mock("../../lib/supabaseClient", () => {
  const chain: any = {
    insert: () => chain, update: () => chain, eq: () => chain, select: () => chain,
    single: async () => result,
    then: (res: any) => Promise.resolve(result).then(res),
  };
  return { supabase: { from: () => chain } };
});
import { createAlimtalkTemplate, updateAlimtalkTemplate } from "../../lib/alimtalk";

describe("알림톡 템플릿 중복(23505) 처리", () => {
  it("생성: 성공 시 id", async () => {
    result = { data: { id: "t1" }, error: null };
    await expect(createAlimtalkTemplate("c1", { title: "a", content: "b", variables: [] })).resolves.toBe("t1");
  });
  it("생성: 23505 → 이미 등록된 알림톡 템플릿", async () => {
    result = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    await expect(createAlimtalkTemplate("c1", { title: "a", content: "b", variables: [], aligoTemplateCode: "T1" })).rejects.toThrow("이미 등록된 알림톡 템플릿이에요");
  });
  it("생성: 기타 오류는 기존 메시지", async () => {
    result = { data: null, error: { code: "XX", message: "boom" } };
    await expect(createAlimtalkTemplate("c1", { title: "a", content: "b", variables: [] })).rejects.toThrow("템플릿 등록에 실패했어요: boom");
  });
  it("수정: 23505 → 이미 다른 템플릿에서 쓰는 코드, 기타 오류는 기존 메시지", async () => {
    result = { data: null, error: { code: "23505", message: "dup" } };
    await expect(updateAlimtalkTemplate("t1", { aligoTemplateCode: "T1" })).rejects.toThrow("이미 다른 템플릿에서 쓰고 있는 알리고 템플릿 코드예요");
    result = { data: null, error: { message: "boom" } };
    await expect(updateAlimtalkTemplate("t1", { title: "x" })).rejects.toThrow("템플릿 수정에 실패했어요: boom");
  });
});
