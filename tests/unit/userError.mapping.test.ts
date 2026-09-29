/*
  실기기 QA(2026-09-29) — 사용자 화면에 raw DB/Postgres/영문 오류가 그대로 노출되던 문제
  회귀 방지. `duplicate key value violates unique constraint "accounts_phone_key"`가 그대로
  화면에 보인 실제 사례가 출발점이다.
*/
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_ERROR_MESSAGE, toUserMessage } from "../../lib/userError";

describe("toUserMessage", () => {
  it("accounts_phone_key 중복 → 한글 안내(로그인 유도 포함)", () => {
    const err = new Error('duplicate key value violates unique constraint "accounts_phone_key"');
    expect(toUserMessage(err)).toBe("이미 가입된 휴대폰 번호예요. 기존 계정으로 로그인해 주세요.");
  });

  it("이메일 중복(Supabase Auth already registered) → 한글 안내", () => {
    expect(toUserMessage(new Error("User already registered"))).toContain("이미 가입된 이메일");
  });

  it("네트워크 실패 → 한글 안내", () => {
    expect(toUserMessage(new Error("Failed to fetch"))).toContain("네트워크 연결을 확인");
    expect(toUserMessage(new Error("Load failed"))).toContain("네트워크 연결을 확인");
  });

  it("잘못된 로그인 정보 / 이메일 미인증 / 비밀번호 정책 → 한글 안내", () => {
    expect(toUserMessage(new Error("Invalid login credentials"))).toContain("이메일 또는 비밀번호");
    expect(toUserMessage(new Error("Email not confirmed"))).toContain("이메일 인증");
    expect(toUserMessage(new Error("Password should be at least 6 characters"))).toContain("6자 이상");
  });

  it("raw Postgres 기술 오류(제약조건/릴레이션/컬럼 등)는 알 수 없는 것이라도 안전한 기본 문구로", () => {
    expect(toUserMessage(new Error('null value in column "phone" violates not-null constraint'))).toBe(DEFAULT_USER_ERROR_MESSAGE);
    expect(toUserMessage(new Error('relation "some_table" does not exist'))).toBe(DEFAULT_USER_ERROR_MESSAGE);
    expect(toUserMessage(new Error("permission denied for table accounts"))).toBe(DEFAULT_USER_ERROR_MESSAGE);
  });

  it("한글이 전혀 없는 영문 메시지는 안전한 기본 문구로 치환(휴리스틱 — 이 프로젝트의 모든 사용자向 메시지는 한글)", () => {
    expect(toUserMessage(new Error("Something went wrong on the server side"))).toBe(DEFAULT_USER_ERROR_MESSAGE);
  });

  it("이미 잘 만들어진 한글 메시지(우리 RPC의 raise exception)는 그대로 통과시킨다", () => {
    expect(toUserMessage(new Error("이미 등록된 사업자등록번호예요"))).toBe("이미 등록된 사업자등록번호예요");
    expect(toUserMessage(new Error("센터 이름을 입력해주세요"))).toBe("센터 이름을 입력해주세요");
  });

  it("사용자 지정 fallback을 우선 사용할 수 있다", () => {
    expect(toUserMessage(new Error("relation does not exist"), "계정 생성 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요."))
      .toBe("계정 생성 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.");
  });

  it("빈 오류/null/undefined는 기본 문구", () => {
    expect(toUserMessage(null)).toBe(DEFAULT_USER_ERROR_MESSAGE);
    expect(toUserMessage(undefined)).toBe(DEFAULT_USER_ERROR_MESSAGE);
    expect(toUserMessage("")).toBe(DEFAULT_USER_ERROR_MESSAGE);
  });

  it("문자열 오류와 Supabase 스타일 { message } 객체 모두 처리한다", () => {
    expect(toUserMessage("Invalid login credentials")).toContain("이메일 또는 비밀번호");
    expect(toUserMessage({ message: "User already registered" })).toContain("이미 가입된 이메일");
  });

  it("개발 로그에는 원본 오류를 남긴다(사용자 화면에만 안전한 문구를 보여줌)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error("duplicate key value violates unique constraint");
    toUserMessage(raw);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("toUserMessage"), raw);
    spy.mockRestore();
  });
});
