# Meta 권한과 Instagram 개인 답장 워커

확인일: 2026-09-25.
이 기록은 공식 문서와 로컬 코드·테스트로 확인한 범위를 구분합니다.
실제 Meta 앱과 Instagram 계정의 권한 승인 상태는 아직 확인하지 못했습니다.
운영자는 이번 작업에서 로그인 방식을 정하지 않았고, Meta 앱과 전문 계정 테스트 환경도 아직 준비되지 않았다고 확인했습니다.
첫 구현은 공식 개인 답장 문서가 명시한 Facebook Login 경로를 사용하며, 최종 로그인 방식은 실계정 검증 뒤 결정합니다.

## 공식 발송 조건

[Meta Private Replies 문서](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies)에 따르면 Instagram 전문 계정의 게시물, 광고 게시물, 릴스 댓글에는 댓글 생성 후 7일 이내에 개인 답장을 한 번 보낼 수 있습니다.
Instagram Live 댓글은 생방송 중에만 개인 답장을 보낼 수 있습니다.
받는 사람이 개인 답장에 응답한 경우에만 일반 메시지 대화를 이어갈 수 있으며, 이때 24시간 메시지 창이 적용됩니다.
현재 수신기는 `comments` 이벤트만 처리하므로 Live 댓글 발송은 범위 밖입니다.

공식 문서의 Facebook Login 경로에는 연결된 Facebook Page ID, `instagram_manage_comments` 및 `pages_messaging` 권한, Page의 `MESSAGING` 작업 권한이 있는 사용자가 발급한 Page access token, Human Agent 기능, Advanced Access가 필요하다고 명시되어 있습니다.
Standard Access에서는 앱 역할이 있는 사람의 데이터에만 접근할 수 있습니다.
개인 답장 요청은 `POST /<PAGE_ID>/messages`에 댓글 ID와 메시지를 전달하며, 성공 응답의 `message_id`를 기록해야 합니다.

[Meta의 Instagram Login API 목록](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login)에는 `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments` 권한이 안내되어 있습니다.
현재 확인한 Private Replies 문서는 Facebook Login 경로를 설명하므로, Instagram Login으로 동일한 개인 답장을 보낼 때 필요한 엔드포인트와 권한은 이 기록에서 확정하지 않습니다.
선택한 로그인 방식에 따라 앱 심사와 테스트 계정에서 실제 호출을 확인해야 합니다.

[Meta IG Comment 참조](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment)는 댓글의 `timestamp`, 작성자와 미디어 ID 조회를 설명합니다.
[Meta IG Media 참조](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media)는 미디어 소유자와 게시 표면 조회를 설명합니다.
[Meta Debug Token 참조](https://developers.facebook.com/docs/graph-api/reference/debug_token/)는 토큰의 앱 ID, 유효성, 만료와 권한 범위 확인에 사용됩니다.
[Meta 공식 Instagram API 컬렉션](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)은 Page 목록의 `tasks`, 연결된 Instagram 계정과 Page access token을 보여 줍니다.

## 구현된 발송 경계

`src/instagram/reply-policy.ts`는 연결 활성화, 현재 권한 확인, 미디어 소유, 자기 댓글 여부, 댓글 생성 시각과 7일 기한을 검사합니다.
웹훅을 받은 시각이나 outbox 생성 시각을 댓글 생성 시각으로 대신 쓰지 않습니다.
`src/instagram/reply-worker.ts`는 PostgreSQL의 `FOR UPDATE SKIP LOCKED`로 해당 연결의 요청 하나를 선점하고, 발송 직전에 읽기 전용 확인 어댑터의 결과를 정책에 전달합니다.
`src/instagram/facebook-private-reply.ts`는 사용자 토큰의 앱 ID·만료·필요 권한을 확인하고, Page의 `MESSAGING` 작업과 Instagram 계정 연결을 조회합니다.
댓글 ID·작성자·미디어·생성 시각과 미디어 소유자·게시 표면이 요청과 맞는지도 확인합니다.
실제 발송에는 Page 목록에서 받은 Page access token과 댓글 ID를 사용합니다.
발송 함수 자체도 정책을 다시 확인하고 Graph 요청에는 10초 제한을 둡니다.
발송 성공 시 공급자 메시지 ID를 보관합니다.
발송 호출의 결과가 불명확하거나 프로세스가 발송 중 중단되면 상태를 `unknown`으로 남기며 자동 재시도하지 않습니다.
읽기 전용 확인 요청만 실패한 경우에는 1분 후 다시 확인하도록 `pending`으로 되돌립니다.

`corepack pnpm start`는 웹훅 수신기만 실행합니다.
`corepack pnpm meta:check`는 토큰 범위, Page 연결과 `MESSAGING` 작업을 읽기 전용으로 확인합니다.
`corepack pnpm worker:instagram`은 활성 DB 연결 하나에 범위를 제한해 실제 발송을 처리하고, 10분 이상 남은 `sending` 작업을 시작 시점과 실행 중 주기적으로 `unknown`으로 전환합니다.
Meta 앱과 전문 계정이 아직 없으므로 두 명령의 실계정 호출은 실행하지 않았습니다.
`meta:check`도 Advanced Access 승인, Human Agent 기능과 실제 발송 가능 여부를 증명하지 않습니다.
운영 연결 전에는 앱 심사 상태, 테스트 계정 권한과 토큰 범위, 실제 발송 응답을 별도로 확인해야 합니다.
토큰이나 앱 비밀값은 문서와 테스트 결과에 기록하지 않습니다.

## 로컬 검증 범위

워커 통합 테스트는 두 선점자의 단일 발송 호출, 다른 연결의 작업 분리, 기한 만료와 권한 미확인 차단, 확인 실패 후 지연, 발송 결과 불명확 시 자동 재시도 방지, 중단된 작업의 주기적 복구를 로컬 PostgreSQL에서 검사합니다.
Meta 어댑터 테스트는 모의 Graph 응답으로 토큰 범위, Page와 계정 연결, 댓글·미디어 일치, 발송 요청 본문과 실패 처리를 확인합니다.
기존 outbox 스키마를 만든 별도 로컬 DB에 `db/migrations/001_reply_worker.sql`을 두 번 적용해 기존 `pending` 행과 새 열을 확인했습니다.
이 검사는 Meta API의 실제 응답, 앱 심사 승인, 공급자 측 중복 방지를 입증하지 않습니다.
