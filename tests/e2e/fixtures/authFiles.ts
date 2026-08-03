// storageState 파일 경로 상수 — auth.setup.ts(setup 프로젝트, 테스트 파일로 취급됨)와
// 일반 스펙 파일이 이 값을 공유해야 하는데, Playwright는 스펙 파일이 다른 테스트 파일을
// import하는 것을 허용하지 않는다("should not import test file") — 그래서 이 상수만
// 별도의(테스트가 아닌) 파일로 분리했다.
export const MANAGER_AUTH_FILE = "playwright/.auth/manager.json";
export const MEMBER_AUTH_FILE = "playwright/.auth/member.json";
