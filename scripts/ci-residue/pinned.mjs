// 검토된 계획의 해시(sha256 of canonical JSON). 계획이 한 글자라도 바뀌면 purge/restore 가 실행을 거부한다. 새 계획을 검토·승인하면 이 값을 사람이 갱신한다.
export const PINNED_PLAN_SHA256 = "0bbd2f613ddd22b2aae3c97937996b009d672bfcf06360d475d3d01dfa84cc85";
export const SHARED_DEV_REF = "jdglfvwdnkjnraqdxuuj";
export const PRODUCTION_REF = "bxntqggkfwnhcczsbqtj";
export const DEFAULT_PLAN = new URL("../../docs/qa/ci-residue-20261027/cleanup-plan.json", import.meta.url).pathname;
