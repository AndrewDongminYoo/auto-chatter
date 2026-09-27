# Instagram 확인 버튼

## 목표

팔로우 확인 규칙의 첫 DM과 미팔로우 안내에 선택적인 확인 버튼을 붙입니다.
버튼 이름은 최대 20자로 설정하고, 클릭은 해당 대화의 확인 단어 응답과 동일하게 팔로우 확인을 시작합니다.
직접 입력한 확인 단어도 계속 지원합니다.

## 계약

- `confirmation_button_title`은 빈 문자열이면 기존 텍스트 방식입니다.
- 버튼은 팔로우 확인이 켜진 규칙에서만 사용하며 버튼이 붙는 메시지는 최대 640자입니다.
- postback payload는 서버가 만든 outbox 식별자를 포함하며 계정·발신자·대화·발송 상태와 대조합니다.
- 설정은 댓글 수신 시 스냅샷으로 보관하며 기존 대기에 새 버튼을 소급 적용하지 않습니다.
- 첫 DM과 미팔로우 재확인에는 버튼을 붙이고 최종 팔로워 답장에는 붙이지 않습니다.
- 서명 검증, 이벤트 중복 방지, 발송 스위치, 24시간 응답 창과 모호한 발송 결과 처리를 유지합니다.

## 비목표

다중 선택 분기, 링크 버튼, 임의 대화 빌더와 실제 발송 활성화는 이번 범위에서 제외합니다.

## 근거와 검증 한계

[Meta 공식 Postman 샘플](https://github.com/fbsamples/messenger-platform-samples/blob/main/postman/instagram-platform-api.postman_collection.json)은 Instagram Login의 button template과 postback을 제공합니다.
댓글 대상 private reply에 template을 함께 보내는 조합은 실제 Meta 계정에서 별도로 검증해야 합니다.
거부된 버튼 메시지를 텍스트로 자동 재발송하지 않습니다.
Oracle: `[no precedent found]`.
