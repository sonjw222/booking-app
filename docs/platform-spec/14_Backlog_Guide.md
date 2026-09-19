# Backlog Guide

Status: Active Operating Rule
Version: 1.1.0
Current-State Source: Booking App Master Spec v1.1, Technical Roadmap, Implementation Roadmap
Target-State Status: Applies to new and updated development work
Last Updated: 2026-07-31

# 목적

이 문서는 Booking App 개발 작업이 제품 기준에서 벗어나지 않도록 다음 운영 흐름을 정의한다.

```text
Master Spec
↓
Technical Roadmap
↓
Implementation Roadmap
↓
Backlog
↓
GitHub Issue
↓
Claude Code Implementation
↓
Testing
↓
Done
```

이 문서는 제품 요구사항을 추가하거나 변경하지 않는다. 제품과 기술 상태의 기준은 [Master Spec](./00_Project_Principles.md)이며, 이 문서는 요구사항을 실제 개발 작업까지 추적하는 운영 규칙만 제공한다.

# 사용 방법

1. [Master Spec](./00_Project_Principles.md)에서 Current State, Target State, Gap, Decision Required, Blocked 상태를 확인한다.
2. [Technical Roadmap](./12_Roadmap.md)에서 대상 Feature의 Current, Intermediate, Target, Priority, Blocked By를 확인한다.
3. [Implementation Roadmap](./13_Implementation_Roadmap.md)에서 해당 Feature가 속한 Phase와 선행 조건을 확인한다.
4. [Project Backlog](../19_Project_Backlog.md)에 Feature를 실행 가능한 Task로 관리한다.
5. Backlog Task 하나를 참조하는 GitHub Issue를 만든다.
6. Issue의 범위와 완료 조건 안에서만 구현한다.
7. 지정된 테스트와 Master Spec의 품질 기준을 검증한다.
8. 완료 증거가 확보되면 정의된 순서로 상태를 갱신한다.

`Blocked By`가 해결되지 않았거나 Decision Required가 승인되지 않은 작업은 구현 단계로 이동하지 않는다.

# 개발 흐름

## 1. Master Spec

Master Spec은 제품 원칙, 실제 Current State, Target State, Gap, 보안·데이터·아키텍처 기준을 정의하는 SSOT다.

- 시작점: [Project Principles](./00_Project_Principles.md)
- 기술 구조: [Architecture](./01_Architecture.md)
- 데이터 기준: [Database](./02_Database.md)
- 보안 기준: [Security](./05_Security.md)
- 테스트 기준: [Testing](./06_Testing.md)
- 용어 기준: [Terminology Map](./11_Terminology_Map.md)
- 제품 결정: [Decision Log](./08_Decision_Log.md)

## 2. Technical Roadmap

[Technical Roadmap](./12_Roadmap.md)은 Master Spec의 Current와 Target 사이에 Intermediate를 정의한다. Feature별 우선순위와 외부 차단 조건을 제공하지만 제품 요구사항을 바꾸지 않는다.

## 3. Implementation Roadmap

[Implementation Roadmap](./13_Implementation_Roadmap.md)은 기술 위험과 선행 관계를 기준으로 Phase 0~7의 실제 개발 순서를 정의한다. Phase 완료 조건을 충족하지 않으면 후속 Phase로 점프하지 않는다.

## 4. Backlog

[Project Backlog](../19_Project_Backlog.md)는 Roadmap Feature를 구현 가능한 단위로 분해하고 상태·담당·우선순위를 관리한다. Backlog는 제품 요구사항을 새로 정의하지 않는다.

## 5. GitHub Issue

GitHub Issue는 Backlog Task 하나를 실행하기 위한 협업·추적 단위다. Issue는 Backlog보다 범위를 넓힐 수 없으며, 새 요구가 발견되면 구현하지 말고 Master Spec/Roadmap/Backlog 정합성을 먼저 검토한다.

## 6. Claude Code Implementation

Claude Code를 포함한 AI와 개발자는 Issue에 승인된 범위만 구현한다. Current에서 Target으로 바로 이동하지 않고 Roadmap의 Intermediate와 Phase 순서를 따른다.

## 7. Testing

테스트는 Issue의 완료 조건뿐 아니라 [Testing](./06_Testing.md), [Security](./05_Security.md), 해당 Epic의 수용 기준을 충족해야 한다. 실행하지 않은 테스트나 운영 검증은 완료 증거가 아니다.

## 8. Done

Done은 코드 작성 완료가 아니라 다음이 모두 충족된 상태다.

- Issue 범위와 Definition of Done 충족
- 필요한 unit/integration/E2E/security 테스트 통과
- 문서·migration·타입 등 동반 산출물 완료
- Blocked By와 Decision Required가 남지 않거나 명시적으로 후속 분리
- Backlog, Issue, Roadmap 상태가 정해진 순서로 갱신됨

# Backlog 운영 원칙

