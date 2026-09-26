# 다중 사용자 자동화 배포 전환

## 현재 상태

다중 사용자 기능은 로컬 구현과 합성 데이터 검증을 마쳤으며 아직 운영에 배포하지 않았습니다.
운영 발송은 `SEND_ENABLED=false`를 유지합니다.
실제 Instagram 발송·OAuth 로그인 성공이나 타인 계정의 Advanced Access 승인 완료는 검증하지 않았습니다.

설정 화면은 `/app/`입니다.
첫 버전은 기존 Worker의 정적 자산과 vanilla JavaScript를 사용해 프레임워크·런타임 의존성을 추가하지 않았습니다.
게시물 숫자 ID를 직접 입력하며 게시물 선택기는 이 버전에 포함하지 않습니다.
토큰 만료 시각은 계정 목록에 표시하며, 자동 갱신 대신 만료 전에 계정을 다시 연결합니다.
규칙은 게시물별 하나이고 포함 키워드는 OR, 제외 키워드는 우선 적용합니다.
진행 중인 대화는 시작 시점의 문구를 사용하며 현재 계정·규칙 중지는 최종 발송 조건에 반영합니다.
설정 중지와 외부 POST는 하나의 원자적 작업이 아니므로 최종 확인 후 이미 시작한 요청까지 취소하지는 못합니다.
여러 게시물의 첫 DM을 받은 같은 사용자가 응답하면 가장 최근에 보낸 응답 대기 중인 대화 하나를 선택합니다.

## 검증

- `corepack pnpm check-types`: 엄격한 TypeScript 타입 검사.
- `corepack pnpm test`: 서명·키워드·세션·암호화·공급자 응답 분류를 mock으로 검증.
- `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db`: 사용자 간 격리, 일회성 OAuth state, 기존 소유권 배정, 조건별 DM 상태 및 중복·동시 처리를 실제 로컬 PostgreSQL로 검증.
- 같은 DB 환경에서 `corepack pnpm test:cloudflare`: workerd 번들·Hyperdrive·Queue 경로, API 역할의 접근 차단, 암호화 토큰별 계정 격리, 서명된 댓글 → 첫 DM → 미팔로우 안내 → 재확인 → 완료 DM을 합성 Graph 응답으로 검증.
- 독립 코드 리뷰와 적대적 발송 리뷰에서 발견한 세션 종료, 연결 해제 후 재활성화, 규칙 ID 변경, OAuth 완료 경쟁, 발송 직전 확인 및 수신자 ID 누락 처리를 수정했고 재검토에서 차단 항목이 해소됐습니다.
- 브라우저는 실제 정적 자산과 합성 API 서버로 로그인·조건별 규칙 저장·수정 ID 잠금·세션 만료 후 데이터 제거를 확인했습니다.
  390px 모바일 화면은 가로 넘침이 없고, 해당 화면의 axe WCAG 2 A/AA 검사는 위반 0건이었습니다.
  이는 실제 Supabase 이메일 인증이나 실제 Instagram OAuth 화면 검증을 대체하지 않습니다.

## 배포 순서

1. 운영 데이터베이스 백업과 현재 스키마를 확인하고 전역 발송 중지를 유지합니다.
2. Supabase 관리자 연결로 `db/migrations/003_comment_rule_matching.sql`부터 `006_follow_conversations.sql`까지 순서대로 적용하고, 같은 트랜잭션에서 `deploy/supabase-access.sql`을 적용합니다.
   서버 역할의 SELECT/INSERT/UPDATE만 허용하며 익명·인증·service_role의 제품 테이블 직접 접근 금지를 유지합니다.
   RLS를 완화하지 않습니다.
3. Supabase Auth에 공개 서비스의 Site URL을 설정하고 이메일 인증을 켭니다.
   회원가입 이메일 전송 공급자·제한과 확인 링크의 복귀를 실제 사용자 계정으로 점검합니다.
   사용자 응답이나 로그에 비밀번호·세션 토큰을 노출하지 않습니다.
4. Meta의 Instagram 비즈니스 로그인 redirect URI에 아래 주소를 등록합니다.
   Instagram용 앱 ID는 `1822350878757042`이며 메인 Meta 앱 ID와 구별합니다.
   타인 소유 전문 계정 제공에는 Advanced Access 승인을 별도로 확인합니다.
5. Worker에 아래 설정과 secrets를 등록하고 검증된 번들을 배포합니다.
6. 운영자 이메일 인증·첫 로그인 후 기존 workspace의 소유권을 확인해 아래 관리자 스크립트로 배정합니다.
   이 스크립트는 확인된 Supabase 사용자와 기존 연결이 있는 작업 공간을 명시적으로 받으며, 다른 소유자의 작업 공간이나 비어 있지 않은 현재 작업 공간을 자동 이전하지 않습니다.
7. 운영자가 Instagram을 OAuth로 연결하고 토큰 만료 시각·웹훅 수신·서로 다른 사용자 간 설정 격리를 확인합니다.
8. 정확한 테스트 게시물·수신자·첫 DM·분기 문구를 확정한 뒤 전역·계정·규칙 발송 스위치를 제한적으로 켭니다.
   첫 DM, 미팔로우, 팔로우, 확인 불가, 재응답·중복 이벤트를 수신 기기와 DB 상태로 대조합니다.

