# ManyChat 유료 모델 대안 조사

조사일: 2026-09-25.
이 문서는 공개 문서와 저장소를 근거로 한 설계 입력입니다.
가격, API 권한, 국가별 이용 가능 여부는 변경될 수 있으므로 실제 출시 직전에 다시 확인해야 합니다.
아래의 WhatsApp·TikTok 비교와 채택 전 확인 항목은 조사 당시 기록입니다.
현재 구현 범위에서는 두 연동을 제외했으며, [제품 명세](../specs/2026-09-25-messaging-automation-platform.md)와 `unplanned` 이슈 #40–#43을 기준으로 범위를 판단합니다.

## 해석과 조사 범위

요청한 “같은 대안”은 ManyChat의 유료 플랜이 제공하는 메시징 자동화, 공유 인박스, 연락처 관리, 캠페인, AI 응답, 사용량 기반 구독을 자체 서비스에서 제공하는 목표로 해석했습니다.
브랜드, 화면 구성, 문구, 내부 구현을 복제한다는 뜻으로 해석하지 않았습니다.
이번 조사에서는 계정을 연결하거나 외부 API에 쓰기 요청을 보내지 않았으므로, 공개 문서에 적힌 기능과 실제 계정에서 승인되는 기능은 구분합니다.

## ManyChat 기준선

