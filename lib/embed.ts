/*
  Supabase 임베드(관계) 컬럼 읽기 헬퍼.

  이 앱의 supabase 클라이언트는 DB 스키마 타입을 주입하지 않아서(postgrest-js 제네릭 미지정)
  `.select("..., centers(name)")` 같은 to-one 임베드를 타입상 "배열"로 추론한다. 하지만 런타임
  응답은 객체(또는 null)다. 예전에는 `(r as any).centers?.name`으로 우회했는데, 여기서는 any 없이
  "실제 응답 모양"을 호출부가 명시하도록 한다. 런타임 값은 건드리지 않는다(그대로 반환).
*/
export function one<T>(rel: unknown): T | null | undefined {
  return rel as T | null | undefined;
}

/**
 * 타입 없는 클라이언트가 추론하지 못하는 조회 결과(예: `alias:fk(...)` 힌트가 있는 select)를
 * 호출부가 선언한 행 타입으로 읽는다. 런타임 값은 그대로(null/undefined만 빈 배열).
 */
export function rowsOf<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

/**
 * 컬럼 목록을 문자열로 조립해 `.select(cols)`를 부르는 동적 조회(컬럼 폴백용) 결과 읽기.
 * select 문자열이 리터럴이 아니면 postgrest-js가 행 타입을 추론하지 못해 `GenericStringError`가 되므로,
 * 호출부가 선언한 행 타입으로 `{ data, error }`를 그대로 되돌려준다(런타임 값은 건드리지 않음).
 */
export interface DynamicQueryResult<T> {
  data: T[] | null;
  error: { code?: string; message: string } | null;
}
export function queryOf<T>(res: unknown): DynamicQueryResult<T> {
  return res as DynamicQueryResult<T>;
}
