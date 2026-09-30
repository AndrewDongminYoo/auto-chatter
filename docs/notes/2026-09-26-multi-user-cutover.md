# 다중 사용자 자동화 배포 전환

## 현재 상태

다중 사용자 코드와 003–006 DB 마이그레이션은 2026-09-26에 운영 배포했습니다.
기본 배포 설정은 `SEND_ENABLED=false`입니다.
승인된 단일 게시물의 첫 DM 발송·수신을 확인한 뒤 전역·계정·규칙 발송을 다시 중지했습니다.
승인 범위·현재 스위치·중지 절차는 [첫 실발송 테스트 기록](2026-09-26-first-live-reply-test.md)에 있습니다.
이후 승인된 새 게시물에서 미팔로우 안내와 팔로우 후 완료 DM을 검증하고 전역·계정·해당 규칙 발송을 다시 중지했습니다.
후속 테스트의 현재 상태는 [팔로우 분기 실발송 테스트](2026-09-26-live-follow-test.md)에 기록합니다.
운영자의 실제 Instagram OAuth 연결과 저장된 토큰의 프로필 조회를 확인했습니다.
첫 댓글 비공개 답장 1건은 실제 발송·수신을 확인했습니다.
미팔로우·팔로워 후속 DM의 실제 수신과 DB 상태를 대조했으며 타인 계정의 Advanced Access 승인 완료는 검증하지 않았습니다.

설정 화면은 `/app/`입니다.
첫 버전은 기존 Worker의 정적 자산과 vanilla JavaScript를 사용해 프레임워크·런타임 의존성을 추가하지 않았습니다.
게시물 숫자 ID를 직접 입력하며 게시물 선택기는 이 버전에 포함하지 않습니다.
당시 토큰 만료 시각만 계정 목록에 표시하고 자동 갱신은 없었습니다.
이후 015 마이그레이션과 예약 갱신 기능을 추가했으며, 운영 적용 전에는 기존 동작을 따릅니다.
규칙은 게시물별 하나이고 포함 키워드는 OR, 제외 키워드는 우선 적용합니다.
진행 중인 대화는 시작 시점의 문구를 사용하며 현재 계정·규칙 중지는 최종 발송 조건에 반영합니다.
설정 중지와 외부 POST는 하나의 원자적 작업이 아니므로 최종 확인 후 이미 시작한 요청까지 취소하지는 못합니다.
여러 게시물의 첫 DM을 받은 같은 사용자가 응답하면 가장 최근에 보낸 응답 대기 중인 대화 하나를 선택합니다.

### 운영 배포 기록

- 최초 다중 사용자 코드 태그: `2a5403e`.
- 최초 다중 사용자 코드 배포 버전: `0073b9ec-2141-420f-9b7d-52e0fd2ece8d`.
  이후 OAuth 앱 secret 등록으로 배포된 버전은 `9c327413-8e4d-4506-8010-e7b2a4aca773`입니다.
- 인증 수정 코드 태그: `b15b3d0`, Worker 버전: `7bfd9b14-f325-486f-84d5-09b4c2c44d2b`.
  인증 native fetch 호출 수정으로 운영 로그인 요청의 503 해소를 확인했습니다.
  이후 운영자의 회원가입 보고와 DB의 이메일 인증·로그인 완료를 확인했으며, [인증 런타임 수정 기록](2026-09-26-auth-fetch-runtime-fix.md)에 상세 결과가 있습니다.
- 소유권 수정·테스트 활성화 코드 태그: `2e76925`, Worker 버전: `7b37391d-8893-4ecd-8ee3-9b21ee9eb2c7`.
  실계정에서 발견한 프로필 ID 별칭의 게시물 소유권 검사를 수정하고 승인된 첫 DM 테스트를 위해 `SEND_ENABLED=true`로 배포했습니다.
