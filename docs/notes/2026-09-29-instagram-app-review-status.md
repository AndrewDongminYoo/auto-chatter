# Instagram App Review와 추가 사용자 검증 기록

## 2026-09-29 읽기 전용 확인

개인 Meta 개발자 대시보드에서 메인 앱 `AutoChatter` (`1802833180713730`)는 게시됨으로 표시됐습니다.
Instagram OAuth 앱 `AutoMessage - IG` (`1822350878757042`)의 `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`는 각각 테스트 준비 완료로 표시됐습니다.
이 화면에서 Standard 또는 Advanced Access 승인과 App Review 제출·완료 상태는 확인하지 못했습니다.
따라서 앱 역할이 없는 사용자의 연결 권한은 아직 미확인입니다.

Instagram 로그인 API 설정에서 `ai.you.wanted`의 계정별 Webhook 구독 스위치는 켜져 있었습니다.
별도 Instagram 제품의 Webhooks 필드 목록에서는 `comments`, `messages`, `messaging_postbacks`가 각각 구독 취소됨으로 표시됐습니다.
두 화면의 의미와 실제 배송 관계는 이 조회만으로 확정할 수 없습니다.
기존 댓글 수신 기록을 이 화면 차이만으로 무효로 보거나, 일반 사용자 구독 성공으로 확대 해석하지 않습니다.

[Meta의 Instagram API with Instagram Login 컬렉션](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00)에 나오는 권한 이름을 코드의 OAuth 요청 범위와 대조했습니다.
운영 정책 페이지는 [서비스 약관](https://auto-chat.donminzzi.kr/service), [개인정보처리방침](https://auto-chat.donminzzi.kr/privacy), [데이터 삭제](https://auto-chat.donminzzi.kr/data-deletion)이며 이 날짜의 공개 GET 요청에 각각 200을 확인했습니다.

## 심사 설명과 시연 순서

서비스는 전문 계정 소유자가 Instagram으로 로그인해 계정을 연결하고, 자신의 게시물에 댓글 조건·첫 DM·필요한 경우 팔로우 확인 뒤의 후속 메시지를 설정하는 자동화 도구입니다.
`instagram_business_basic`은 연결한 전문 계정과 게시물을 확인하는 데, `instagram_business_manage_comments`는 댓글 이벤트 및 비공개 답장을 처리하는 데, `instagram_business_manage_messages`는 수신 DM과 허용된 응답을 처리하는 데 사용합니다.
운영 화면은 연결·규칙·연락처·인박스·처리 내역을 제공하며, 사용자는 연결을 해제하고 데이터 삭제를 요청할 수 있습니다.

심사 영상은 다음 화면을 실제 계정과 테스트 데이터로 연속 녹화합니다.

1. 서비스 로그인과 Instagram 전문 계정 OAuth 권한 동의.
2. 연결한 계정의 게시물 선택, 댓글 키워드·첫 DM 규칙 설정, 수신·발송 스위치 확인.
3. 다른 테스트 계정의 댓글과 실제 비공개 답장, 확인 응답 및 후속 메시지.
4. 인박스에서 수신·수동 응답, 계정 연결 해제, 정책·삭제 안내 페이지.

영상은 아직 녹화하지 않았고 Meta 심사도 제출하지 않았습니다.
녹화 전에는 각 시나리오가 현재 앱 권한과 전송 정책에서 실제로 가능한지 다시 확인해야 합니다.
검수 설명과 화면은 실제로 시연한 동작만 제출합니다.

## 남은 실계정 검증

- 앱 역할이 없는 별도의 Instagram 전문 계정으로 OAuth 연결과 권한 동의를 확인합니다.
- 연결된 계정의 Webhook 구독 응답과 실제 `comments`·`messages`·`messaging_postbacks` 이벤트를 확인합니다.
- 기존 연결과 별개로 댓글 중복, 첫 DM의 허용된 발송, 버튼 응답, 팔로우 상태 확인 불가를 구분해 기록합니다.
- 테스트 계정의 연결을 해제하고 이후 수신·발송이 멈추는지 확인합니다.
- Meta 대시보드에서 각 권한의 실제 Access 등급과 App Review 결과를 확인한 뒤 일반 사용자 연결 공개 여부를 결정합니다.

실계정 연결·설정 변경·발송은 아직 이 기록에서 완료로 표시하지 않습니다.
관련 제품 계약은 [일반 사용자 연결 공개 조건](../specs/2026-09-29-instagram-public-access.md)에 있습니다.
