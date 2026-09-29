# Instagram 확인 버튼 검증

## 구현과 운영 준비

팔로우 확인 규칙에 버튼 이름을 선택적으로 저장합니다.
빈 이름은 기존 텍스트 방식이며, 버튼을 켜면 첫 DM과 미팔로우 안내에 같은 이름의 postback 버튼을 붙입니다.
버튼 클릭은 대화 식별자로 연결하고 계정·발신자·상태·메시지 시각과 중복 receipt를 검사합니다.
확인 단어를 직접 입력하는 방식도 유지합니다.

기존 DB에는 배포 전에 `007_confirmation_button.sql`을 관리자 트랜잭션에서 적용해야 합니다.
`deploy/migrate-multi-user.sql`은 이 마이그레이션도 포함합니다.
RLS와 API 역할 권한은 완화하지 않았습니다.
기존 Instagram 연결은 다시 연결해 `comments,messages,messaging_postbacks` 구독을 갱신해야 합니다.
Meta 앱에서도 `messaging_postbacks` 필드 구독을 확인합니다.
이 PR에서는 운영 DB 변경, 재연결, 배포와 실발송을 수행하지 않습니다.

## 근거와 한계

[Meta 공식 샘플](https://github.com/fbsamples/messenger-platform-samples/blob/main/postman/instagram-platform-api.postman_collection.json)의 Instagram Login button template 형식을 사용합니다.
버튼 이름 20자와 템플릿 메시지 640자는 이 서비스가 적용한 제한입니다.
댓글 대상 private reply의 버튼 템플릿 조합, Instagram 클라이언트별 표시와 실제 postback 수신은 별도 실계정 테스트가 필요합니다.
provider가 거부한 버튼 DM을 텍스트로 자동 재발송하지 않습니다.
버튼 자체가 팔로우 여부를 증명하지 않으며 클릭 뒤 기존 공식 조회를 수행합니다.
Oracle: `[no precedent found]`.

## 자동·브라우저 검증

postback 파싱, 일반 DM 버튼 payload, 설정 왕복과 OAuth 구독 테스트가 수정 전에 실패한 것을 확인했습니다.
격리된 로컬 브라우저에서 합성 계정·규칙으로 설정 불러오기, 두 위치의 버튼 미리보기, 비활성 규칙 저장 payload, 버튼 끄기와 641자 입력 차단을 확인했습니다.
390px 화면의 document 폭도 390px이며 브라우저 오류는 없었습니다.
썸네일은 테스트용 앱 아이콘이므로 실제 Instagram 버튼의 모양을 입증하지 않습니다.

타입 검사, 단위 테스트 93개, DB 테스트 82개, workerd 테스트 21개와 변경 파일 Trunk 검사가 통과했습니다.
발송 경로와 설정·마이그레이션 경로의 독립 적대적 리뷰는 차단 항목 없이 완료됐습니다.
루트 추가 검토에서 Meta의 `is_self` postback 차단 회귀를 실패 후 수정해 통과시켰습니다.

## 운영 관찰

2026-09-29에 새 게시물의 승인된 테스트 댓글에서 버튼 템플릿 첫 DM을 한 건 발송했습니다.
Meta는 메시지 ID를 반환했고 Chrome의 Instagram 대화에 본문이 도착했지만, 같은 메시지의 `확인` 버튼은 보이지 않았습니다.
버튼 클릭과 postback 수신은 검증하지 못했으며, 팔로우 후속 DM도 보내지 않았습니다.
전역·계정·테스트 규칙 발송은 다시 껐습니다.
모바일 Instagram 앱에서 동일한 메시지의 버튼 표시를 비교한 뒤 클라이언트 차이와 템플릿 전달 문제를 구분해야 합니다.
상세 근거는 [#13 운영 검증 기록](2026-09-29-issue13-production-verification.md)에 있습니다.
