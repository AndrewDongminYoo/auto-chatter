# ManyChat 대체제 기능별 수용 매트릭스

## 기준과 상태

[목표 명세](../specs/2026-09-25-messaging-automation-platform.md)와 [백로그](2026-09-27-manychat-backlog.md)의 알려진 필수 작업을 코드·로컬 검사·실계정·운영 적용으로 구분합니다.
기준은 `591cc091e5e3cdb55bba20fe65d3c662df800fd4`이며 이 표의 미완료는 구현된 첫 DM·팔로우·연락처 기능을 없다고 판정한 것이 아닙니다.
각 행은 해당 이슈의 확장 또는 최종 검증 완료 여부입니다.
문맥 조회의 로컬 근거는 [조회 검증 기록](2026-09-27-inbox-handoff-verification.md), 상담 전환은 [전환 검증 기록](2026-09-27-inbox-human-handoff-verification.md)에 있으며 공급자·운영 검증과 구분합니다.
채널 지원 표시는 코드와 공식 승인·실계정 왕복·운영 적용을 모두 확인한 범위로 제한합니다.
검증 담당자는 기능별 구현자·독립 검토자이며, 외부 계정·가격·정책·배포·발송의 승인 담당자는 운영자입니다.

| 작업                                                              | 요구 또는 검증                                                | 현재 코드                  | 로컬 증거                                                          | 공급자·실계정                | 운영 완료     |
| ----------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ | ---------------------------- | ------------- |
| [#12](https://github.com/AndrewDongminYoo/auto-chatter/issues/12) | ManyChat 대체 범위와 기능별 검증 매트릭스 확정                | 매트릭스 작성              | 53건 이슈 대응 확인                                                | 미검증                       | 완료하지 않음 |
| [#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13) | 병합된 연락처·필터·필드·자동화 중지·수신 인박스 운영 적용     | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#14](https://github.com/AndrewDongminYoo/auto-chatter/issues/14) | Instagram App Review·Advanced Access 및 추가 사용자 연결 검증 | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 운영자 Instagram 일부만 확인 | 완료하지 않음 |
| [#15](https://github.com/AndrewDongminYoo/auto-chatter/issues/15) | 회원가입·이메일 확인·비밀번호 복구·세션 만료 경로 완성        | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#16](https://github.com/AndrewDongminYoo/auto-chatter/issues/16) | Instagram 토큰 갱신·연결 상태·재인증 안내                     | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#17](https://github.com/AndrewDongminYoo/auto-chatter/issues/17) | DM 대화와 댓글 연락처 연결 및 상담 전환 정책 확정             | 조회·상담 전환 API 구현    | DB·workerd 조회·전환 확인                                          | 미검증                       | 완료하지 않음 |
| [#18](https://github.com/AndrewDongminYoo/auto-chatter/issues/18) | 인박스 수동 답장 outbox·정책 검사·발신 이력 구현              | PR #67 병합                | DB·workerd·단위 검사 확인                                          | 미검증                       | 완료하지 않음 |
| [#19](https://github.com/AndrewDongminYoo/auto-chatter/issues/19) | 인박스 답장 작성·전송 상태·실패 안내 화면                     | 서버 판정·작성기·이력 구현 | [로컬 화면 검증](2026-09-28-inbox-manual-reply-ui-verification.md) | 미검증                       | 완료하지 않음 |
| [#20](https://github.com/AndrewDongminYoo/auto-chatter/issues/20) | Instagram 첨부·발신 echo·수정·삭제·전달 이벤트 처리           | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#21](https://github.com/AndrewDongminYoo/auto-chatter/issues/21) | 작업 공간 초대·역할·멤버 제거와 서버 권한 검사                | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#22](https://github.com/AndrewDongminYoo/auto-chatter/issues/22) | 대화 담당자·열림/완료 상태·자동화 인계 구현                   | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#23](https://github.com/AndrewDongminYoo/auto-chatter/issues/23) | 인박스 검색·읽음·라벨·내부 메모·리마인더                      | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#24](https://github.com/AndrewDongminYoo/auto-chatter/issues/24) | 상담 답장 템플릿과 예약 답장                                  | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#25](https://github.com/AndrewDongminYoo/auto-chatter/issues/25) | 연락처 상세·동의 있는 식별자 연결·CSV 가져오기/내보내기       | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26) | 저장된 세그먼트 복합 조건·대상 미리보기·변경 감지             | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#27](https://github.com/AndrewDongminYoo/auto-chatter/issues/27) | 채널별 동의·수신 거부·차단 원장과 발송 guard                  | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#28](https://github.com/AndrewDongminYoo/auto-chatter/issues/28) | 플로 초안·버전·발행 검증 데이터 계약                          | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#29](https://github.com/AndrewDongminYoo/auto-chatter/issues/29) | 버전 고정 플로 실행·분기·중복 방지·실행 이력                  | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#30](https://github.com/AndrewDongminYoo/auto-chatter/issues/30) | 시각적 플로 편집기·미리보기·테스트 실행                       | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#31](https://github.com/AndrewDongminYoo/auto-chatter/issues/31) | 플로 태그·필드 동작·응답 수집·메시지 변수                     | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#32](https://github.com/AndrewDongminYoo/auto-chatter/issues/32) | 플로 지연·시퀀스·응답 대기·취소와 재개                        | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#33](https://github.com/AndrewDongminYoo/auto-chatter/issues/33) | Instagram 일반 DM·스토리 응답·멘션 시작 트리거                | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#34](https://github.com/AndrewDongminYoo/auto-chatter/issues/34) | Instagram 성장 트리거·공개 댓글 답장·링크 버튼 지원 조사      | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35) | 세그먼트 캠페인 초안·대상 확정·비용 미리보기                  | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36) | 캠페인 분할 발송·취소·진행률·부분 실패 복구                   | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#37](https://github.com/AndrewDongminYoo/auto-chatter/issues/37) | 채널 이벤트·대화·발송 capability 계약과 정책 경계             | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#38](https://github.com/AndrewDongminYoo/auto-chatter/issues/38) | Facebook Messenger Page 연결·수신·정책 적용 발송              | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#39](https://github.com/AndrewDongminYoo/auto-chatter/issues/39) | Telegram Bot 연결·수신·버튼·플로·수신 거부                    | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#44](https://github.com/AndrewDongminYoo/auto-chatter/issues/44) | 이메일 채널·발신 인증·반송·수신 거부·비용 상한                | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#45](https://github.com/AndrewDongminYoo/auto-chatter/issues/45) | SMS 출시 국가·발신번호·동의·요금 공급자 결정                  | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#46](https://github.com/AndrewDongminYoo/auto-chatter/issues/46) | SMS 발송·수신·STOP 처리·전달 결과 어댑터                      | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#47](https://github.com/AndrewDongminYoo/auto-chatter/issues/47) | 플로 외부 요청·서명된 outbound webhook·재시도                 | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#48](https://github.com/AndrewDongminYoo/auto-chatter/issues/48) | 작업 공간 API 키·연락처/플로 외부 API·제한과 감사             | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#49](https://github.com/AndrewDongminYoo/auto-chatter/issues/49) | Google Sheets 리드 동기화·중복 방지·CSV 대안                  | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#50](https://github.com/AndrewDongminYoo/auto-chatter/issues/50) | 자동화·캠페인·상담 전환·비용 리포트                           | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#51](https://github.com/AndrewDongminYoo/auto-chatter/issues/51) | 청구월 활성 연락처 원장·중복 제거·재계산                      | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52) | 플랜 권한·좌석·채널·활성 연락처·예산 상한                     | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#53](https://github.com/AndrewDongminYoo/auto-chatter/issues/53) | 판매 플랜·사업자·결제 공급자·환불/실패 정책 확정              | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54) | 구독 결제·체험·갱신·업/다운그레이드·해지 원장                 | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#55](https://github.com/AndrewDongminYoo/auto-chatter/issues/55) | 작업 공간 FAQ 지식·버전·검색·출처 관리                        | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#56](https://github.com/AndrewDongminYoo/auto-chatter/issues/56) | 응답 에이전트 모델 비교·구조화 출력·예산 제한                 | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#57](https://github.com/AndrewDongminYoo/auto-chatter/issues/57) | AI 답변 승인 guard·상담원 인계·운영 평가                      | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#58](https://github.com/AndrewDongminYoo/auto-chatter/issues/58) | 개인정보 내보내기·삭제·보관 정책과 Meta 연결 해제             | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#59](https://github.com/AndrewDongminYoo/auto-chatter/issues/59) | 비밀 없는 운영 지표·경보·지원 진단                            | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60) | 앱 전체·계정·작업 공간 발송 한도와 공정한 스케줄링            | 미구현                     | 미검증                                                             | 미검증                       | 완료하지 않음 |
| [#61](https://github.com/AndrewDongminYoo/auto-chatter/issues/61) | 운영 백업·복구 훈련·암호화 키 회전·배포 복구                  | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#62](https://github.com/AndrewDongminYoo/auto-chatter/issues/62) | 공개 다중 사용자 서비스 보안 회귀와 남용 방지                 | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#63](https://github.com/AndrewDongminYoo/auto-chatter/issues/63) | 가입부터 플로·인박스·결제까지 사용성·접근성 검증              | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |
| [#64](https://github.com/AndrewDongminYoo/auto-chatter/issues/64) | ManyChat 대체제 전체 수용 테스트·운영 증거·출시 판정          | 부분 기반                  | 기존 증거 있음, 추가 검증 필요                                     | 미검증                       | 완료하지 않음 |

## 공개 제공과 최종 완료 조건

현재 구현 채널은 Instagram이며 운영자 계정에서 제한된 첫 DM·팔로우 분기를 확인했습니다.
추가 사용자의 Advanced Access와 수신 인박스의 남은 운영 검증은 별도 완료 조건입니다.
확인 버튼은 모바일 Instagram 앱에서 표시되고 postback이 보관됐지만, 발송을 켠 상태의 팔로우 분기와 Chrome 웹의 표시 차이는 아직 검증하지 않았습니다.
WhatsApp·TikTok 이슈 #40–#43은 `unplanned`로 보관하며 현재 수용 범위에서 제외합니다.
Email·SMS·결제는 출시 국가·사업자·통화·비용·동의 정책을 운영자가 확정한 뒤 실제 제공 범위를 기록합니다.
FAQ AI는 오프라인 평가·초안 모드와 예산·인계가 확인되기 전 자동 발송을 허용하지 않습니다.

모바일 사용 사례는 반응형 웹에서 우선 검증합니다.
네이티브 앱·고급 A/B 실험·특정 CRM SDK는 최초 제품 명세의 후순위 또는 수요 검증 대상으로 유지하며 필요성이 확정되면 #12와 로드맵에 별도 필수 이슈를 추가합니다.
이들 항목을 이미 제공한다고 표시하거나 지원하지 않는 기능까지 포함한 동등성을 선언하지 않습니다.

[최종 검증 #64](https://github.com/AndrewDongminYoo/auto-chatter/issues/64)는 계획된 필수 작업과 새로 추가한 필수 기능에 수용 증거가 있어야 통과합니다.
제약 때문에 제공할 수 없는 필수 기능이 있으면 운영자가 범위 변경을 명시적으로 결정하기 전에는 전체 완료를 선언하지 않습니다.
상표·정확한 가격·비공식 API·동의 없는 채널 식별자 병합은 비목표로 유지합니다.
이 표를 만들었다는 사실만으로 제품 검증이나 #64 완료를 의미하지 않습니다.

## 업데이트 규칙

병합 후 각 행의 코드·로컬 증거를 해당 검증 기록에 연결합니다.
운영 관찰은 배포 버전·시각·대상과 함께 기록하며 이전 상태를 현재 상태로 추정하지 않습니다.
모의 응답으로 확인한 권한·수신·가격을 실제 공급자 결과로 표시하지 않습니다.
