# 첫 비공개 답장 실발송 테스트

## 승인과 현재 단계

운영자가 아래 설정의 실제 DM 발송 테스트를 명시적으로 승인했습니다.
새 테스트 댓글의 outbox 상태 `sent` 1개와 공급자 메시지 ID 저장을 확인했고, 운영자가 DM 수신·답장 완료를 보고했습니다.
첫 DM 테스트 종료 시 규칙·계정·전역 발송 스위치를 모두 다시 중지했습니다.
이 규칙은 비활성화 상태이며, 이후 승인된 팔로우 분기 테스트의 현재 스위치는 [별도 기록](2026-09-26-live-follow-test.md)에 있습니다.
이 테스트는 첫 DM 전달을 확인하며 팔로우 조건별 분기는 이후에 설정·검증합니다.

| 설정        | 승인한 값                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| 연결 계정   | `ai.you.wanted`                                                              |
| 게시물 ID   | `18178820404442752`                                                          |
| 댓글 키워드 | `auto-chatter 발송 테스트`                                                   |
| 일치 모드   | `exact`                                                                      |
| 첫 DM       | 자동 메시지 발송 테스트입니다. 메시지가 도착하면 ‘확인’이라고 답장해 주세요. |
| 팔로우 조건 | 비활성화                                                                     |
| 규칙 ID     | `66953485-9a87-4cc4-845d-21d01dea7b24`                                       |
| 연결 ID     | `a5df4215-fb1e-46d4-93f4-13c0176fb031`                                       |

활성화 직전 운영 DB의 연결은 1개이며 발송 활성 계정·규칙·outbox·팔로우 대화는 모두 0개였습니다.
대상 계정의 소유권·수신 활성화·유효한 암호화 토큰을 확인한 뒤 하나의 트랜잭션에서 승인한 규칙을 만들고 계정 발송을 활성화했습니다.
기존 댓글을 발송 대기 행으로 재처리하지 않았습니다.
정확한 키워드에 일치하는 새 댓글만 대상이며, 규칙 자체가 특정 댓글 작성자만 허용하는 기능을 제공하지는 않습니다.
같은 게시물·작성자의 중복 발송은 기존 outbox 고유 제약으로 방지합니다.

## 실제 수신과 소유권 검사 수정

OAuth 연결 이후 `auto-chatter OAuth 수신 테스트` 댓글이 `2026-09-26T09:47:50.487Z`에 운영 DB에 저장됐습니다.
댓글 ID는 `17977056680918358`이며 당시 작업 공간의 댓글은 3개, 규칙·outbox는 0개였습니다.

발송 전 읽기 검증에서 `media_unverified`가 발생했습니다.
실제 Meta GET 응답에서 `/me.user_id`는 `17841437471464257`, 같은 프로필의 `id`는 `28940268062328479`이고 대상 게시물의 `owner.id`는 후자였습니다.
기존 transport가 소유자 ID를 저장된 `user_id`와만 비교해 정상 게시물을 차단했습니다.

`profile.user_id`가 저장된 계정과 일치한 후에만 같은 응답의 숫자형 `profile.id`를 소유자 별칭으로 인정하도록 수정했습니다.
별칭으로 작성한 자기 댓글도 검증 결과의 선택적 `isOwnComment`를 통해 워커와 직접 발송 경로에서 차단합니다.
공개 `inspectAccount()` 결과 형태는 유지하며 잘못된 토큰·타 계정 소유자·형식이 잘못된 별칭은 발송을 승인하지 않습니다.

## 검증 근거

수정 커밋은 `2e76925`입니다.

```bash
node --test --test-name-pattern='scoped' src/instagram/instagram-login-private-reply.test.ts
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test node --test --test-name-pattern='verified scoped' src/instagram/reply-worker.db.test.ts
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:cloudflare
```

- Mutation proof: ID 처리와 워커 자기 댓글 검사를 되돌리면 단위 회귀 테스트 2개가 `false !== true`·`undefined !== true`로 실패하고 DB 회귀 테스트는 발송 호출 `1 !== 0`으로 실패했습니다.
  복원 후 scoped 단위 테스트 3개와 DB 회귀 테스트 1개가 통과했습니다.
- Blast radius: Node CLI·Cloudflare transport 생성자·직접 발송 경로와 Facebook transport의 기존 정책 경로를 확인했습니다.
  최종 단위 테스트 79개·DB 통합 테스트 77개·Cloudflare 테스트 20개가 통과했고 해당 호출 경로의 미검증 테스트 파일은 없습니다.
