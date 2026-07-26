import { createClient } from "@supabase/supabase-js";

// .env.local 에 넣어둔 두 값을 읽어옵니다.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 사용 예시 (나중에 클래스 목록 붙일 때):
//
// const { data, error } = await supabase
//   .from("classes")
//   .select("*")
//   .order("start_time");