1. Roadmap의 모든 Feature에는 Backlog에 최소 1개 이상의 Task가 존재해야 한다.
2. Backlog의 모든 Task는 반드시 하나의 Roadmap Feature에 연결되어야 한다.
3. GitHub Issue는 반드시 하나의 Backlog Task를 참조해야 한다.
4. 구현 완료 시 Roadmap의 Current 상태를 실제 구현·테스트 증거에 맞게 갱신한다.
5. Master Spec은 항상 SSOT다. Roadmap와 Backlog는 Master Spec을 변경하지 않는다.
6. Backlog는 구현 작업을 관리하는 문서이며 제품 요구사항을 변경하지 않는다.
7. Roadmap와 Backlog가 충돌하면 Backlog를 수정하지 않고 [Technical Roadmap의 충돌 기록](./12_Roadmap.md#roadmap-충돌-기록) 또는 [Implementation Roadmap의 충돌 기록](./13_Implementation_Roadmap.md#roadmap-충돌-기록)에 이유와 필요한 결정을 기록한다.

## 추적 필드

Backlog Task는 최소한 다음 추적 정보를 가져야 한다.

| Field | Rule |
|---|---|
| Backlog ID | 변경되지 않는 고유 ID |
| Epic | 관련 Epic 또는 운영 영역 |
| Roadmap Feature | `12_Roadmap.md`의 Feature 이름 하나 |
| Implementation Phase | `13_Implementation_Roadmap.md`의 Phase 하나 |
| Priority | Roadmap 우선순위를 임의로 높이거나 낮추지 않음 |
| Current | 작업 시작 시 실제 상태 |
| Intermediate Outcome | 이번 Task가 도달할 검증 가능한 단계 |
| Blocked By | 외부 조건·선행 작업·결정 |
| Status | 작업 상태 |
| Issue | 연결된 GitHub Issue |

# GitHub Issue 규칙

모든 구현 Issue에는 반드시 다음 항목이 포함되어야 한다.

- **Epic:** 관련 Epic 또는 운영 영역
- **Feature:** 구현할 구체 기능
- **Priority:** Roadmap/Backlog에서 상속한 우선순위
- **Backlog ID:** 정확히 하나의 Backlog Task ID
- **Roadmap Feature:** `12_Roadmap.md`의 Feature 이름
- **선행 작업:** Phase 및 의존 Task/Issue
- **완료 조건(Definition of Done):** 검증 가능한 결과
- **테스트 방법:** 실행 명령, 시나리오, 운영 확인 방법

권장 Issue 본문:

```md
## Epic

## Feature

## Priority

## Backlog ID

## Roadmap Feature

## Current State

## Intermediate Outcome

## Blocked By

## 선행 작업

## 작업 범위

## 제외 범위

## 완료 조건 (Definition of Done)

## 테스트 방법
```

다음 Issue는 구현을 시작할 수 없다.

- Backlog ID가 없거나 여러 Task를 동시에 참조함
- Roadmap Feature/Phase를 찾을 수 없음
- 해결되지 않은 `Blocked By`가 있음
- Master Spec의 Current/Target 구분을 위반함
- 완료 조건이나 테스트 방법이 검증 불가능함

# 구현 완료 규칙

기능 구현과 테스트가 완료되면 다음 순서로 갱신한다.

```text
1. Backlog 상태
↓
2. Issue 상태
↓
3. Roadmap Current
```

## 1. Backlog 상태

- Task 완료 조건과 테스트 증거를 기록한다.
- 구현되지 않은 Target 범위는 완료 처리하지 않는다.
- 후속 Gap은 새 Backlog Task 후보로 분리하되 제품 요구사항을 추가하지 않는다.

## 2. Issue 상태

- 완료한 범위, 변경 파일, 테스트 결과, 남은 제한을 기록한다.
- PR/commit/배포 등 실제 증거가 필요한 경우 연결한다.
- 완료 조건이 일부 남으면 Issue를 닫지 않는다.

## 3. Roadmap Current

- 실제 코드와 테스트에 근거해 해당 Feature의 Current만 갱신한다.
- Intermediate가 완료됐다고 Target까지 완료된 것으로 표시하지 않는다.
- Expected Version은 실제 계획 변경이 승인된 경우에만 수정한다.

Master Spec은 이 상태 갱신 과정에서 자동 수정하지 않는다. 구현 결과가 Master Spec의 기준 자체를 바꿔야 한다면 별도 제품/아키텍처 결정과 ADR 승인을 먼저 받아야 한다.

# AI Working Rules

1. AI는 항상 `Master Spec → Roadmap → Backlog → Issue → 구현` 순서를 따른다.
2. Roadmap를 건너뛰지 않는다.
3. Backlog 없이 Issue를 만들지 않는다.
4. Issue 없이 구현하지 않는다.
5. 구현 완료 후 Roadmap와 Backlog를 최신 상태로 유지한다.
6. `Blocked By` 또는 Decision Required가 남아 있으면 승인 없이 구현하지 않는다.
7. Backlog와 Roadmap이 충돌하면 Backlog를 수정하지 않고 Roadmap의 충돌 기록에 이유를 남긴다.
8. Master Spec의 Current, Intermediate, Target을 섞지 않는다.

