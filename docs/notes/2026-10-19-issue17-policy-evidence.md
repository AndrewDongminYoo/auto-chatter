# #17 식별자·상담 전환 정책과 로컬 수용 근거

## 범위와 판단

[#17](https://github.com/AndrewDongminYoo/auto-chatter/issues/17)의 세 완료 조건을 `bdf1fa757403d0b7918c210b246764a1479acff9`의 코드·명세·회귀 테스트와 대조했습니다.
선행 이슈 [#12](https://github.com/AndrewDongminYoo/auto-chatter/issues/12)는 GitHub 조회에서 닫힌 상태로 확인했습니다.
기존 [식별자 계약](../specs/2026-09-27-inbox-handoff-contract.md)과 [상담 전환 계약](../specs/2026-09-27-inbox-human-handoff.md)을 그대로 유지하며, 아래 세 조건에 대응하는 구현과 로컬 재현 근거가 있습니다.
이번 변경은 그 근거를 한곳에 연결하고 수용 현황표의 정책 상태를 분명히 합니다.
식별자·발송·동의 정책, 소스·스키마·화면은 변경하지 않습니다.

## 유지하는 정책

1. DM 대화 키 `(workspace_id, connection_id, recipient_id)`와 댓글 연락처 키 `(workspace_id, connection_id, sender_id)`를 구분합니다.
   수동 답장은 소유한 저장 대화의 DM 상대를 대상으로 하며, 숫자나 이름이 같은 댓글 작성자로 대체하지 않습니다.
2. 댓글 연락처 연결은 같은 작업 공간·연결의 성공한 비공개 답장 응답과 원본 댓글 작성자가 일치하는 저장 근거로만 판정합니다.
   공급자 메시지 ID가 없거나 실패·`unknown`·미래 발송 시각인 행은 근거로 사용하지 않습니다.
   근거가 없으면 `unmapped`, 서로 다른 작성자가 있으면 `ambiguous`, 한 작성자의 근거가 모두 현재 인박스 보관 경계보다 오래됐으면 `stale`로 구분합니다.
   보관 시작 시각이 없을 때도 `stale`이며, 한 작성자의 최신 근거가 있어야 `verified`입니다.
   현재 Facebook Login 전송기는 상대 ID를 반환하지 않으므로 성공 발송이어도 다른 유효한 연결 근거가 없으면 `unmapped`입니다.
3. 이 연결은 저장된 응답에 따른 참고 정보입니다.
   현재 공급자 신원을 재검증하거나 마케팅 동의를 부여하거나 서로 다른 계정의 연락처를 병합하지 않습니다.
4. 상담 시작은 현재 `verified` 근거가 있는 대화만 허용하고 당시 댓글 작성자와 근거 ID를 보관합니다.
   직접 중지 `paused`와 상담 중지 `handoff_paused`를 독립적으로 유지하며, 해당 작성자에게 연결된 활성 상담이 하나라도 있으면 상담 중지를 유지합니다.
5. 재개는 보관한 작성자의 상담 중지 사유만 해제합니다.
   이후 근거가 오래되거나 사라져도 종료할 수 있지만 직접 중지나 다른 활성 상담의 사유는 해제하지 않습니다.
   버전이 오래된 반대 요청은 거부하고, 같은 운영자의 직전 변경을 같은 버전·목표 상태로 반복하면 감사 행을 추가하지 않습니다.
6. 자동화는 claim과 발송 전 경계에서 중지 상태를 검사합니다.
   최종 검사 이후 이미 공급자 요청에 들어간 발송은 상담 전환으로 취소할 수 없습니다.
   재개로 `unknown`·실패·차단 결과를 초기화하거나 자동 재발송하지 않습니다.

## 완료 조건별 근거

| #17 완료 조건                                                        | 현재 구현                                                                                                                                                                                                                            | 실제로 검사하는 로컬 사례                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 작업 공간·연결·DM 상대 경계를 정의하고 동일 숫자 추정을 금지         | [문맥 API](../../src/app/inbox.ts)의 `inboxContext`·`readInboxContext`, [공유 연결 근거](../../src/app/inbox-identity.ts)의 작업 공간·연결·원본 작성자 결합, [수동 답장](../../src/app/manual-replies.ts)의 대화 범위와 DM 상대 저장 | [settings DB 테스트](../../src/app/settings.db.test.ts)의 `inbox context never equates equal numeric comment and DM identities`, `inbox context scopes identical recipients by account and workspace`, 잘못된 상대·없는 대화·query 거부 사례                                                                                                                        |
| 확인 가능한 매핑과 매핑 불가를 구분하고 다른 사용자·계정 연결을 차단 | `readInboxContext`의 `unmapped`·`stale`·`ambiguous`·`verified` 판정과 비확인 상태의 작성자·근거 비공개                                                                                                                               | 같은 파일의 성공 응답 연결, 오래된 근거·서로 다른 작성자 충돌, 같은 작성자 중복, 실패·unknown·미래 시각·원본 불일치 제외, 수신이 로컬 발송 완료 기록보다 먼저 도착한 사례                                                                                                                                                                                           |
| 상담 중지·재개 범위와 중복·오래된 매핑·동시 발송을 재현              | [상담 변경](../../src/app/inbox-handoff.ts)의 연결·대화 잠금, 버전 검사, 보관한 작성자와 독립 중지 사유·감사 기록                                                                                                                    | settings DB 테스트의 중복 시작·감사, 근거 유실 후 재개·직접 중지 보존, 다른 상담 사유 유지, 동시 중복 시작·오래된 반대 요청; [reply-worker DB 테스트](../../src/instagram/reply-worker.db.test.ts)의 claim 전 중지·검증 중 상담 시작; [대화 DB 테스트](../../src/app/inbox-conversations.db.test.ts)의 이미 시작한 send는 취소하지 못하고 다음 발송은 보류하는 사례 |

원래 [문맥 조회 검증](2026-09-27-inbox-handoff-verification.md)과 [상담 전환 검증](2026-09-27-inbox-human-handoff-verification.md)은 당시 실패 재현·수정·DB 및 workerd 결과를 기록합니다.
그 기록은 각 PR의 역사적 검증 범위이며 현재 운영 상태를 대신하지 않습니다.
[DB 스키마](../../db/schema.sql)의 `instagram_inbox_handoffs` 기본 키는 `(workspace_id, connection_id, recipient_id)`이며 연결·댓글 연락처·연결 근거의 외래 키도 작업 공간과 연결 범위를 포함합니다.
`instagram_manual_replies`는 같은 대화 키를 상담 전환 행의 외래 키로 참조하고 그 대화 안에서 요청 키를 유일하게 유지합니다.

## 이번 로컬 재검사

기준 코드에서 별도의 임시 PostgreSQL 17 클러스터와 `automations_test`를 만들고 아래 명령을 실행했습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<임시 포트>/automations_test \
  node --test --test-concurrency=1 --test-name-pattern='inbox context|handoff' \
  src/app/settings.db.test.ts src/instagram/reply-worker.db.test.ts src/app/inbox-conversations.db.test.ts
corepack pnpm check-types
```

관련 DB 테스트 26건이 통과했고 실패·취소·건너뜀은 없었습니다.
이름 필터는 식별자·상담 사례뿐 아니라 상담 상태를 검사하는 수동 답장·담당자 변경 사례도 선택합니다.
이 검사는 실제 PostgreSQL의 행·잠금·버전·감사·발송 전후 상태를 확인하며 공급자 호출은 대체합니다.
타입 검사도 통과했습니다.
테스트 중 출력되는 `rate_limit_unavailable`과 감사 실패 재현의 `database_error`는 로컬 fixture의 로그이며 운영 장애를 조회한 결과가 아닙니다.
이번 재검사는 전체 DB·workerd 묶음의 새 결과나 실계정 왕복·공급자 승인·운영 적용을 증명하지 않습니다.

## 남은 수용 범위

[수용 현황표](2026-09-27-manychat-acceptance-matrix.md)의 #17은 정책·코드·로컬 근거와 공급자·실계정·운영 완료를 구분해서 읽습니다.
세 완료 조건에 대응하는 근거를 정리했지만, 이 문서만으로 이슈 전체 완료나 운영 수용을 선언하지 않습니다.
실계정 검증을 진행하려면 대상 작업 공간·연결·기존 대화와 조회 범위를 정하고 승인을 받아야 합니다.
저장된 문맥의 읽기 전용 확인은 신규 공급자 응답이나 실발송 중 경합을 검증하지 못하므로, 상담 시작·재개·실발송·배포는 각각 필요한 범위를 별도로 정합니다.
발송 설정을 켜거나 실제 고객 데이터를 검증 fixture로 사용하지 않았습니다.

#25의 식별자 병합·분리는 이 참고 연결과 다른 기능으로, 아직 구현되지 않았으며 별도 계약과 동의 조건이 필요합니다.
#17의 기존 정책을 유지한다는 사실만으로 #25·#27의 완료 조건이나 #26의 전체 의존성을 해소하지 않습니다.
GitHub 이슈 상태·의존성·완료 체크박스는 이번 변경에서 수정하지 않습니다.

## 선례와 검토 방향

같은 #17 근거 대조를 위해 앞서 조회한 개인 프로젝트 `auto-chatter`의 Oracle 결과를 재사용했습니다.
`identity mapping`·`handoff evidence` 직접 주제의 결과는 \[no precedent found\]였습니다.
더 넓은 부분 조회에서 얻은 `wiki/concepts/plan-audit-verify-against-code.md`와 원본 `raw/sources/.claude/skills/plan-audit/SKILL.md`는 체크리스트를 현재 코드와 먼저 대조하는 방향을 뒷받침했습니다.
이 선례에 따라 기존 기능을 다시 구현하지 않고 완료 조건별 근거를 연결했습니다.
`wiki/concepts/diagnostic-report-pattern.md`와 원본 `raw/sources/.claude/commands/fix-with-test.md`는 관찰한 로컬 결과와 검증하지 않은 운영 결과를 구분하는 데 적용했습니다.
반환된 원본 revision은 `c1681868ac634e4b2414874716bb75a7864113c4`이며 Wiki freshness는 미확인이고 더 넓은 조회는 부분 결과입니다.
Advisor도 기존 정책·구현과 실계정 증거의 부족을 구분한 뒤 실제로 없는 근거부터 확인하도록 권고했습니다.
