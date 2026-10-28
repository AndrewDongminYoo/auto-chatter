# 품질 도구 및 의존성 갱신 계획

## 작업 및 성공 기준

1. 저장소 지침, 직접 의존성, 상위 패키지의 고정 버전과 기존 예외를 확인합니다. 검증: manifest, 잠금 파일, 공식 레지스트리와 권고를 비교합니다.
2. 호환되는 manifest와 Trunk 설정을 준비하고 오프라인 리더를 CI에 연결합니다. 검증: 리더가 없는 음성 대조군은 실패하고, 실제 리더 회귀 테스트는 통과해야 합니다.
3. 실행 슬롯을 확보한 뒤 기존 잠금 파일을 유지한 채 pnpm으로 갱신합니다. 검증: 생성된 잠금 파일을 다시 frozen 설치하고 실제 전이 의존성 그래프를 확인합니다.
4. 타입, 단위, 격리 DB와 workerd 검사를 순차 실행합니다. 검증: 아래 명령과 전체 Trunk 무수정 검사가 통과해야 합니다.
5. 실제 취약점 및 비밀 탐지기의 음성·정상 대조군과 잠금 파일 검사를 확인합니다. 검증: 의도한 결함을 탐지한 뒤 제거한 입력에서 통과해야 하며, 필요한 예외는 권고별 근거를 갖춰야 합니다.
6. 변경된 명령과 설정을 `CLAUDE.md` 및 이 문서에 대조하고 로컬 검토를 마칩니다. 검증: scoped diff, 내부 경로와 링크, `git diff --check`를 확인합니다.
7. 루트 작업자가 로컬 커밋과 검토 자료를 준비한 후 저장소별 공개 승인을 요청합니다. 검증: 승인 전에는 push나 PR을 만들지 않습니다.

## 실행할 명령

다음 명령은 자격 증명을 제거한 자식 프로세스에서 실행합니다.
잠금 파일 생성과 전체 검사는 실행 슬롯 확보 전까지 대기합니다.

```bash
corepack pnpm update --depth Infinity
corepack pnpm install --frozen-lockfile
corepack pnpm check-types
corepack pnpm test
python3 -m unittest discover -s .trunk/configs/tests -p 'test_*.py' -v
corepack pnpm why sharp undici --depth 1
corepack pnpm audit --audit-level low --json
trunk check --filter=osv-scanner --no-fix pnpm-lock.yaml
trunk check --all --no-fix --jobs=2
git diff --check
```

`corepack pnpm test:db`와 `corepack pnpm test:cloudflare`는 각각 검토한 테스트 소스의 로컬 DB 가드를 확인한 뒤 실행합니다.
`TEST_DATABASE_URL`은 전용 UTF8 클러스터의 `automations_test` DB만 가리켜야 합니다.
Cloudflare 테스트의 빌드 스크립트는 `wrangler deploy --dry-run --env-file /dev/null`이며, 배포를 실행하지 않습니다.
Wrangler와 Miniflare 조합의 보류 사유와 예외 판단 기준은 [명세](../specs/2026-10-28-quality-refresh.md)에 기록합니다.

## 실행 확인

로컬 타입 검사, 단위 테스트와 리더 회귀 테스트를 통과했습니다.
새 UTF8 PostgreSQL 클러스터의 데이터 경로와 빈 DB를 확인한 뒤 DB 테스트와 workerd 검증을 순차 실행했습니다.
첫 DB 실행의 시각 비교 실패를 조사하면서 `Date` 리더의 정밀도 손실을 실제 SQL 대조군으로 확인했으며, 해당 테스트만 보정한 뒤 전체 DB와 workerd 검증을 통과했습니다.
첫 실패 당시의 원시 마이크로초 값은 기록하지 않았으므로, 그 실행에서도 정밀도 손실이 직접 원인이었는지는 확정하지 않습니다.
자식 프로세스의 홈과 CLI 설정 경로는 임시 디렉터리로 분리했으며, 검증 후 전용 서버를 종료하고 열린 파일이 없는 임시 디렉터리를 제거했습니다.
전체 Trunk, 실제 스캐너 대조군과 지식 점검 결과까지 확인한 다음 로컬 커밋과 저장소별 PR 승인 요청을 진행합니다.
