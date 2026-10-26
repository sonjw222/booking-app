# 공유 DEV CI 잔여 수업 정리 계획 v2 (읽기 전용 조회 — 아무것도 삭제하지 않았음)

- 생성: 2026-10-26T15:37:09.330Z · 대상: jdglfvwdnkjnraqdxuuj.supabase.co · GET 만
- **판정: 정황 근거가 있는 일회성 정리 승인 후보(approvalCandidate)** — 소유권 증명 아님(ownershipProven=false)
- 계획 해시(sha256 of canonical JSON): `0bbd2f613ddd22b2aae3c97937996b009d672bfcf06360d475d3d01dfa84cc85`
- 수업 23 · 예약 12 · 연결 수강권 6 · 자식 행 class_allowed_products:2, class_trainers:0, schedule_memos:0, reservation_goods_usages:0 · 감사 참조 {"class_id":0,"reservation_id":0}
- 승인 목록 프로필(고유번호 기준) 5개 · 미확인 프로필 0개 · 미지의 참조 컬럼 0개

## 승인된 프로필 근거(표시 이름 아님)
- a82c3e21-cb94-43c2-9edc-2ef50d469f13 / 계정 2439f3f9-0345-4290-aee9-2bf0ef0d81b7 / test-account:USER_A
- 34482e8c-553a-47e5-9589-0f28d954f403 / 계정 398338d5-dc94-4326-97a9-61be2c9b91df / test-account:USER_B
- 5c69226d-c9a6-40d7-945d-946c966d838e / 계정 398338d5-dc94-4326-97a9-61be2c9b91df / test-account:USER_B
- c327725d-9734-4d34-ad08-5e6a08c54908 / 계정 4e9cb225-6c0d-4e60-a491-d4622fc12b2b / anonymized-throwaway(auth-user-deleted)
- 1cfd331b-a55c-4530-b6ce-b00475b173e5 / 계정 4e9cb225-6c0d-4e60-a491-d4622fc12b2b / anonymized-throwaway(auth-user-deleted)

## 근거의 한계
- 과거 생성 응답과 실행 식별자(UUID)는 사라졌고 복구할 수 없다(통과한 테스트는 trace 를 남기지 않고, 당시 코드는 제목에 실행 UUID 를 쓰지 않았고, manifest 는 러너와 함께 사라짐). 이 사실을 그대로 인정한다.
- 따라서 이 계획은 소유권을 증명하지 않는다. 근거는 같은 CI job 로그에 id 등장 + 생성 시각이 그 job 구간 안 + 제목의 Date.now() 일치 + 예약 프로필이 확인된 테스트 계정/익명화된 throwaway 계정이라는 정황이다.
- 삭제는 사람이 이 정황 근거를 보고 '일회성 정리'를 승인한 뒤에만 한다.

## 부수 효과 조사
- 예약 DELETE: BEFORE DELETE 트리거 reservation_goods_restore_on_delete — 차감된 대여 사용 기록(reservation_goods_usages.status='deducted')이 있으면 대여 수강권 remaining_count 를 +1 한다. 이 계획의 대여 사용 기록 수: 0
- 예약 DELETE 는 pass 수강권 remaining_count 를 돌려주지 않는다(직접 삭제, 환불 아님). 연결 수강권 상태는 linkedMemberships 로 기록·대조한다.
- 수업 DELETE: 이 저장소 SQL 에서 classes 에 걸린 트리거를 찾지 못함(공유 DEV 의 pg_trigger 는 PostgREST 로 조회 불가 — 미확인). CASCADE 자식: class_allowed_products, class_trainers, schedule_memos.
- 예약 INSERT(복원): AFTER INSERT 트리거 notify_reservation_insert 가 회원·센터 매니저에게 notifications 행을 만든다(웹푸시는 별도 pg_net/Edge Function 경로 가능 — 공유 DEV 에서는 미확인). BEFORE INSERT 트리거 reservations_guard_pg_refund_lock 이 환불 진행 중 수강권이면 삽입을 거부할 수 있다.

## 수업별 정황 근거
- 09089778-0438-4c9c-af6f-576e81d6c43e: CI 로그 job 구간 일치 예
- 156ca29c-bfaf-46a5-94a1-039bf2a685f6: CI 로그 job 구간 일치 예, 제목 epoch 차 5.7초
- 34a5d298-27e5-4ba9-9dcd-68e4c8bd0baa: CI 로그 job 구간 일치 예, 제목 epoch 차 0.3초
- 44920648-1629-4787-898e-fd9e34197653: CI 로그 job 구간 일치 예, 제목 epoch 차 5.5초
- 547526ae-c808-42ee-9c62-43b4fd1ea20e: CI 로그 job 구간 일치 예, 제목 epoch 차 4.9초
- 650538db-f67d-4348-a3b3-a55520b9f7ab: CI 로그 job 구간 일치 예
- 65baba3c-075f-4771-b41e-d07736f5a3fb: CI 로그 job 구간 일치 예, 제목 epoch 차 8.8초
- 66b75631-17a5-4af2-857f-98cca0e661e3: CI 로그 job 구간 일치 예, 제목 epoch 차 5.7초
- 7c63e12b-d77c-4f7b-85de-8286d8b9dae5: CI 로그 job 구간 일치 예, 제목 epoch 차 5.7초
- 7ca951ef-bd8f-49f2-85d4-bcb35b447561: CI 로그 job 구간 일치 예, 제목 epoch 차 7.0초
- 800205db-d28d-4737-9eed-edab6a407fdd: CI 로그 job 구간 일치 예, 제목 epoch 차 5.3초
- 85800a8a-6b99-4670-bb25-bba645464100: CI 로그 job 구간 일치 예
- 94a54728-8db7-4e74-9901-54ba4a3fccff: CI 로그 job 구간 일치 예, 제목 epoch 차 9.2초
- 95250034-8f0d-4538-b0a3-440635ac8677: CI 로그 job 구간 일치 예, 제목 epoch 차 5.5초
- 9994a6dd-1b2c-4456-b329-be398e50b743: CI 로그 job 구간 일치 예, 제목 epoch 차 5.7초
- 99dcd917-94f9-4755-a288-c2962d214bc2: CI 로그 job 구간 일치 예, 제목 epoch 차 10.8초
- a9fd581d-57cb-41da-ae67-41dfc84d32d8: CI 로그 job 구간 일치 예, 제목 epoch 차 5.5초
- adc1c555-1fbf-446a-bc55-080dec9cf732: CI 로그 job 구간 일치 예
- c74dbdc6-dbd4-4a3f-bc39-0e93d4591568: CI 로그 job 구간 일치 예, 제목 epoch 차 6.1초
- cfcb7946-a9d5-405e-a689-14ebdd05de80: CI 로그 job 구간 일치 예
- dbad9f95-f19b-4130-8c10-13c68ba38d5c: CI 로그 job 구간 일치 예, 제목 epoch 차 5.5초
- ec9a4dbe-8354-437b-bb71-e3c55c287d70: CI 로그 job 구간 일치 예, 제목 epoch 차 5.7초
- f8fcf95c-857a-41af-8bed-f4c39d22e8a6: CI 로그 job 구간 일치 예
