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

// window가 없는 환경(Node — tests/integration/setup.ts가 이 파일의 싱글턴을 그대로 재사용해
// 실제 로그인 세션을 만든다, 상단 주석 참고)에서는 브라우저 storage 자체가 없다. supabase-js
// 기본 구현은 이 경우 내부 메모리 폴백으로 세션을 "그 프로세스가 사는 동안"은 유지해주는데,
// 커스텀 storage를 넘기면 그 자동 폴백이 꺼지고 내가 만든 어댑터가 전부 책임져야 한다 —
// 처음엔 이 케이스에서 그냥 아무것도 안 하게(get은 null, set/remove는 no-op) 짜서, Node
// 쪽에서 로그인은 성공해도 세션이 어디에도 저장되지 않아 바로 다음 요청부터 익명으로 나가
// "new row violates row-level security policy"로 터졌다(CI 실행에서 실측). 아래
// memoryStorage로 그 자동 폴백과 동일한 동작을 직접 구현해 되살린다.
const memoryStorage = new Map<string, string>();

function pickAuthStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  if (typeof window === "undefined") {
    return {
      getItem: (key) => memoryStorage.get(key) ?? null,
      setItem: (key, value) => { memoryStorage.set(key, value); },
      removeItem: (key) => { memoryStorage.delete(key); },
    };
  }
  return window.localStorage.getItem(REMEMBER_ME_KEY) === "0" ? window.sessionStorage : window.localStorage;
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: {
      getItem: (key: string) => pickAuthStorage().getItem(key),
      setItem: (key: string, value: string) => pickAuthStorage().setItem(key, value),
      removeItem: (key: string) => pickAuthStorage().removeItem(key),
    },
  },
});

// 사용 예시 (나중에 클래스 목록 붙일 때):
//
// const { data, error } = await supabase
//   .from("classes")
//   .select("*")
//   .order("start_time");
