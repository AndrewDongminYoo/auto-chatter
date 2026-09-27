# DM 문맥 조회 검증 기록

## 범위

[계약](../specs/2026-09-27-inbox-handoff-contract.md)과 [계획](../plans/2026-09-27-inbox-handoff-contract.md)의 읽기 전용 API를 검증합니다.
성공한 공급자 응답이 댓글 작성자와 DM 상대를 연결하는 경우만 근거로 사용합니다.
수동 발송·상담 전환 쓰기·UI·운영 배포는 이번 검증 대상이 아닙니다.

## 실패에서 성공으로

문맥 API 구현 전 실제 API·PostgreSQL 테스트 7건에서 새 경로의 404 응답을 관찰했습니다.
검사 실패는 예상한 200 응답과 달랐기 때문이며 fixture 오류가 아니었습니다.
구현 후 같은 7건이 통과했습니다.
성공 근거, 동일 숫자 추정 금지, 오래된 근거, 충돌, 중복, 현재 중지 상태, 실패·불명확·미래·원본 불일치 근거 제외와 계정·작업 공간 격리를 확인했습니다.

## 실행 결과

- `corepack pnpm check-types`: strict TypeScript 검사 통과.
- `corepack pnpm test`: 인증·정책·전송 모의 계약 등 기존 테스트 101건 통과.
- `TEST_DATABASE_URL=<isolated-local-db> corepack pnpm test:db`: 실제 PostgreSQL의 API·정책·중복·마이그레이션 검사 122건 통과.
- `TEST_DATABASE_URL=<isolated-local-db> corepack pnpm test:cloudflare`: 빌드한 Workers 코드·Hyperdrive·제한된 서버 역할·웹훅·큐 검사 25건 통과.
- 문맥 경로 추가 후 `node --test --test-name-pattern='workerd contact API' src/cloudflare/runtime.db.test.mjs`: 실제 workerd에서 근거 없는 대화의 `unmapped`·민감 본문 제외·다른 작업 공간 404 확인.

Docker 대신 설치된 PostgreSQL 17.11로 전용 임시 클러스터와 `automations_test` DB를 사용했습니다.
운영 Supabase나 Instagram 계정에는 접근하지 않았습니다.

## 해석 한계

`verified`는 보관된 성공 응답의 근거 상태이며 공급자의 현재 신원 확인·마케팅 동의·발송 권한을 뜻하지 않습니다.
조회 후 중지·연결·토큰 상태가 바뀔 수 있으므로 수동 답장 구현에서 트랜잭션과 발송 직전 guard가 필요합니다.
현재 구현에는 상담 전환 상태 변경과 수동 발송이 없습니다.
실제 계정 권한·운영 마이그레이션·수동 메시지 수신은 별도 이슈의 수용 기준으로 남깁니다.

## 로컬 적대적 검토

식별자·SQL·권한·개인정보 경계를 독립적으로 검토했고 구현 결함은 발견하지 못했습니다.
마지막 수신 시각 상한과 보관 시작 시각 없음의 테스트 공백은 같은 DB 사례에 추가했습니다.
`last_message_at < sent_at < now()` 근거의 시간 상한을 잠시 제거하면 예상한 `unmapped` 대신 `verified`가 되어 검사에 실패하며, 필터 복원 후 전체 DB 테스트 122건이 다시 통과했습니다.

문서의 내부 링크·앵커 55개와 등록한 GitHub 작업 53건의 매트릭스 대응을 검사했습니다.
존재하지 않는 링크·앵커와 누락된 작업의 부정 사례를 먼저 거부하는 것도 확인했습니다.

Trunk는 전체 파일 140개의 설정된 형식·Markdown·비밀값·의존성 검사에서 문제를 보고하지 않았습니다.
이 검사는 공급자 권한이나 실발송을 검증하지 않습니다.

최종 Cloudflare 재검사에서 기존 팔로우 guard fixture가 한 번 실패했고 단독 실행은 통과했습니다.
해당 fixture는 PostgreSQL 발송 시각 직후의 JavaScript 밀리초 시각을 사용하므로 `reply.sent_at<=message.timestamp` 준비 조건이 시각 정밀도에 영향을 받습니다.
테스트의 발송 시각을 확인 메시지보다 앞서도록 고정하고 guard 진입 전 `pending` 상태도 검사하도록 보강했습니다.
운영 발송 정책은 변경하지 않았습니다.

독립 계약·문서 검토에서 공급자별 상대 ID 누락 조건, 상태 판정 우선순위, 확인된 세션·멤버십·캐시 금지 경계의 설명 부족을 확인했습니다.
현재 전송기·인증 코드와 대조한 뒤 명세에 보강했습니다.
매트릭스의 53개 이슈 번호·제목과 조회 구현·쓰기 미구현 구분도 독립 검토에서 확인했습니다.
