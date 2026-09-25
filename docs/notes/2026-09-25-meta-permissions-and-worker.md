# Meta 권한과 Instagram 개인 답장 워커

확인일: 2026-09-25.
이 기록은 공식 문서와 로컬 코드·테스트로 확인한 범위를 구분합니다.
실제 Meta 앱과 Instagram 계정의 권한 승인 상태는 아직 확인하지 못했습니다.
운영자는 [Meta 앱 `1802833180713730`](https://developers.facebook.com/apps/1802833180713730)을 만들었다고 알렸습니다.
앱 대시보드에는 이름 `AutoMessage`와 `게시되지 않음`이, Instagram 사용 사례에는 `Instagram 로그인이 포함된 API 설정`과 Instagram 앱 ID `1822350878757042`가 표시됐습니다.
`비즈니스용 Facebook 로그인`도 대시보드에 보이지만, 현재 확인된 Instagram 설정은 Instagram Login 경로입니다.
운영자는 Instagram API 설정에서 발급한 토큰을 `META_INSTAGRAM_ACCESS_TOKEN`으로 설정하고, 개발자 대시보드에서 일반 DM 발송에 성공했다고 보고했습니다.
운영자가 실행한 `META_LOGIN_MODE=instagram corepack pnpm meta:check`는 `Instagram token account ID verified`를 출력했습니다.
이 결과는 토큰의 `user_id`와 설정한 계정 ID가 일치함을 확인하지만, 댓글 관리 권한이나 댓글 비공개 답장 발송은 확인하지 않습니다.
Facebook Login 구현을 유지하면서 이 앱의 Instagram Login 경로도 추가했으며, 운영 경로는 실계정 검증 뒤 확정합니다.

## 공식 발송 조건

[Meta Instagram Platform Private Replies 문서](https://developers.facebook.com/documentation/instagram-platform/private-replies)에 따르면 Instagram 전문 계정의 댓글에는 생성 후 7일 이내에 개인 답장을 한 번 보낼 수 있습니다.
Instagram Live 댓글은 생방송 중에만 개인 답장을 보낼 수 있습니다.
받는 사람이 개인 답장에 응답한 경우에만 일반 메시지 대화를 이어갈 수 있으며, 이때 24시간 메시지 창이 적용됩니다.
현재 수신기는 `comments` 이벤트만 처리하므로 Live 댓글 발송은 범위 밖입니다.

새 개인 답장 문서는 Instagram Login 경로에 Instagram 사용자 토큰, `graph.instagram.com`, `instagram_business_basic` 및 `instagram_business_manage_comments` 권한, `POST /<IG_ID>/messages` 요청을 명시합니다.
[Meta 공식 Instagram Login API 설명](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)에 따르면 이 경로는 Facebook Page 연결을 요구하지 않습니다.
[기존 Meta Private Replies 문서](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies)의 Facebook Login 경로에는 연결된 Facebook Page ID, `instagram_manage_comments` 및 `pages_messaging` 권한, Page의 `MESSAGING` 작업 권한이 있는 사용자가 발급한 Page access token, Human Agent 기능, Advanced Access가 필요하다고 명시되어 있습니다.
Standard Access에서는 앱 역할이 있는 사람의 데이터에만 접근할 수 있습니다.
Facebook Login의 개인 답장 요청은 `POST /<PAGE_ID>/messages`를 사용합니다.
두 경로 모두 댓글 ID와 메시지를 전달하며, 성공 응답의 `message_id`를 기록해야 합니다.

[Meta의 Instagram Login API 목록](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)에는 `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments` 권한이 안내되어 있습니다.
현재 앱 화면에서는 `instagram_business_basic`과 `instagram_business_manage_messages`가 `테스트 준비 완료`, `instagram_business_manage_comments`는 `추가` 상태입니다.
화면에는 Instagram `계정 추가`만 보였으며, 전문 계정·테스터 배정과 Facebook Page 연결 여부는 확인되지 않았습니다.
Instagram Login으로 댓글 개인 답장을 시험하려면 먼저 댓글 관리 권한과 전문 계정 토큰을 준비해야 합니다.
선택한 로그인 방식에 따라 앱 심사와 테스트 계정의 실제 호출을 확인해야 합니다.

[Meta IG Comment 참조](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment)는 댓글의 `timestamp`, 작성자와 미디어 ID 조회를 설명합니다.
[Meta IG Media 참조](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media)는 미디어 소유자와 게시 표면 조회를 설명합니다.
[Meta Debug Token 참조](https://developers.facebook.com/docs/graph-api/reference/debug_token/)는 토큰의 앱 ID, 유효성, 만료와 권한 범위 확인에 사용됩니다.
[Meta 공식 Instagram API 컬렉션](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)은 Page 목록의 `tasks`, 연결된 Instagram 계정과 Page access token을 보여 줍니다.

## 구현된 발송 경계

`src/instagram/reply-policy.ts`는 연결 활성화, 현재 권한 확인, 미디어 소유, 자기 댓글 여부, 댓글 생성 시각과 7일 기한을 검사합니다.
웹훅을 받은 시각이나 outbox 생성 시각을 댓글 생성 시각으로 대신 쓰지 않습니다.
`src/instagram/reply-worker.ts`는 PostgreSQL의 `FOR UPDATE SKIP LOCKED`로 해당 연결의 요청 하나를 선점하고, 발송 직전에 읽기 전용 확인 어댑터의 결과를 정책에 전달합니다.
`src/instagram/facebook-private-reply.ts`는 사용자 토큰의 앱 ID·만료·필요 권한을 확인하고, Page의 `MESSAGING` 작업과 Instagram 계정 연결을 조회합니다.
`src/instagram/instagram-login-private-reply.ts`는 Instagram 사용자 토큰의 전문 계정 `user_id`를 조회하고, 댓글·미디어 ID와 미디어 소유자를 확인한 뒤 `graph.instagram.com`으로 발송합니다.
Instagram Login 계정 확인은 부여된 권한 범위와 앱 검수 상태를 증명하지 않습니다.
댓글 ID·작성자·미디어·생성 시각과 미디어 소유자·게시 표면이 요청과 맞는지도 확인합니다.
Facebook Login 경로의 발송에는 Page access token을, Instagram Login 경로의 발송에는 Instagram 사용자 토큰을 사용합니다.
두 경로 모두 댓글 비공개 답장에는 댓글 ID가 필요합니다.
발송 함수 자체도 정책을 다시 확인하고 Graph 요청에는 10초 제한을 둡니다.
발송 성공 시 공급자 메시지 ID를 보관합니다.
발송 호출의 결과가 불명확하거나 프로세스가 발송 중 중단되면 상태를 `unknown`으로 남기며 자동 재시도하지 않습니다.
읽기 전용 확인 요청만 실패한 경우에는 1분 후 다시 확인하도록 `pending`으로 되돌립니다.

`corepack pnpm start`는 웹훅 수신기만 실행합니다.
현재 앱에는 `META_LOGIN_MODE=instagram`을 설정하며, 이때 `corepack pnpm meta:check`는 토큰의 전문 계정 ID만 읽기 전용으로 확인합니다.
기존 `facebook` 경로에서는 토큰 범위, Page 연결과 `MESSAGING` 작업을 확인합니다.
`corepack pnpm worker:instagram`은 활성 DB 연결 하나에 범위를 제한해 실제 발송을 처리하고, 10분 이상 남은 `sending` 작업을 시작 시점과 실행 중 주기적으로 `unknown`으로 전환합니다.
운영자가 설정한 Instagram 사용자 토큰과 계정 ID로 저장소의 읽기 전용 실계정 Graph 확인 명령을 실행했고, 계정 ID 일치 결과를 공유했습니다.
이 저장소에서 댓글 비공개 답장 발송은 아직 실행하지 않았습니다.
기존 Facebook 경로에서 앱 ID만 설정해 `meta:check`를 실행한 결과, 나머지 필수 환경 변수 여섯 개가 없어 종료 코드 2로 끝났으며 Graph 요청은 시작되지 않았습니다.
Instagram Login 경로의 이전 `meta:check` 실행은 Graph 버전, 전문 계정 ID와 Instagram 사용자 토큰이 없어 종료 코드 2로 끝났습니다.
`meta:check`는 앱 검수 승인과 실제 발송 가능 여부를 증명하지 않습니다.
운영 연결 전에는 앱 심사 상태, 테스트 계정 권한과 토큰 범위, 실제 발송 응답을 별도로 확인해야 합니다.
토큰이나 앱 비밀값은 문서와 테스트 결과에 기록하지 않습니다.

## 남은 실계정 확인

1. 앱의 Instagram 사용 사례에서 `instagram_business_manage_comments` 추가 여부와 Instagram 전문 계정의 앱 역할을 확인하고, 누락된 설정을 완료합니다.
2. 테스트 계정의 실제 댓글 읽기 호출로 댓글 관리 권한을 확인하고, 댓글 비공개 답장 발송 결과를 별도로 검증합니다.
   완료된 `meta:check`는 계정 ID 일치만 확인합니다.
3. 웹훅 콜백과 검증 토큰, 앱 검수 상태를 확인합니다.
   현재 앱 화면은 `게시되지 않음`이며 웹훅의 `확인 및 저장` 버튼이 비활성 상태입니다.

## 로컬 검증 범위

워커 통합 테스트는 두 선점자의 단일 발송 호출, 다른 연결의 작업 분리, 기한 만료와 권한 미확인 차단, 확인 실패 후 지연, 발송 결과 불명확 시 자동 재시도 방지, 중단된 작업의 주기적 복구를 로컬 PostgreSQL에서 검사합니다.
Meta 어댑터 테스트는 모의 Graph 응답으로 토큰 범위, Page와 계정 연결, 댓글·미디어 일치, 발송 요청 본문과 실패 처리를 확인합니다.
Instagram Login 어댑터 테스트는 모의 `graph.instagram.com` 응답으로 계정 불일치, 댓글·미디어 소유, 기한 만료, 발송 전 조회 실패와 발송 결과 불명을 확인합니다.
기존 outbox 스키마를 만든 별도 로컬 DB에 `db/migrations/001_reply_worker.sql`을 두 번 적용해 기존 `pending` 행과 새 열을 확인했습니다.
이 검사는 Meta API의 실제 응답, 앱 심사 승인, 공급자 측 중복 방지를 입증하지 않습니다.