- Invariant: 저장 계정과 일치하는 프로필에서 얻은 ID만 소유권 비교에 사용하고, 검증된 자기 댓글 표시는 원래 자기 댓글 검사와 OR로 결합합니다.
  `src/instagram`·`src/cloudflare`·`src/app`에서 호출부·`media.owner.id`·`isOwnComment`를 검색했습니다.
  Facebook Login의 별도 계정 검증 경로는 변경하지 않았습니다.
- Claim audit: 마지막 코드·fixture 편집 후 타입 검사, 단위 79개·DB 77개·Cloudflare 20개, scoped Trunk 및 diff 공백 검사를 실행했습니다.
  workerd fixture에도 서로 다른 `id`·`user_id`와 별칭 게시물 소유자를 설정해 해당 런타임 경로를 실행했습니다.
- 로컬 코드 리뷰와 적대적 계정·소유권 리뷰에서 추가 발견 사항은 없었습니다.
  리뷰 이후 추가한 workerd fixture 두 줄은 루트 에이전트가 검토하고 실행했습니다.
- 실제 저장 토큰으로 읽기 검증을 다시 실행해 `authorizationVerified=true`, `mediaOwned=true`, 정책 `eligible=true`를 확인했습니다.
  이 검증은 실제 발송 POST를 호출하지 않았습니다.
- 개인 계정 `auto-chatter` Oracle에서 `live send`·`send switches`, `SEND_ENABLED`·`outbox` 선례는 `[no precedent found]`였습니다.
  조회 provenance는 `c1681868ac634e4b2414874716bb75a7864113c4`이며 위키 최신성은 별도로 확인하지 않았습니다.

## 배포와 중지 절차

테스트 활성화 Worker 버전은 `7b37391d-8893-4ecd-8ee3-9b21ee9eb2c7`입니다.
기존 secrets를 유지하고 CLI override로 `SEND_ENABLED=true`를 배포했습니다.
저장소 `wrangler.json`의 기본값은 `false`이므로 평소 배포 명령은 전역 발송을 다시 중지합니다.
아래 명령은 당시 실행 기록이며 재활성화 절차가 아닙니다.
`--tag`는 Worker 버전 라벨이며 Git 커밋을 선택하지 않습니다.
Wrangler는 현재 checkout의 소스를 배포하므로 재활성화 전에는 별도 발송 승인, `git status --porcelain`의 빈 결과, `git rev-parse HEAD`와 검증한 커밋의 일치 및 해당 소스의 검증 결과를 확인해야 합니다.

```log
corepack pnpm exec wrangler deploy --env-file /dev/null --var SEND_ENABLED:true --tag 2e76925 --message 'Approved first private DM test on media 18178820404442752'
```

새 테스트 댓글 ID `18118106431983091`의 outbox 행 `1`은 `sent`이며 공급자 메시지 ID가 있고 실패 코드는 없습니다.
승인한 키워드·게시물과 일치하며, 해당 규칙의 전체 outbox 1개·sent 1개·미완료 0개를 다시 조회했습니다.
운영자가 실제 DM 수신과 ‘확인’ 답장을 보고했습니다.
이번 규칙은 팔로우 조건이 비활성화돼 팔로우 대화·확인 receipt는 0개입니다.
`ingestMessages`는 활성 팔로우 대화의 확인 키워드와 일치할 때만 receipt를 저장하므로 이 답장 보고만으로 서버의 조건별 후속 경로를 검증했다고 간주하지 않습니다.

`unknown`은 재시도하지 않으며 오류 시 설정을 중지하고 원인을 확인합니다.
첫 DM 결과 확인 후 규칙 `66953485-9a87-4cc4-845d-21d01dea7b24`의 `enabled`와 연결 `a5df4215-fb1e-46d4-93f4-13c0176fb031`의 `send_enabled`를 한 트랜잭션에서 `false`로 변경했습니다.
DB 재조회에서 발송 활성 계정·규칙 0개를 확인했으며 수신 연결의 `active=true`는 유지했습니다.
전역 스위치는 아래 기본 배포 명령으로 `false`를 복원했고 현재 Worker 버전은 `979de5bb-bc68-4af9-a9f8-5ec82e95c56f`입니다.

```bash
corepack pnpm exec wrangler deploy --env-file /dev/null --tag 2e76925 --message 'Stop completed first private DM test'
```

다음 팔로우 조건별 실발송 테스트는 다른 게시물 또는 다른 댓글 작성자를 사용해야 합니다.
같은 연결·게시물·작성자는 이미 첫 DM을 받았으므로 기존 중복 방지 제약에 의해 새 첫 DM을 만들지 않습니다.
기존 sent 행을 삭제하거나 재시도 상태로 되돌려 테스트하지 않습니다.
