/*
  객체에서 지정한 키를 뺀 얕은 복사본을 만든다.
  `const { a, b, ...rest } = row`는 a/b가 쓰이지 않아 no-unused-vars가 되므로(컬럼 폴백 경로에서
  "없을 수 있는 컬럼"을 빼고 재시도할 때 쓰는 패턴) 같은 결과를 내는 명시적 헬퍼로 대신한다.
  결과는 rest 구조분해와 동일: 나머지 own enumerable 키만 그대로 복사.
*/
export function omitKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (!drop.has(k)) out[k] = obj[k];
  }
  return out as Omit<T, K>;
}
