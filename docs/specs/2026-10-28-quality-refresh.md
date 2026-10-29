# 품질 도구 및 의존성 갱신

## 승인된 범위

호환되는 의존성과 기존 품질 도구를 갱신합니다.
공개 API, Node.js `>=24`, 애플리케이션 동작, DB 스키마, 배포 설정과 실제 발송 경로는 유지합니다.
잠금 파일은 pnpm 10으로 생성하며 직접 수정하지 않습니다.

## 갱신 기준

| 항목            | 준비한 버전 또는 정책                                                                                     | 근거                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm            | `10.34.9`                                                                                                 | [npm 레지스트리](https://registry.npmjs.org/pnpm/10.34.9)에 등록된 10 계열 안정 버전을 사용합니다.                                                                                                       |
| TypeScript      | `7.0.2`                                                                                                   | [공식 릴리스](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)의 CLI 계약과 기존 `NodeNext`, `strict`, `noEmit`, 명시적 Node 타입 구성을 비교했으며, 실제 타입 검사를 통과했습니다. |
| Node 타입       | `26.6.6`                                                                                                  | 실제 npm 메타데이터와 생성된 잠금 파일을 확인했으며, 로컬 Node `24.22.1`에서 타입 검사와 테스트를 통과했습니다.                                                                                          |
| 기존 Trunk 도구 | OSV Scanner `2.7.0`, Prettier `3.9.10`, TruffleHog `3.99.7`, Markdownlint CLI `0.50.0`, Yamllint `1.38.0` | 기존 검사 범위를 유지하고 준비 시점에 확인한 릴리스 버전을 사용합니다.                                                                                                                                   |
| Pinact          | `4.1.1!`, `commands: [lint, upgrade]`                                                                     | [지정 릴리스](https://github.com/suzuki-shunsuke/pinact/releases/tag/v4.1.1)를 고정합니다.                                                                                                               |
| Undici          | `undici@>=7 <8`에 `^7.30.1` override                                                                      | [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)의 7 계열 수정 버전을 하한으로 사용합니다.                                                                                       |

상위 패키지가 정확히 고정한 전이 의존성은 권고나 소비자의 호환성 요구가 없는 한 강제로 바꾸지 않습니다.
기존 Sharp override는 수정 버전 `0.35.5`를 유지합니다.
OSV 예외는 실제 잠금 파일 검사와 도달 가능성 근거를 먼저 확인한 후, 호환되는 수정 경로가 없을 때만 개별적으로 검토합니다.
호환성 보류 때문에 수정된 상위 패키지를 적용할 수 없다면 예외를 추가하기 전에 범위 결정을 요청하며, 이를 수정 버전이 없는 경우로 기록하지 않습니다.

## Cloudflare 런타임 호환성 보류

Wrangler `4.116.0`과 Miniflare `4.20260730.0`의 기존 조합을 유지합니다.
이는 전체 최신 버전이라는 뜻이 아니라 현재 테스트 API를 보존하기 위한 보류입니다.
실행 중 확인한 최신 안정 Wrangler `4.155.0`은 Miniflare `5.20261023.2-beta`를 요구합니다.
[Miniflare v5 변경 기록](https://github.com/cloudflare/workers-sdk/blob/miniflare%405.20261023.1-beta/packages/miniflare/CHANGELOG.md)의 `5.20260804.0-alpha` 항목은 평면 생성자 옵션과 자동 `modules: true` 모듈 탐색을 제거합니다.
현재 `src/cloudflare/runtime.db.test.mjs`의 `new Miniflare` 호출은 해당 평면 API를 사용합니다.
공식 `convertV4MiniflareOptions()`를 통한 변환은 별도 테스트 하네스 변경으로 검토할 수 있으며, 이번 준비 범위에는 포함하지 않습니다.

## 검증 중 보정한 테스트

구독 상태 확인 DB 테스트의 엄격한 시각 비교는 PostgreSQL에서 저장한 마이크로초를 읽어야 합니다.
기본 `pg` 파서가 반환하는 JavaScript `Date`는 밀리초까지만 유지하므로, 서로 다른 DB 시각이 같은 값으로 비교될 수 있습니다.
해당 테스트 한 곳에서 실제 열을 epoch 마이크로초 문자열로 읽고 `BigInt`로 비교하도록 보정했습니다.
기존 로그와 상태 검증, 엄격한 대소 비교, 애플리케이션 코드와 DB 스키마는 유지했습니다.
같은 밀리초에 속하는 두 DB 시각을 사용한 대조군에서 기존 `Date` 비교와 밀리초 절삭 변형은 거부됐고, 실제 테스트의 SQL 리더는 통과했습니다.

## 참고한 선례

개인 `auto-chatter` 선례는 `wiki/sources/auto-chatter--claude.md`, `raw/sources/auto-chatter/CLAUDE.md`, `wiki/entities/auto-chatter.md`에서 확인했습니다.
전용 DB 클러스터와 실제 workerd 검증을 사용하고, 로컬 성공을 운영 환경 검증으로 확대하지 않는 방향을 확인했습니다.
`wiki/concepts/auto-chatter-read-then-write-lock-tests.md`는 DB 실패에서 helper 정리와 제품 동작을 구분해야 한다는 근거를 제공합니다.
조회 원본 커밋은 `9670d54de3076c5239713f54900c7a855bd18478`이며, 원본 최신성과 일부 연결 목록의 완전성은 `UNVERIFIED/PARTIAL` 상태입니다.

## 검증과 공개 조건

- 오프라인 TruffleHog JSONL 리더는 원문 위치를 찾지 못해도 탐지 결과를 보존하고, 잘못된 레코드는 실패로 처리해야 합니다.
- 리더 회귀 테스트는 기존 CI의 lint 작업에서 실행합니다.
- TruffleHog의 `--no-verification`, `--no-update`, `copy_targets` 샌드박스와 리더 `direct_configs`를 유지합니다.
- 생성된 잠금 파일의 frozen 설치, 타입 검사, 단위 테스트, 순차 DB 테스트, 격리된 workerd 테스트와 전체 Trunk 무수정 검사를 통과해야 합니다.
- DB 테스트는 UTF8로 초기화한 폐기 가능한 로컬 `automations_test` DB를 사용합니다.
- Cloudflare 테스트는 역할과 스키마 권한을 변경하므로 전용 클러스터를 사용하고, 빌드는 `--env-file /dev/null`을 유지합니다.
- 검증은 상속된 실제 자격 증명을 제거한 자식 프로세스에서 실행하며, 실제 제공자 호출이나 발송을 허용하지 않습니다.
- 로컬 실행은 Node `24.22.1`과 PostgreSQL `17.11`을 사용했습니다. CI의 Node 26과 배포 컨테이너 검증은 hosted CI에서 별도로 확인해야 합니다.
- push와 PR 생성은 이 저장소에 대한 별도 승인이 필요합니다.
