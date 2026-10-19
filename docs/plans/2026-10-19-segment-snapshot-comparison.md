# Segment Snapshot Comparison Implementation Plan

> **For agentic workers:** Use native execution in the assigned workspace after direction approval.
> The root agent owns edits, checks, commits, and the PR lifecycle.

**Goal:** 고정 대상에 남아 있는 명단과 현재 저장된 세그먼트의 추가·제외·유지 인원 수를 관리자가 확인하도록 합니다.

**Architecture:** 기존 고정 대상 모듈에 읽기 전용 비교 API를 추가합니다.
현재 세그먼트의 조건 파서와 SQL을 재사용하고 한 읽기 트랜잭션에서 집계합니다.
기존 상세 화면에 비교 버튼과 결과만 추가합니다.

**Tech Stack:** Node.js >=24, strict TypeScript, PostgreSQL, `pg`, `node:test`, 빌드 없는 JavaScript 클라이언트입니다.

**Spec:** [고정 대상과 현재 세그먼트의 차이](../specs/2026-10-19-segment-snapshot-comparison.md)

## 제약과 소유 범위

- 구현은 방향 승인 이후 현재 주 작업 공간에서 순차 실행합니다.
- 새 의존성·스키마·마이그레이션·발송·운영 변경을 추가하지 않습니다.
- root가 아래 파일만 수정하고 인접 코드는 리팩터링하지 않습니다.
- `src/app/segment-snapshots.ts`, `src/app/api.ts`: 읽기 전용 비교와 라우팅을 담당합니다.
- `src/app/segment-snapshots.db.test.ts`: 실제 DB 집합·권한·일관성 회귀를 담당합니다.
- `src/cloudflare/runtime.db.test.mjs`: 기존 고정 대상 workerd 시나리오에 API 검사를 추가합니다.
- `public/app/segment-snapshots.js`, `public/app/index.html`, `public/app/app.js`, `src/app/segment-snapshots.test.ts`: 상세 비교 화면과 클라이언트 상태 검사를 담당합니다.
- 이 명세·계획, 기존 고정 대상 명세, `CLAUDE.md`, 해당 검증 노트와 수용 매트릭스의 직접 관련 주장만 갱신합니다.
- `README.md`, `AGENTS.md`는 최종 구현으로 부정확해진 주장이 있는 경우에만 수정합니다.
- 기존 테스트 파일을 확장하므로 `package.json`과 잠금 파일은 수정하지 않습니다.

## 검토할 실패 경로

- 총인원은 같고 구성원만 바뀌는 경우: 추가·제외를 모두 집계해야 합니다.
- 연결이 다르고 sender 문자열이 같은 경우: 서로 다른 연락처여야 합니다.
- 개인정보 삭제 이후의 비교: 사라진 식별자를 복원하지 않아야 합니다.
- 세그먼트 편집·역할 변경·삭제가 동시에 일어나는 경우: 한 응답의 읽기 스냅샷이 일관돼야 합니다.
- 화면 전환 또는 새 비교 뒤 도착하는 이전 응답: 결과를 덮어쓰지 않아야 합니다.

## 작업 1: 비교 API와 실제 DB 검사

**Interface:** `compareSegmentSnapshot(pool: Pool, user: User, snapshotId: string, options?: URLSearchParams)`를 `src/app/segment-snapshots.ts`에서 내보냅니다.
응답은 명세의 필드와 십진수 문자열 집계를 그대로 사용합니다.

- [ ] 기존 DB fixture에 고정 당시 `{A,B}`, 현재 `{B,C}`를 만들고 `original=2`, `baseline=2`, `current=2`, `added=1`, `removed=1`, `retained=1`을 검사하는 테스트를 추가합니다.
- [ ] API의 404 경로로 먼저 실행해 의도한 동작 부재를 확인합니다.
- [ ] `REPEATABLE READ READ ONLY` 안에서 멤버십·역할을 다시 읽고, 소유한 고정 대상과 활성 세그먼트 버전·조건을 읽습니다.
- [ ] `savedSegmentConditions`와 `segmentConditionSql`을 재사용해 현재 집합을 한 번 평가하고 SQL에서 기준 명단과 집계합니다.
- [ ] `/api/segment-snapshots/<id>/comparison`을 기존 상세 라우트 앞에 연결합니다.
- [ ] 빈 명단, 50명·5,000명 초과, 같은 sender의 다른 연결, 다른 작업 공간, 비관리자·제거된 멤버, 잘못된 ID·쿼리, 보관한 세그먼트를 검사합니다.
- [ ] 기존 조건별 fixture를 재사용하고 같은 평가 시각의 `listContacts` 결과와 대조합니다.
- [ ] 실제 삭제 함수를 실행해 `original`과 `baseline` 차이를 검사하고 저장한 명단·집계·정의가 비교로 바뀌지 않는지 확인합니다.
- [ ] 첫 트랜잭션 읽기 뒤 두 번째 연결에서 필터 수정·삭제를 커밋해 이번 응답은 이전 상태, 다음 응답은 새 상태를 읽는지 확인합니다.
- [ ] 읽기 격리를 READ COMMITTED로 바꾼 통제 실험에서 동시성 회귀가 의도한 오류로 실패하는지 확인한 뒤 원래 구현을 복구합니다.
- [ ] 최소 검사: `TEST_DATABASE_URL=<disposable-local-automations_test> node --test --test-concurrency=1 src/app/segment-snapshots.db.test.ts`에서 모든 비교 회귀가 통과해야 합니다.

