#!/usr/bin/env node
// 네트워크 없이 env만 검사(Production 거부 + 필수 이름). 사용: npm run ci:dev:preflight
import { requireNonProductionOrExit } from "./requiredEnv.mjs";
requireNonProductionOrExit(process.env);
console.log("ci-dev preflight OK — 비-production 대상, 필수 변수 모두 존재(값은 출력하지 않음).");