2026년 새 요금제는 Free, Essential, Pro, Business, Advanced로 안내됩니다.
공식 문서는 새 요금제의 지역별 제공 여부와 기존 계정 이전 시점이 다르다고 설명합니다.
아래 금액은 미국 달러 기준 공개 안내이며, 연간 열은 연 단위로 결제할 때의 월 환산 금액입니다.
[공식 가격표](https://manychat.com/pricing), [요금제 전환 안내](https://help.manychat.com/hc/en-us/articles/25800228332572-Pro-plan).

| 플랜                                                                                   | 월 결제 / 연간 월 환산 | 월 포함 활성 연락처 | 사용자 / 인박스 좌석 | 채널 범위                                                     | 초과 활성 연락처 단가, 월 결제 기준 |
| -------------------------------------------------------------------------------------- | ---------------------- | ------------------- | -------------------- | ------------------------------------------------------------- | ----------------------------------- |
| [Free](https://help.manychat.com/hc/en-us/articles/25800197498652-Free-plan)           | $0                     | 25                  | 1 / 1                | Instagram·TikTok·Messenger·Telegram 중 2개                    | 초과 과금 없음                      |
| [Essential](https://help.manychat.com/hc/en-us/articles/25800276116508-Essential-plan) | $17 / $14              | 250                 | 2 / 1                | 위 채널 중 2개                                                | $0.10                               |
| [Pro](https://help.manychat.com/hc/en-us/articles/25800228332572-Pro-plan)             | $39 / $29              | 2,500               | 3 / 2                | Instagram·TikTok·Messenger·WhatsApp·Telegram·SMS·Email 중 3개 | $0.05                               |
| [Business](https://help.manychat.com/hc/en-us/articles/25800254159900-Business-plan)   | $99 / $69              | 7,500               | 5 / 3                | 모든 지원 채널                                                | $0.025                              |
| [Advanced](https://help.manychat.com/hc/en-us/articles/25800308984988-Advanced-plan)   | $199 / $139            | 25,000              | 10 / 5               | 모든 지원 채널                                                | $0.004부터                          |

ManyChat은 해당 청구월에 자동화, AI, 발송 또는 인박스를 통해 메시지를 주고받은 사람을 활성 연락처로 계산합니다.
고객과 주고받은 메시지 횟수와 별개로 같은 사람을 월 1회 계산한다고 안내합니다.
정확한 다중 채널 동일인 판별 방법은 공개 가격표만으로 확인되지 않으므로, 우리 서비스에서는 검증된 계정 연결 없이 서로 다른 채널 ID를 임의로 합치지 않습니다.
[활성 연락처 정의](https://manychat.com/pricing).

### 유료 기능을 제품 요구로 바꾸기

- Essential 수준: 댓글·스토리·DM 트리거, 무제한 자동화, 연락처 태그, 이메일·전화번호 수집, Google Sheets 동기화가 필요합니다.
  [Essential 공식 안내](https://help.manychat.com/hc/en-us/articles/25800276116508-Essential-plan).
- Pro 수준: 채널 간 자동화, WhatsApp 발송, AI 응답, 사용자 지정 인박스 규칙, 외부 API 연동, 팀 사용 권한이 필요합니다.
  [Pro 공식 안내](https://help.manychat.com/hc/en-us/articles/25800228332572-Pro-plan).
- Business·Advanced 수준: 모든 채널, 배정·라우팅, 더 많은 좌석, 대량 발송, 사용량 측정과 초과 과금이 필요합니다.
  [Business 공식 안내](https://help.manychat.com/hc/en-us/articles/25800254159900-Business-plan), [Advanced 공식 안내](https://help.manychat.com/hc/en-us/articles/25800308984988-Advanced-plan).
- 핵심 사용 사례는 댓글의 키워드에 반응해 개인 메시지로 이어지는 흐름, 자동 DM 응답, 리드 수집, 세그먼트 발송, 사람 상담원 전환입니다.
  [ManyChat 제품 설명](https://manychat.com/pricing), [자동화 화면 안내](https://help.manychat.com/hc/en-us/articles/14281111044124-Automation-tab-Overview).

기존 Free/Pro 문서와 새 다단계 요금제 문서가 함께 검색됩니다.
특히 기존 AI 추가 상품 안내를 새 Pro의 AI 포함 여부에 그대로 적용하면 잘못된 결론이 됩니다.
이 문서는 위의 2026년 새 플랜별 문서를 기준으로 삼습니다.
[기존 플랜에 대한 공식 주의 문구](https://help.manychat.com/hc/en-us/articles/14281409288604-Billing-FAQ), [새 Pro 문서](https://help.manychat.com/hc/en-us/articles/25800228332572-Pro-plan).

## Facebook 외 공식 API와 비용 대안

“무료 대안”은 같은 플랫폼의 사용자를 다른 서비스에서 마음대로 발송할 수 있다는 뜻이 아닙니다.
Instagram, TikTok, WhatsApp의 수신자에게 도달하려면 해당 플랫폼의 공식 권한이 필요하며, Telegram이나 이메일로 옮기려면 이용자가 그 채널을 선택해야 합니다.
따라서 아래에서 동일 채널 대체가 불가능하면 명시합니다.

| 연동          | 필요한 기능과 공식 경로                                                                                                                                                                                                                                                       | 비용·승인상 제약                                                                                                                                                                                                                              | 저비용 또는 무료 경로                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instagram     | [Meta Instagram API](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login)로 비즈니스·크리에이터 계정의 메시지와 댓글을 처리합니다. `instagram_business_manage_messages`와 `instagram_business_manage_comments` 권한을 별도로 확인합니다. | 전문 계정과 앱 권한이 필요합니다. [Send API](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api)는 수신자가 먼저 대화를 시작해야 한다고 설명합니다. 댓글 기반 private reply의 세부 기한과 심사 결과는 실계정으로 검증해야 합니다. | 직접 Meta 앱을 운영할 수 있지만 심사를 피하는 동등한 무료 API는 없습니다.                                                                              |
| WhatsApp      | [Cloud API](https://www.postman.com/meta/whatsapp-business-platform/overview)로 웹훅 수신, 메시지·승인된 템플릿 발송을 구현합니다.                                                                                                                                            | Meta는 국가와 메시지 범주별로 전달된 메시지에 과금합니다. 현재 공식 가격표는 서비스 메시지와 이용자 요청에 대한 일부 유틸리티 응답을 무료로 안내합니다. [공식 가격](https://whatsappbusiness.com/products/platform-pricing/).                 | Meta Cloud API 직접 연동은 중개 사업자 수수료를 피하는 경로입니다. WhatsApp 수신자에게 도달하는 동등한 무료 우회 API는 없습니다.                       |
| TikTok        | [Business Messaging API](https://business-api.tiktok.com/gateway/docs/index?identify_key=c0138ffadd90a955c1f0670a56fe348d1d40680b3c89461e09f78ed26785164b&language=ENGLISH)로 Business 계정의 DM과 자동 메시지를 처리합니다.                                                  | 앱 접근 승인과 지역 조건이 관문입니다. [Chatwoot의 공식 연동 안내](https://www.chatwoot.com/hc/user-guide/en/categories/other-channels)는 적격 지역, 이용자 선대화, 답장 창 제한을 설명합니다.                                                | 대체 무료 공개 DM API를 확인하지 못했습니다. 승인 전에는 출시 필수 채널로 간주하지 않습니다.                                                           |
| Telegram      | [Bot API](https://core.telegram.org/bots/api)로 웹훅, 명령, 메시지와 발송을 구현합니다.                                                                                                                                                                                       | [공식 FAQ](https://core.telegram.org/bots/faq)는 기본 발송을 무료로 안내하지만 대량 발송 속도 제한과 유료 고속 발송 옵션이 있습니다.                                                                                                          | 첫 검증 채널로 사용합니다. Telegram 사용자의 동의를 받아야 하며 Instagram·WhatsApp 사용자를 대신할 수는 없습니다.                                      |
| Email         | SMTP 또는 이메일 API로 옵트인 발송, 반송·수신 거부를 처리합니다.                                                                                                                                                                                                              | 대량 발송에는 발신 도메인 인증과 전달성 관리가 필요합니다.                                                                                                                                                                                    | [Resend 무료 플랜](https://resend.com/pricing)은 월 3,000건과 일 100건을 안내합니다. 자체 SMTP는 소프트웨어 사용료 대신 운영·전달성 비용을 부담합니다. |
| SMS           | 국가별 발신번호와 메시징 사업자 API가 필요합니다.                                                                                                                                                                                                                             | [Twilio 가격표](https://www.twilio.com/en-us/sms/pricing/us)는 전송량, 번호, 통신사 비용이 발생한다고 안내합니다. 국가마다 조건이 다릅니다.                                                                                                   | 운영용 SMS를 같은 도달성으로 무료 제공하는 경로는 확인하지 못했습니다. 초기에는 옵트인 이메일·Telegram로 비용을 낮추고 SMS는 후순위로 둡니다.          |
| Google Sheets | [Sheets API](https://developers.google.com/workspace/sheets/api/limits)로 리드를 내보냅니다.                                                                                                                                                                                  | 표준 사용은 현재 추가 비용이 없지만 분당 할당량과 2026년 말 초과 사용 과금 예정 안내가 있습니다. [최소 권한 범위](https://developers.google.com/workspace/sheets/api/scopes)로 `drive.file`을 우선 검토합니다.                                | CSV 내려받기와 서명된 웹훅을 무료 기본 경로로 제공합니다.                                                                                              |
| 구독 결제     | 법인·사업자 관할에 맞는 결제 사업자를 선택합니다. 한국 상점은 [토스페이먼츠 빌링키 API](https://docs.tosspayments.com/guides/v2/get-started/llms-quick-reference)를 검토합니다.                                                                                               | 토스페이먼츠는 빌링 계약과 자체 구독 주기 구현이 필요합니다. [자동결제 안내](https://docs.tosspayments.com/guides/billing/overview). [Stripe 지원 국가](https://stripe.com/global)는 사업자 소재지별로 확인해야 합니다.                       | 샌드박스·수동 청구로 개발할 수 있으나 실제 카드 결제 수수료가 없는 동등한 운영 대안은 가정하지 않습니다.                                               |
| AI 응답       | FAQ 검색과 모델 호출을 분리합니다. 모델은 답변 초안·의도 분류에만 사용합니다.                                                                                                                                                                                                 | 호스팅 모델은 사용량 비용이 들고, 로컬 모델도 서버·운영 비용이 듭니다.                                                                                                                                                                        | [Ollama 로컬 API](https://ollama.com/blog/streaming-tool)를 실험 대안으로 두되, 공개 서비스의 품질과 처리량은 벤치마크 후 결정합니다.                  |
| LINE, 선택    | 한국·아시아 지역 확장이 필요하면 [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/overview/)를 별도 채널로 추가합니다.                                                                                                                                  | 국가별 공식 계정 플랜과 월 발송 한도가 다릅니다. [공식 가격 안내](https://developers.line.biz/en/docs/messaging-api/pricing/).                                                                                                                | 무료 할당량 안에서 검증할 수 있지만 ManyChat 기능 동등성에 필요한 채널은 아닙니다.                                                                     |

CRM·커머스 시스템은 처음부터 개별 SDK를 여러 개 추가하지 않습니다.
서명된 outbound webhook, inbound API, CSV, Google Sheets를 기본 통합 지점으로 제공하고 실제 고객 수요가 확인되면 특정 CRM 또는 상점 API를 채택합니다.
ManyChat도 Pro 이상에서 CRM·커머스 통합을 안내하지만, 특정 공급자를 필수로 지정하지 않습니다.
[Pro 공식 안내](https://help.manychat.com/hc/en-us/articles/25800228332572-Pro-plan).

## 유사 오픈소스 평가

재사용 가설: 처음부터 채널 인증·웹훅·플로 엔진·인박스를 모두 만드는 대신, 공식 API를 사용하며 수정 가능한 코어가 있으면 첫 출시까지 필요한 새 코드와 운영 위험을 줄일 수 있습니다.
도입 금지 조건: 라이선스가 유료 SaaS 제공을 금지하거나, 핵심 채널이 비공식 중계에 의존하거나, 중요한 장애를 재현·해결하지 못하는 경우입니다.
평가 점수는 기능 일치 4점, 수정·서비스 제공 권리 2점, 유지관리·테스트 근거 2점, 작은 첫 수정 가능성 2점으로 계산했습니다.
점수는 저장소를 실제 배포해 품질을 보증한다는 뜻이 아닙니다.

| 후보                                                                 | 확인한 구현·라이선스 근거                                                                                                                                                                                                                                                                                                                     | 적합도 | 결론                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ChatbotX Community Edition](https://github.com/ChatbotXIO/ChatbotX) | README가 Instagram·WhatsApp·TikTok·Telegram·Email, 시각적 플로, 인박스, 방송, 댓글 자동화를 안내합니다. [MIT 코어와 별도 상용 영역](https://github.com/ChatbotXIO/ChatbotX/blob/main/LICENSE)이 분리되어 있고 [CI](https://github.com/ChatbotXIO/ChatbotX/blob/main/.github/workflows/ci.yml)에 타입·린트·테스트가 있습니다.                  | 8/10   | 가장 가까운 검증 후보입니다. [워커 메모리 증가 이슈 #1255](https://github.com/ChatbotXIO/ChatbotX/issues/1255), [플로 편집기 이슈 #1297](https://github.com/ChatbotXIO/ChatbotX/issues/1297), 상용 빌링 영역을 확인한 뒤 CE만 사용해야 합니다. |
| [Chatwoot Community Edition](https://github.com/chatwoot/chatwoot)   | [MIT 코어·별도 Enterprise 라이선스](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE), [Instagram·TikTok·WhatsApp·Telegram 인박스](https://www.chatwoot.com/hc/user-guide/articles/1677492191-adding-inboxes), [이벤트·조건·작업 규칙](https://www.chatwoot.com/hc/user-guide/articles/1677689800-how-to-use-automation)이 있습니다. | 7/10   | 인박스 대안으로 강합니다. ManyChat식 댓글→DM 플로·리드 마케팅은 큰 추가 개발이 필요하므로 단독 제품 코어로 확정하지 않습니다.                                                                                                                  |
| [BrightBean Chat](https://github.com/brightbeanxyz/brightbean-chat)  | 6개 채널과 플로·인박스를 설명하지만 자체적으로 [pre-1.0](https://github.com/brightbeanxyz/brightbean-chat#about-brightbean-chat)이라 밝힙니다. [AGPL-3.0](https://github.com/brightbeanxyz/brightbean-chat/blob/main/LICENSE)입니다.                                                                                                          | 5/10   | 코드 참고 또는 공개 소스 서비스라면 검토할 수 있습니다. TikTok과 AI가 빠져 있고 수정 서비스의 소스 제공 의무를 검토해야 합니다.                                                                                                                |
| [RapidPro](https://github.com/rapidpro/rapidpro)                     | 시각적 메시징 플로 플랫폼이고 [AGPL-3.0](https://github.com/rapidpro/rapidpro/blob/main/LICENSE)입니다.                                                                                                                                                                                                                                       | 4/10   | 플로 엔진 선례로 유용하지만 ManyChat식 크리에이터 인박스와 요금제 구현은 별도 작업이 큽니다.                                                                                                                                                   |
| [OpenReply](https://github.com/diwenne/openreply)                    | 공식 Meta API를 쓰는 Instagram 댓글→개인 메시지에 집중하며 [MIT](https://github.com/diwenne/openreply/blob/main/LICENSE)입니다.                                                                                                                                                                                                               | 5/10   | Instagram 한 기능의 비교 구현 또는 작은 검증 출발점입니다. 멀티채널·구독 전체 제품의 기반으로는 범위가 좁습니다.                                                                                                                               |
| [Typebot](https://github.com/baptisteArno/typebot.io)                | 시각적 챗봇 빌더이지만 웹 임베드 중심이며 현재 [Functional Source License](https://github.com/baptisteArno/typebot.io/blob/main/LICENSE)입니다.                                                                                                                                                                                               | 3/10   | 상업적 제공 조건을 별도로 확인해야 하므로 코어 채택을 보류합니다.                                                                                                                                                                              |
| [ZernFlow](https://github.com/zernio-dev/zernflow)                   | 플로 빌더와 MIT 코드는 있지만 채널 연결이 [Zernio API 키](https://github.com/zernio-dev/zernflow#quick-start)에 의존합니다.                                                                                                                                                                                                                   | 3/10   | 자체 공식 API 연동 목표와 맞지 않아 제외합니다.                                                                                                                                                                                                |
| [n8n](https://github.com/n8n-io/n8n)                                 | 자동화 도구이지만 [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)는 해당 소프트웨어의 유료 제공에 제한을 둡니다.                                                                                                                                                                                              | 2/10   | ManyChat 대안 SaaS의 제품 코어로 사용하지 않습니다.                                                                                                                                                                                            |

우선 검증할 재사용 후보는 ChatbotX Community Edition 한 곳입니다.
현재는 `adopt`가 아니라 `investigate`입니다.
기능 경계와 코드가 실재하는 것은 확인했지만, 우리 환경에서 빌드·채널 연결·장시간 워커 실행을 확인하지 않았고 알려진 운영 문제도 남아 있습니다.
검증을 통과하면 CE를 포크해 필요한 과금과 정책을 별도 구현하는 방향이 가장 작은 출발점입니다.
통과하지 못하면 [제품 명세](../specs/2026-09-25-messaging-automation-platform.md)의 TypeScript 모듈형 모놀리스 경계를 자체 구현합니다.

## 채택 전 확인할 사실

1. ChatbotX CE만으로 로컬 빌드·타입 검사·테스트가 통과하고, 상용 코드 없이 플로·인박스·채널 연동이 실행되는지 확인합니다.
2. 공식 Meta 앱에서 Instagram 댓글 웹훅과 private reply 권한을 실제로 승인받을 수 있는지 확인합니다.
3. TikTok Business Messaging API가 목표 사업자 국가에서 승인 가능한지 확인합니다.
4. ChatbotX 이슈 #1255의 워커 메모리 증가가 재현되는지, 고정 버전에서 해결됐는지 확인합니다.
5. 결제 계약 국가와 제공할 요금제가 확정되면 결제 공급자·수수료·웹훅을 다시 평가합니다.

## 프로젝트 선례 조회 상태

개인 계정용 Oracle에 `automations` 프로젝트 선례 조회를 요청했지만, 이 저장소는 새로 만든 저장소이고 원격·인덱스 매핑이 없어 canonical 프로젝트 ID를 검증하지 못했습니다.
따라서 선례 검색은 실행되지 않았으며 결과는 `[PARTIAL]`입니다.
이번 설계에 반영한 프로젝트별 Oracle 선례는 없습니다.
