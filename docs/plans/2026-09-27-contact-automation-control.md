# 연락처 자동화 제어 구현 계획

## 승인된 방향

최대 10회 ManyChat 대체 PR 루프의 4회차로 연락처별 자동화 중지·재개를 추가한다.
기존 main 작업 공간과 `codex/contact-automation-control` 브랜치를 사용한다.
병합은 운영자가 수행하고 운영 마이그레이션·배포·실발송은 하지 않는다.

## 순서와 검증

1. API와 DB 소유권·타입·중지·재개 테스트 및 두 발송 경로의 중지 회귀 테스트를 실패시킨다.
   검증: 지정 DB 테스트의 실제 API 상태와 Meta transport 호출 횟수.
2. 마이그레이션 011, 스키마, 관리자 적용 목록과 서버 접근 목록을 추가한다.
   검증: 재실행과 RLS·API 역할 거부·서버 DELETE 권한 부재.
3. 설정 API·연락처 상태 조회를 구현한다.
   검증: 실제 로컬 DB의 작업 공간·연결·작성자 격리와 정확한 본문.
4. 선점·확인 수신·큐 대상·검증 후·최종 발송 guard에 중지 조건을 적용한다.
   검증: 중지 전후 경쟁, 재개, 기간 만료, 기존 unknown 보존과 다른 연락처 처리.
5. 연락처 카드에 현재 상태와 중지·재개 컨트롤을 추가한다.
   검증: 합성 서버를 사용하는 실제 브라우저의 저장·실패·초안 보존·로그아웃 응답과 데스크톱·390px 캡처.
6. `corepack pnpm check-types`, `corepack pnpm test`, 별도 로컬 DB의 `corepack pnpm test:db`, `corepack pnpm test:cloudflare`, 명시적 경로 Trunk를 실행한다.
7. 서버 전달·데이터 경계와 화면 상태를 독립적으로 적대적 리뷰하고 확인된 오류만 수정한다.
8. DB/API·워커·화면·문서를 의미 단위로 커밋하고 PR을 만든다.
   현재 head의 CI·코드·보안 리뷰와 운영자 시각 승인을 거친다.

## 소유 경로

루트가 `db/schema.sql`, `db/migrations/011_contact_automation.sql`, `deploy/migrate-multi-user.sql`, `deploy/supabase-access.sql`, `src/app/contacts.ts`, `src/app/api.ts`, `src/instagram/reply-worker.ts`, `src/instagram/follow-flow.ts`, `src/instagram/node-delivery.ts`, `src/cloudflare/index.ts`, `public/app/app.js`, 기존 API·DB·workerd 테스트와 본 문서·사양·검증 노트를 수정한다.
테스트 파일과 의존성을 새로 등록하지 않고 기존 선언된 테스트 파일에 실제 회귀를 추가한다.
리뷰 에이전트는 읽기 전용이며 커밋과 최종 검증은 루트가 수행한다.

## 위험

중지 확인과 외부 POST의 간격은 제거할 수 없다.
최종 guard가 차단 가능한 요청과 이미 전달된 요청을 구분하며 원자적 취소를 약속하지 않는다.
재개는 대기 메시지를 다시 처리할 수 있으므로 화면에서 명시적으로 안내한다.
중지 중 DM 본문은 저장하지 않아 확인 메시지를 재개 뒤 자동 복원하지 않는다.
