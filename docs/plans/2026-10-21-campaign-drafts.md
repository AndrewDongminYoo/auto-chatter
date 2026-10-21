# 캠페인 초안 API 구현 계획

## 상태와 성공 기준

[제안 계약](../specs/2026-10-21-campaign-drafts.md)의 2026-10-21 방향 승인을 받아 구현을 진행했습니다.
아래는 승인된 작업 순서이며 실제 검증 결과는 [구현 검증](../notes/2026-10-21-campaign-drafts-verification.md)에 기록합니다.
현재 작업 공간을 사용하며 별도 worktree나 새 의존성은 만들지 않습니다.

1. 입력·권한·재시도·버전 계약 → 새 API의 의도한 실패를 관찰한 뒤 실제 PostgreSQL 테스트로 확인합니다.
2. 저장·내보내기·삭제·이동·접근 제어 → 실제 초안 행이 포함된 fixture로 기존 경계 검사를 통과합니다.
3. 기존 발송·원장 불변성 → 작업 전후 실제 행을 대조합니다.
4. 전체 검사·독립 리뷰·PR → 현재 HEAD에 대한 CI·호스티드 리뷰를 확인하고 운영자 병합을 요청합니다.

## 읽을 파일과 변경 범위

`src/app/segment-snapshots.ts`, `reply-templates.ts`, `settings.ts`, `workspace-members.ts`, `workspace-export.ts`, `workspace-fixture.ts`, `api.ts`와 기존 DB·Cloudflare 접근 제어 검사를 우선 읽습니다.
`db/schema.sql`, 다음 사용 가능한 마이그레이션, `deploy/migrate-multi-user.sql`, `deploy/supabase-access.sql`, `deploy/init-app-user.sh`에 저장·권한·삭제를 반영합니다.
새 `src/app/campaign-drafts.ts`와 단위·DB 테스트를 추가하고 `package.json`의 명시적 테스트 목록을 갱신합니다.
CLAUDE·직접 관련 계약·수용 현황을 구현과 같은 PR에서 갱신합니다.
공개 화면 파일과 발송 경로는 수정하지 않습니다.

## 구현 순서

1. Oracle 선례와 승인된 계약을 확인합니다. 최초 생성 요청 재시도를 수정 이후에도 판별하는 최소 저장 형태와 잠금 순서를 정합니다.
2. 새 API를 통해 입력 오류, 다른 작업 공간, 상담원 역할, 중복 생성, 버전 충돌, 한도 경합의 실패를 관찰합니다.
3. 트랜잭션·저장·조회 API를 구현하고 원본·현재 명단 수를 구분합니다. 불필요한 범용 캠페인 상태 기계나 발송 추상화는 추가하지 않습니다.
4. 스키마와 마이그레이션, 작업 공간 삭제·내보내기·이동, RLS와 역할 권한을 함께 구현합니다. 단순 shape 검사가 아닌 실제 행을 읽는 fixture를 사용합니다.
5. 기존 스키마에서 전체 migration runner를 적용한 결과와 새 설치의 제약·권한·삭제 함수를 대조합니다.
6. 최소·전체 검증과 핵심 영역에 맞는 독립 읽기 전용 리뷰를 수행합니다. 확인된 수정은 순차 적용하고 영향을 받은 검사와 문서를 갱신합니다.
7. 기능·테스트·문서를 일관된 커밋으로 만들고 PR을 엽니다. 이슈 참조는 `Related to #35`로 쓰며 GitHub `closingIssuesReferences`가 비어 있는지 확인합니다.

## 위험과 검증

주요 위험은 생성 재시도와 수정 상태의 혼동, 작업 공간 간 명단 참조, 삭제·이동 누락, 동시 한도 초과입니다.
발송 권한으로 오해할 수 있는 필드나 응답은 만들지 않습니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/automations_test corepack pnpm test:cloudflare
```

DB·Worker 검사는 전용 임시 PostgreSQL에서 순차 실행하고 운영 연결은 사용하지 않습니다.
Trunk는 실제 변경 경로만 명시해 실행합니다.
호스티드 리뷰는 public 저장소 기준 최대 5라운드·5시간으로 제한하며 첫 트리거 직전에 시작 시각과 마감 시각을 기록합니다.
병합은 운영자가 수행하며, 새 루프의 병합 후 브랜치 정리·메모 기록은 아직 요청되지 않았습니다.