## 작업 2: 상세 화면과 workerd 연결

**Interface:** 기존 `createSegmentSnapshots({api, node, connectionLabel})` 및 반환 API를 유지합니다.

- [ ] `src/app/segment-snapshots.test.ts`에 비교 클릭·실패·늦은 응답·초기화·미저장 수정·동일 ID의 버전 변경 테스트를 추가하고 구현 전 의도한 실패를 확인합니다.
- [ ] 상세에 버튼과 `aria-live` 결과 영역을 추가하고, `generation`·현재 명단 ID·요청 번호로 이전 응답을 버립니다.
- [ ] 새 비교·다른 명단·세션 초기화·필터 버전 변경 때 결과를 지우고, 서버 오류가 나면 오류만 표시합니다.
- [ ] 명세의 집계·기준·시각·버전을 표시하며, 미저장 수정 중에는 버튼을 비활성화합니다.
- [ ] `runtime.db.test.mjs`의 기존 고정 대상 시나리오에서 실제 Worker GET의 집계·비관리자 거절·다른 작업 공간 격리를 확인합니다.
- [ ] 최소 검사: `node --test src/app/segment-snapshots.test.ts`, `corepack pnpm check-types`가 통과해야 합니다.
- [ ] 합성 로컬 페이지에서 추가·제외·유지, 삭제 후 기준 수, 버전 차이, 보관된 세그먼트 오류를 실제 브라우저로 확인하고 좁은 화면도 검사합니다.
- [ ] 캡처는 `/Users/dongminyu/Development/01_personal/pr-loop-reviews/auto-chatter/2026-10-19-segment-snapshot-comparison/`에 보존합니다.
      리뷰 문서에 시나리오·HEAD·제한을 기록하고 병합 전 운영자의 화면 승인을 받습니다.

## 작업 3: 문서·최종 검사·PR

- [ ] 실제 구현과 이 명세의 API·집합 기준·권한·격리·오류·화면 무효화 계약을 대조합니다.
- [ ] `CLAUDE.md`, `README.md`, `AGENTS.md`, 기존 고정 대상 명세·수용 매트릭스의 관련 주장을 검사하고 이번 변경으로 달라진 내용만 같은 PR에 반영합니다.
- [ ] 격리된 로컬 DB에서 `corepack pnpm check-types`, `corepack pnpm test`, `corepack pnpm test:db`, `corepack pnpm test:cloudflare`를 실행합니다.
      테스트는 로컬 기능을 검사하며 운영 배포나 공급자 권한을 증명하지 않습니다.
- [ ] 명시한 변경 경로에만 `trunk fmt <paths>`와 `trunk check <paths>`를 실행하고 `git diff --check`를 확인합니다.
- [ ] 최종 diff 규모와 핵심 경계를 기준으로 적정 깊이의 로컬 반대 검토를 수행하고 수정 사항을 재검증합니다.
- [ ] 검증한 한 기능을 `feat(segments): compare frozen targets with the current segment` 커밋으로 묶는 계획을 알린 뒤 root가 명시한 경로만 스테이징합니다.
- [ ] 브랜치를 푸시하고 #26을 참조하는 PR을 만듭니다.
      전체 이슈를 자동 종료하는 `Closes` 문구는 사용하지 않습니다.
- [ ] hosted review 시작 전에 공개 저장소 기본 한도인 최대 5회·5시간을 기록하고, CI·현재 HEAD 리뷰·미해결 스레드를 확인합니다.
- [ ] 필수 검사와 리뷰가 통과하면 화면 승인을 요청하고 병합은 운영자에게 맡깁니다.
      기본 병합 방식은 merge commit이며 실제 커밋 이력을 보고 최종 추천합니다.

## 현재 상태

운영자가 명세와 계획을 승인했고 구현·로컬 검증·독립 검토와 발견한 문제의 수정을 마쳤습니다.
#26 전체의 선행 조건 충족을 의미하지 않으며, #25의 미구현 식별자 병합·분리를 요구하지 않는 조회 비교에 한정합니다.
브랜치·원격 삭제와 메모리 기록은 요청받지 않았습니다.

## 검토 후 보완

실제 이름 입력 핸들러가 비교 무효화 경로를 호출하지 않는 문제를 확인했습니다.
`public/app/app.js`의 해당 콜백을 기존 `segmentControls()`에 연결하는 최소 수정과 실제 콜백·조건 검사·컨트롤러를 실행하는 회귀를 소유 범위에 포함했습니다.
새 제품 방향이나 리팩터링을 추가하지 않았습니다.