- 첫 DM 테스트 중지 Worker 버전: `979de5bb-bc68-4af9-a9f8-5ec82e95c56f`, 코드 태그: `2e76925`.
  첫 DM의 DB 상태 `sent` 1개·공급자 메시지 ID 저장과 운영자의 수신·답장 완료 보고를 대조한 뒤 발송을 중지했습니다.
- 팔로우 테스트 활성화 Worker 버전: `18141dc0-a1c6-49be-a50c-5b4bfe18fde6`, 코드 태그: `6d71ef7`.
  실행 코드 변경 없이 승인된 새 게시물 `17909444478471816`의 팔로우 조건 테스트를 위해 전역 발송을 활성화했습니다.
- 현재 Worker 버전: `dfa763f7-742d-497a-8e58-6eeb737837bd`, 코드 태그: `6d71ef7`.
  첫 DM → 미팔로우 안내 → 팔로워 완료 DM의 실제 수신과 DB의 `sent / following`·확인 receipt 2건을 확인한 뒤 전역·계정·규칙 발송을 중지했습니다.
- Supabase 프로젝트: `asjjftrioaxzspkbtebf`.
- 서비스의 public 스키마·데이터 백업: Git에서 제외된 `deploy/secrets/backups/2026-09-26T08-51-06.150Z/public-before-multi-user.dump`.
  디렉터리는 0700, 백업은 0600이며 `pg_restore --list`에서 기존 제품 테이블 다섯 개의 데이터 항목을 확인했습니다.
  Supabase Auth와 전체 클러스터 역할을 포함한 백업은 아닙니다.
- `psql -f deploy/migrate-multi-user.sql`을 TLS `verify-full`을 사용하는 Session pooler 관리자 연결로 실행했습니다.
  로컬에서 Direct endpoint의 IPv6 연결을 사용할 수 없어 관리자 작업에 Session pooler를 사용했으며 Worker의 Hyperdrive 바인딩은 유지했습니다.
- 전환 전후 기존 연결 1개·댓글 이벤트 2개·발송 행 0개가 보존됐습니다.
- 제품 테이블 아홉 개의 RLS, `anon`·`authenticated`·`service_role`의 SELECT/INSERT/UPDATE/DELETE 차단, 서버 역할의 관리자 속성 부재를 확인했습니다.
  실제 `auto_chatter_server` 로그인으로 새 작업 공간·OAuth·팔로우 테이블 조회도 확인했습니다.
- 계정별 `send_enabled=true`인 연결은 0개입니다.
- 기존 웹훅 secrets에 `SUPABASE_PUBLISHABLE_KEY`와 `TOKEN_ENCRYPTION_KEY`를 추가했습니다.
  암호화 키는 Git에서 제외된 `deploy/secrets/cloudflare-multi-user.json`에 0600으로 보관하며 안전하게 백업해야 합니다.
- `/app/`, `/privacy`, `/service`, `/data-deletion`은 HTTP 200, 로그인 없는 `/api/me`는 401, 잘못된 구독 확인·서명 없는 웹훅은 403이었습니다.
  공개 JavaScript·CSS 응답이 배포한 checkout의 파일과 같은 것을 확인했습니다.
  이 점검은 실제 이메일 인증·Instagram OAuth·서명된 댓글의 신규 배포 수신·실발송 검증을 대신하지 않습니다.

