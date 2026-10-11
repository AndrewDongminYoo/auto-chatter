# Instagram 일반 사용자 연결 공개 조건

## 목적

Meta 앱의 게시 상태와 권한 화면의 테스트 준비 상태만으로 앱 역할이 없는 일반 사용자의 Instagram 연결을 허용하지 않습니다.
일반 사용자에게 연결을 열기 전까지는 서비스 화면과 API에서 동일한 제한 사유를 제공합니다.

## 연결 계약

`INSTAGRAM_PUBLIC_CONNECT_ENABLED`가 정확히 `true`일 때 확인된 로그인 사용자는 새 Instagram OAuth 연결을 시작하고 콜백을 완료할 수 있습니다.
그 외에는 `INSTAGRAM_INTERNAL_EMAILS`에 일치하는 확인된 이메일만 연결할 수 있습니다.
내부 목록에 넣을 사용자는 별도로 Meta 앱 역할도 부여받아야 하며, 이메일 목록 자체가 Meta 권한을 부여하지는 않습니다.
두 설정이 없거나 공개 스위치가 `false`이면 새 연결은 기본적으로 제한됩니다.

`GET /api/me`의 `instagram_connect_available`은 현재 로그인 사용자의 연결 가능 여부를 알려줍니다.
제한된 사용자의 `POST /api/instagram/connect`와 `GET /api/instagram/callback`은 `403`과 `instagram_public_access_restricted`를 반환합니다.
화면의 `계정 연결` 버튼은 비활성화하고 제한 사유를 표시합니다.
허용된 사용자의 `POST /api/instagram/connect`는 OAuth state 행을 하나씩 저장하므로, 한 사용자가 한 시간 고정 구간에 10번까지 시작할 수 있습니다(`INSTAGRAM_CONNECT_LIMIT`, [이슈 #166](https://github.com/AndrewDongminYoo/auto-chatter/issues/166)).
넘으면 `429 instagram_connect_rate_limited`를, 한도 바인딩이 없거나 응답하지 않으면 `503 instagram_connect_unavailable`을 DB를 읽기 전에 반환합니다.
만료된 OAuth state는 Cloudflare cron 단계 `oauth_state_cleanup`이 관리자 소유 함수 `public.delete_expired_oauth_states`(migration 038)로 지웁니다([이슈 #173](https://github.com/AndrewDongminYoo/auto-chatter/issues/173)).
이 함수는 `expires_at`이 지난 행만, 한 번에 최대 1,000행을 지우고 나머지는 다음 실행이 지웁니다. 만료된 state는 OAuth 완료와 초대 이동 검사가 이미 무시하므로 동작은 바뀌지 않으며, 사용했지만 아직 만료되지 않은 행은 만료될 때까지 남습니다.
서버 역할은 이 함수의 실행 권한만 받고 테이블 DELETE 권한은 여전히 없으며, API 역할은 실행할 수 없습니다. 전역 발송이 꺼져 있어도 실행하며, 이 정리는 시작 한도에 포함되지 않습니다.
마이그레이션 038을 전체 실행기(`deploy/migrate-multi-user.sql`)로 적용한 뒤 동작하는 계약이며, 운영 DB 적용과 배포는 이 PR의 범위가 아닙니다.
적용 전에 코드가 배포되면 매 실행에서 `oauth_state_cleanup` 단계가 실패로 기록됩니다. 이후 단계는 계속 실행되지만 그 실행 전체가 실패합니다.
`cron` 행에 `step_failed`가 남고 scheduled 핸들러가 오류를 던지므로, 기준 시간이 지나면 `cron_stale` 경보가 켜지고 마이그레이션 038을 적용한 뒤 처음 성공한 실행까지 유지됩니다([운영 상태](2026-10-01-operations-health.md#정기-작업-기록)).
허용된 연결 중 Instagram이 권한 동의를 거부하거나 필수 권한이 빠지면 콜백은 제한된 오류 코드로 앱에 돌아와 이유를 알립니다.
기존 연결의 수신·발송 스위치와 규칙은 이 새 연결 제한으로 바뀌지 않습니다.
발송은 별도의 전역 및 계정별 스위치와 공급자 권한 검증을 따릅니다.

## 공개 전 확인

운영자는 Meta 대시보드에서 필요한 각 권한의 Standard 또는 Advanced Access 및 App Review 결과를 직접 확인해야 합니다.
앱 역할이 없는 별도 전문 계정으로 로그인, OAuth 연결, `comments`·`messages`·`messaging_postbacks` 구독, 실제 댓글·DM 수신, 허용된 답장, 해제를 기록해야 합니다.
팔로우 확인 불가·중복 이벤트·버튼 응답 결과도 별도로 기록합니다.
이 증거가 갖춰지고 운영자가 공개를 승인한 뒤에만 공개 스위치를 `true`로 설정합니다.
설정을 켜는 행위 자체는 Meta의 권한 승인 증거가 아닙니다.

## 검증 경계

합성 인증 사용자와 모의 OAuth 시작으로 API 기본 제한·내부 목록·공개 스위치를 검사합니다.
이 검사는 Meta의 승인 상태, 실제 전문 계정 OAuth 또는 메시지 전송을 입증하지 않습니다.
