# Meta 권한과 Instagram 개인 답장 워커

확인일: 2026-09-25.
이 기록은 공식 문서와 로컬 코드·테스트로 확인한 범위를 구분합니다.
실제 Meta 앱과 Instagram 계정의 권한 승인 상태는 아직 확인하지 못했습니다.

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

## 구현된 발송 경계

`src/instagram/reply-policy.ts`는 연결 활성화, 현재 권한 확인, 미디어 소유, 자기 댓글 여부, 댓글 생성 시각과 7일 기한을 검사합니다.
웹훅을 받은 시각이나 outbox 생성 시각을 댓글 생성 시각으로 대신 쓰지 않습니다.
`src/instagram/reply-worker.ts`는 PostgreSQL의 `FOR UPDATE SKIP LOCKED`로 요청 하나를 선점하고, 발송 직전에 읽기 전용 확인 어댑터의 결과를 정책에 전달합니다.
발송 성공 시 공급자 메시지 ID를 보관합니다.
발송 호출의 결과가 불명확하거나 프로세스가 발송 중 중단되면 상태를 `unknown`으로 남기며 자동 재시도하지 않습니다.
읽기 전용 확인 요청만 실패한 경우에는 1분 후 다시 확인하도록 `pending`으로 되돌립니다.

현재 `corepack pnpm start`는 웹훅 수신기만 실행합니다.
실제 권한 조회·댓글 생성 시각 조회·미디어 소유 확인·Meta 발송을 수행하는 어댑터와 워커 실행 진입점은 없습니다.
따라서 현재 코드는 실제 메시지를 보내지 않으며, 실제 계정에서 권한을 확인했다는 증거도 아닙니다.
운영 연결 전에는 로그인 방식, 앱 심사 상태, 테스트 계정 권한과 토큰 범위, 실제 발송 응답을 확인해야 합니다.
토큰이나 앱 비밀값은 문서와 테스트 결과에 기록하지 않습니다.

## 로컬 검증 범위

워커 통합 테스트는 두 선점자의 단일 발송 호출, 기한 만료와 권한 미확인 차단, 확인 실패 후 지연, 발송 결과 불명확 시 자동 재시도 방지, 중단된 작업 복구를 로컬 PostgreSQL에서 검사합니다.
기존 outbox 스키마를 만든 별도 로컬 DB에 `db/migrations/001_reply_worker.sql`을 두 번 적용해 기존 `pending` 행과 새 열을 확인했습니다.
이 검사는 Meta API의 실제 응답, 앱 심사 승인, 공급자 측 중복 방지를 입증하지 않습니다.