`INSTAGRAM_OAUTH_APP_SECRET`을 포함한 secrets 다섯 개의 등록과 배포된 앱 ID `1822350878757042`, 전역 `SEND_ENABLED=false`를 확인했습니다.
secret 등록만으로 OAuth 코드 교환 성공을 증명하지는 않으며, 실제 연결 확인 결과는 아래에 별도로 기록합니다.
운영자가 `ydm2790@gmail.com`의 회원가입 완료를 보고했고, DB에서 `email_confirmed_at`과 `last_sign_in_at`이 있는 사용자를 확인했습니다.
`deploy/assign-workspace-owner.sql`을 명시적인 사용자·기존 작업 공간 ID로 실행해 COMMIT을 확인했습니다.
소유권 배정 직후 재조회에서 해당 사용자가 기존 수신 계정의 작업 공간을 소유하며 `send_enabled=false`, OAuth 암호화 토큰 없음 상태를 확인했습니다.
이후 운영자가 실제 OAuth 연결 완료를 보고했습니다.
운영 DB에서 `ai.you.wanted`의 암호화 토큰 저장·수신 활성화·발송 비활성화를 확인했고, 저장된 토큰으로 Meta 프로필을 조회해 동일한 계정임을 확인했습니다.
Meta의 `subscribed_apps` 조회에서 `comments`·`messages` 구독을 확인했습니다.
토큰 만료는 `2026-11-24T12:20:10.423Z`이며 확인 시점에 규칙 0개·outbox 0개·기존 댓글 2개입니다.
프로필·구독 확인은 GET 요청만 사용했고 토큰 값은 출력하지 않았습니다.
OAuth 연결 이후 `auto-chatter OAuth 수신 테스트` 댓글이 `2026-09-26T09:47:50.487Z`에 저장됐습니다.
게시물은 `18178820404442752`이며 해당 작업 공간의 댓글은 3개, 규칙·outbox는 0개였습니다.
이후 정확 일치 키워드 규칙으로 첫 DM 1건의 발송·수신을 확인했습니다.
첫 DM 테스트 중지 직후 발송 활성 계정·규칙과 미완료 outbox는 0개였습니다.
팔로우 조건 테스트 활성화 직전에도 미완료 outbox·팔로우 대화가 없는 것을 확인했고 이전 첫 DM 테스트 규칙은 비활성화 상태를 유지합니다.
팔로우 테스트 중지 후에도 발송 활성 계정·규칙과 미완료 outbox·팔로우 대화는 모두 0개였습니다.
남은 전환 작업은 이메일 확인 링크 복귀, 여러 실제 사용자 간 격리, Advanced Access 및 팔로우 조회 불가·실제 중복 이벤트 검증입니다.
아래 배포 순서의 DB 백업·마이그레이션·Worker 배포는 완료했으며 나머지 작업은 완료로 간주하지 않습니다.

## 검증

- `corepack pnpm check-types`: 엄격한 TypeScript 타입 검사.
- `corepack pnpm test`: 서명·키워드·세션·암호화·공급자 응답 분류를 mock으로 검증.
- `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db`: 사용자 간 격리, 일회성 OAuth state, 기존 소유권 배정, 조건별 DM 상태 및 중복·동시 처리를 실제 로컬 PostgreSQL로 검증.
- 같은 DB 환경에서 `corepack pnpm test:cloudflare`: workerd 번들·Hyperdrive·Queue 경로, API 역할의 접근 차단, 암호화 토큰별 계정 격리, 서명된 댓글 → 첫 DM → 미팔로우 안내 → 재확인 → 완료 DM을 합성 Graph 응답으로 검증.
- 독립 코드 리뷰와 적대적 발송 리뷰에서 발견한 세션 종료, 연결 해제 후 재활성화, 규칙 ID 변경, OAuth 완료 경쟁, 발송 직전 확인 및 수신자 ID 누락 처리를 수정했고 재검토에서 차단 항목이 해소됐습니다.
- PR 전 검토에서 마이그레이션 내부의 `COMMIT`이 외부 트랜잭션을 끊는 문제를 수정했습니다.
  로컬 테스트 DB에서 중간 실패를 주입했을 때 기존 방식은 검증용 행이 남았고, 단일 실행 스크립트는 행을 롤백했습니다.
  실제 `psql -f deploy/migrate-multi-user.sql` 실행도 정상 완료했습니다.