```plaintext
https://auto-chatter.auto-chatter-ydm2790.workers.dev/api/instagram/callback
```

### Worker 설정

| 이름                         | 위치               | 용도                                  |
| ---------------------------- | ------------------ | ------------------------------------- |
| `APP_ORIGIN`                 | `wrangler.json`    | 정확한 HTTPS 서비스 origin            |
| `SUPABASE_URL`               | `wrangler.json`    | 기존 프로젝트 URL                     |
| `INSTAGRAM_OAUTH_APP_ID`     | `wrangler.json`    | Instagram 비즈니스 로그인 앱 ID       |
| `META_GRAPH_VERSION`         | `wrangler.json`    | Graph API 버전                        |
| `SUPABASE_PUBLISHABLE_KEY`   | Worker secret      | Supabase Auth 호출용 공개 키          |
| `INSTAGRAM_OAUTH_APP_SECRET` | Worker secret      | Instagram OAuth 앱 secret             |
| `TOKEN_ENCRYPTION_KEY`       | Worker secret      | 32바이트 무작위 키의 canonical base64 |
| `INSTAGRAM_APP_SECRET`       | 기존 Worker secret | 웹훅 서명 검증                        |
| `INSTAGRAM_VERIFY_TOKEN`     | 기존 Worker secret | 웹훅 URL 확인                         |

키·토큰은 채팅이나 Git에 기록하지 않습니다.
Wrangler에는 `--env-file /dev/null`을 사용합니다.
새 암호화 키를 잃거나 교체하면 기존 토큰을 복호화할 수 없으므로 해당 계정의 재연결 또는 별도 키 이전이 필요합니다.
Cloudflare 다중 사용자 워커는 계정별 DB 토큰을 사용하며 `META_INSTAGRAM_ACCESS_TOKEN`을 사용하지 않습니다.
기존 Node 워커의 단일 계정 실행 경로는 그대로 유지합니다.

### 기존 작업 공간 소유권

서비스에 이메일 인증을 완료한 실제 사용자의 UUID를 관리자 화면에서 확인합니다.
운영자 계정을 확인하기 전에는 아래 작업을 실행하지 않습니다.
두 변수는 식별자이며 이메일 문자열이나 토큰이 아닙니다.

```bash
psql "$ADMIN_DATABASE_URL" -v user_id="$VERIFIED_USER_ID" -v workspace_id="$LEGACY_WORKSPACE_ID" -f deploy/assign-workspace-owner.sql
```

기존 수신 계정의 workspace는 배포 당시 기록상 `eedede37-b94a-4afe-b072-c728932e7c04`입니다.
실행 전 운영 DB에서 연결과 workspace를 다시 확인합니다.
스크립트의 로컬 테스트는 Supabase 사용자 테이블 대신 확인 여부를 가진 임시 테이블을 사용해 동일 함수의 거절·이전·재실행 동작을 검증했습니다.

## 기록 삭제와 장애 처리

연결 해제는 토큰을 지우고 계정의 수신·발송 및 규칙을 중지합니다.
Meta 자체의 앱 권한 철회는 Instagram 설정에서 별도로 수행할 수 있습니다.
전체 데이터 삭제는 기존에 승인한 운영자 수동 처리 정책을 따릅니다.

관리자 삭제 절차는 계정 발송을 먼저 중지하고 진행 중인 요청이 없는지 확인한 뒤, 한 트랜잭션에서 `instagram_message_receipts`와 `instagram_follow_conversations` → `private_reply_outbox` → 댓글 이벤트·규칙 → 연결 → 해당 workspace의 OAuth state → membership → workspace 순으로 처리합니다.
로그인 계정 삭제 요청이면 관련 작업 공간 데이터를 처리한 뒤 Supabase Auth 사용자도 관리자 권한으로 삭제합니다.
수신 DM 본문은 저장하지 않으며 발송 문구, 확인 메시지 식별자·시각, 팔로우 확인 상태는 삭제 대상에 포함합니다.
서버 역할에 DELETE 권한을 추가하지 않습니다.

`unknown`은 자동 재발송하지 않고 운영자가 공급자 상태를 확인합니다.
`follow_recipient_unavailable`은 첫 DM 발송 성공 후 후속 대상 ID를 확인하지 못한 상태이며 첫 DM을 다시 보내지 않습니다.
확인 응답의 24시간 창이 지나면 새 확인 응답을 기다립니다.
토큰 만료·권한 철회는 재연결이 필요합니다.

## 참고 근거

- [Meta 프로필 조회](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile/): DM 응답 후 조회와 `is_user_follow_business` 조건.
- [Meta 비공개 답장](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies/): 첫 답장 및 후속 메시지 시간 제한.
- [Meta 비즈니스 로그인](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/): 코드 교환·장기 토큰·권한·state.
- [Supabase 사용자 검증](https://supabase.com/docs/reference/javascript/auth-getuser): 서버의 사용자 확인.
- Oracle `wiki/concepts/publish-failure-protocol.md`: 외부 작업 결과 불명확 시 자동 복구하지 않는 원칙을 `unknown` 상태에 유지.
