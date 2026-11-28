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

## 2026-11-28 읽기 전용 확인과 제출 준비

### 대시보드 상태

개인 Meta 개발자 대시보드의 메인 앱 `AutoChatter`(`1802833180713730`)를 읽기만 했습니다.

- 앱 게시 상태는 "게시됨"이고, 이용 사례는 "Instagram에서 메시지 및 콘텐츠 관리" 하나입니다.
- 서비스가 OAuth로 요청하는 세 권한(`src/app/instagram-oauth.ts`)은 모두 "테스트 준비 완료"이며, 화면의 API 호출 수는 `instagram_business_basic` 515, `instagram_business_manage_comments` 33, `instagram_business_manage_messages` 44였습니다.
- 이용 사례 화면은 "Instagram 권한에 대한 고급 액세스 권한을 얻으려면 앱 검수를 완료하세요"라고 안내했습니다. 세 권한 모두 고급 액세스가 아닙니다.
- 앱 검수 화면은 "제출되지 않음"이고, 새 요청 초안에 Human Agent, `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_content_publish`, `instagram_business_manage_insights`, `instagram_business_manage_comments`가 들어 있었습니다.
- 기본 설정에는 개인정보처리방침(`/privacy`), 서비스 약관(`/service`), 데이터 삭제(`/data-deletion`) URL이 운영 주소로 들어가 있었고, 세 URL은 이날 공개 GET에 200을 돌려줬습니다. 카테고리는 "비즈니스용 Messenger 봇"입니다.
- 비즈니스 인증 상태는 이 화면들에서 확인하지 못했습니다.

### 제출 범위

- 초안에서 서비스가 쓰지 않는 `instagram_business_content_publish`, `instagram_business_manage_insights`와 Human Agent를 빼고, 코드가 요청하는 세 권한만 제출합니다. 쓰지 않는 권한의 요청은 거절 사유가 됩니다.
- Human Agent는 24시간이 지난 대화에 상담원이 7일까지 답하는 기능입니다. 지금 수동 답장은 24시간 창 안에서만 보내므로 이번 제출에 넣지 않습니다.

### 권한별 사용 설명 초안

`instagram_business_basic`:

> AutoChatter lets an Instagram professional account owner automate replies to comments and direct messages on their own account. After the owner logs in with Instagram, we read the account's ID and username to show which account is connected, and we read the account's own media (ID, caption, media type, image or thumbnail URL, permalink, timestamp) so the owner can choose the post that a comment rule applies to. We do not read other accounts' profiles or media.

`instagram_business_manage_comments`:

> The owner creates a rule for one of their own posts (keywords to match, words to exclude, and a first message). We receive comment webhooks for the connected account, match the comment text against the owner's rules, and send one private reply to the commenter for a matching comment, within the seven days Meta allows. We store the comment ID, the commenter's ID and username and the comment text to prevent duplicate replies and to show the owner a history. We never post public replies, hide or delete comments.

`instagram_business_manage_messages`:

> We use the messaging permission for three things on the connected account only: (1) after the private reply, we receive the commenter's reply or button tap and send the follow-up message the owner configured; (2) the owner can start an automated flow when someone sends a direct message that matches a keyword; (3) the owner's team can read received messages in the AutoChatter inbox and send a manual reply inside the 24-hour messaging window. Every send is checked just before it is made against the 24-hour window, the recipient's opt-out and the owner's pause and handoff settings. Message text is kept so the owner can read the conversation, and the owner can delete a person's or the whole account's data from the settings page.

### 영상 장면 순서 초안

한 영상에 세 권한을 순서대로 보여 줍니다. 각 장면은 운영에서 실제로 되는 동작만 녹화합니다.

1. `https://auto-chat.donminzzi.kr/app/`에 로그인하고, "계정"에서 Instagram으로 로그인해 세 권한에 동의합니다. 연결된 계정의 사용자명이 나오는 것을 보여 줍니다(`instagram_business_basic`).
2. "자동화"에서 연결한 계정의 게시물을 고르고, 키워드·첫 DM 규칙을 저장합니다(`instagram_business_basic`).
3. 다른 Instagram 계정으로 그 게시물에 키워드 댓글을 달고, 휴대폰에서 비공개 답장이 도착하는 것과 대시보드의 처리 내역을 보여 줍니다(`instagram_business_manage_comments`).
4. 같은 계정이 답장하거나 버튼을 누르면 후속 메시지가 오는 것을 보여 줍니다(`instagram_business_manage_messages`).
5. "인박스"에서 받은 DM을 열고, 상담을 시작해 수동 답장을 보내고, 휴대폰에서 받는 것을 보여 줍니다(`instagram_business_manage_messages`).
6. "계정"의 연결 해제와 "설정"의 데이터 삭제, 정책 페이지 세 개를 보여 줍니다.

### 심사관이 앱을 쓰는 방법

- 운영은 `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`이므로, `INSTAGRAM_INTERNAL_EMAILS`에 있는 확인된 이메일만 Instagram 계정을 연결할 수 있습니다([공개 접근 명세](../specs/2026-09-29-instagram-public-access.md)).
- 심사관이 직접 연결해 보려면 심사용 대시보드 계정을 하나 만들고 그 이메일을 `INSTAGRAM_INTERNAL_EMAILS`에 더해야 합니다. 아니면 영상과 설명만으로 제출합니다.
- 발송은 운영에서 꺼져 있으므로(`SEND_ENABLED=false`), 심사관이 보내기를 시험하는 동안에는 발송 창을 열어야 합니다.

### 정한 것

- 2026-11-28에 초안에서 Human Agent, `instagram_business_content_publish`, `instagram_business_manage_insights`를 뺐습니다. 초안에는 `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`만 남아 있고, 상태는 "제출되지 않음"입니다.
- 심사관용 대시보드 계정은 만들지 않고, 실제 계정으로 녹화한 영상과 사용 설명만으로 제출합니다. 운영의 공개 연결과 발송 설정은 바꾸지 않습니다. 심사관이 직접 시험하겠다고 하면 그때 계정을 준비합니다.

### 남은 일

- 영상 녹화(제 휴대폰과 다른 Instagram 계정이 필요하고, 장면 3~5는 발송 창이 필요합니다).
- 비즈니스 인증 필요 여부와 현재 상태.
- 제출 자체(제 Meta 계정으로 남는 행동).
