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