- 브라우저는 실제 정적 자산과 합성 API 서버로 로그인·조건별 규칙 저장·수정 ID 잠금·세션 만료 후 데이터 제거를 확인했습니다.
  390px 모바일 화면은 가로 넘침이 없고, 해당 화면의 axe WCAG 2 A/AA 검사는 위반 0건이었습니다.
  이는 실제 Supabase 이메일 인증이나 실제 Instagram OAuth 화면 검증을 대체하지 않습니다.

## 배포 순서

1. 운영 데이터베이스 백업과 현재 스키마를 확인하고 전역 발송 중지를 유지합니다.
2. Supabase 관리자 연결로 `psql "$ADMIN_DATABASE_URL" -f deploy/migrate-multi-user.sql`을 실행합니다.
   현재 실행 스크립트는 003–016 마이그레이션과 `deploy/supabase-access.sql`을 한 트랜잭션에서 순서대로 적용하며 첫 오류에서 중단합니다.
   최초 전환 당시 적용 기록은 003–006이며, 이후 마이그레이션의 운영 적용 여부는 별도로 확인합니다.
   개별 마이그레이션을 직접 실행하거나 오류 후 다음 파일부터 계속하지 않습니다.
   실패하면 전체 롤백을 확인하고 원인을 고친 뒤 실행 스크립트를 다시 시작합니다.
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
https://auto-chat.donminzzi.kr/api/instagram/callback
```

기존 workers.dev 콜백은 전환 중에도 Meta의 허용 목록에 유지합니다.

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
연결 하나의 기록만 지우는 요청은 연결을 해제한 뒤 앱 API나 `public.delete_connection_data` 함수로 처리하며, 범위와 보관 예외는 [연결 단위 데이터 삭제 계약](../specs/2026-09-29-connection-data-deletion.md)을 따릅니다.
앱 사용자가 아닌 Instagram 이용자 한 사람의 삭제 요청은 본인 확인 뒤 관리자 연결에서 `public.delete_person_data`로 처리하며, 절차는 [이용자 단위 데이터 삭제 계약](../specs/2026-09-30-person-data-deletion.md)을 따릅니다.

작업 공간 전체의 관리자 삭제 절차는 계정 수신·발송과 인박스 보관을 먼저 중지하고 진행 중인 요청이 없는지 확인한 뒤 수행합니다.
삭제 범위의 workspace·연결 ID를 확인하고 한 트랜잭션에서 `flows`의 `enabled`를 false로, `published_version_id`를 NULL로 바꾼 뒤 `instagram_manual_reply_events` → `instagram_manual_replies` → `instagram_inbox_handoff_events` → `instagram_inbox_handoffs` → `instagram_inbox_messages`·`instagram_contact_automation`·`instagram_contact_tags`·`instagram_contact_field_values`·`instagram_contact_segments` → `instagram_contact_fields` → `instagram_message_receipts`·`instagram_follow_conversations` → `private_reply_outbox` → `flow_step_runs` → `flow_runs` → `flow_versions` → `flows` → `channel_consent_state` → `channel_consent_events` → 댓글 이벤트·규칙 → `data_deletion_records` → 연결 → 해당 workspace의 OAuth state → membership → workspace 순으로 처리합니다.
다른 작업 공간의 행은 삭제 대상에 포함하지 않으며, 단일 연락처나 연결만 삭제하는 요청은 해당 범위와 참조 관계를 별도로 확인합니다.
로그인 계정 삭제 요청이면 관련 작업 공간 데이터를 처리한 뒤 Supabase Auth 사용자도 관리자 권한으로 삭제합니다.
별도 인박스 보관을 켠 연결의 수신 DM 본문과 확인 버튼 응답, 연락처 태그·필드·필터·직접 중지와 상담 중지 상태, 상담 전환 버전·운영자·근거·감사 기록, 수동 답장 문구·전송 상태·감사 기록, 플로 초안과 발행 버전, 플로 실행과 실행 단계 기록, 발송 문구, 확인 메시지 식별자·시각, 팔로우 확인 상태는 삭제 대상에 포함합니다.
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
