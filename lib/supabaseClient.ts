import { createClient } from "@supabase/supabase-js";

// .env.local 에 넣어둔 두 값을 읽어옵니다.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// "로그인 상태 유지"(remember me, P1) — 이 키 자체는 항상 localStorage에 남긴다(민감정보
// 아님, 다음 로그인 화면에 체크박스 기본값을 복원하는 용도). REMEMBER_KEY가 명시적으로
// "0"일 때만 세션을 sessionStorage에 저장해 브라우저를 닫으면 로그아웃되게 한다 — 키가
// 아예 없는 경우(이 기능 이전부터 로그인해 있던 사용자, 그리고 Playwright E2E의
// storageState 로그인처럼 체크박스를 건드리지 않는 경우)는 기존과 동일하게 localStorage를
// 쓴다(하위 호환 — 기존 세션이 로그아웃되지 않음, E2E storageState는 localStorage만
// 캡처하므로 sessionStorage로 바뀌면 조용히 깨졌을 것).
export const REMEMBER_ME_KEY = "sb-remember-me";

function pickAuthStorage(): Storage {
  if (typeof window === "undefined") return undefined as unknown as Storage;
  return window.localStorage.getItem(REMEMBER_ME_KEY) === "0" ? window.sessionStorage : window.localStorage;
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: {
      getItem: (key: string) => pickAuthStorage()?.getItem(key) ?? null,
      setItem: (key: string, value: string) => pickAuthStorage()?.setItem(key, value),
      removeItem: (key: string) => pickAuthStorage()?.removeItem(key),
    },
  },
});

// 사용 예시 (나중에 클래스 목록 붙일 때):
//
// const { data, error } = await supabase
//   .from("classes")
//   .select("*")
//   .order("start_time");
