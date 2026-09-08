-- ============================================================
-- alimtalk_templates.aligo_template_code 중복 방지
--
-- 배경: 플랫폼 단일 알리고 계정을 전 센터가 공유하는 구조라(app/manager/alimtalk/settings
-- 주석 참고), 알리고 쪽 템플릿 코드에는 "어느 센터 것인지" 개념이 전혀 없다. 지금까지는
-- 매니저가 "알리고에서 불러오기"로 코드를 고를 때 실수로 다른 센터가 이미 쓰고 있는
-- 코드를 자기 센터 템플릿에도 저장할 수 있었다(제약이 전혀 없었음) — 그러면 두 센터가
-- 같은 카카오 알림톡 문구(다른 센터 이름이 박힌 문구)를 공유하게 되는 사고가 날 수 있다
-- (사용자 QA 피드백, 2026-09-08).
--
-- 코드가 null인 행(초안/미승인)은 여러 개 있어도 무방하니, null이 아닌 값만 유니크하게
-- 막는 부분 인덱스로 처리한다.
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(create index if not exists).
-- ============================================================

create unique index if not exists idx_alimtalk_templates_aligo_code_unique
    on alimtalk_templates(aligo_template_code)
    where aligo_template_code is not null;

comment on index idx_alimtalk_templates_aligo_code_unique is
    '같은 알리고 템플릿 코드가 우리 DB의 서로 다른 두 행(센터)에 동시에 연결되는 것을 막는다. '
    'null(초안/미승인)은 여러 개 허용';
