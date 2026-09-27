# ManyChat 대체제 백로그와 문서 정합성

## 목표와 등록 기준

2026-09-27 기준 코드 `591cc091e5e3cdb55bba20fe65d3c662df800fd4`와 기존 제품 명세를 대조했습니다.
일반 GitHub 이슈가 없는 것을 확인한 뒤 [전체 로드맵 #11](https://github.com/AndrewDongminYoo/auto-chatter/issues/11)과 작업 이슈 53건을 등록했습니다.
로드맵은 작업의 완료 조건과 실제 이슈 번호로 연결한 선행 관계를 제공합니다.
구현된 연락처·필터·필드·자동화 중지·수신 인박스는 다시 구현할 작업으로 등록하지 않고 운영 적용과 확장 요구를 구분했습니다.
모의 검증·실계정·운영 배포를 같은 완료 상태로 취급하지 않습니다.

| 단계                | 작업 이슈 수 |
| ------------------- | ------------ |
| 0. 목표와 운영 기반 | 5            |
| 1. 인박스와 팀      | 8            |
| 2. 연락처와 플로    | 10           |
| 3. 캠페인과 채널    | 12           |
| 4. 연동과 분석      | 4            |
| 5. 사용량과 구독    | 4            |
| 6. AI               | 3            |
| 7. 운영과 최종 검증 | 7            |

P0는 첫 공개 운영 또는 최종 출시 관문, P1은 핵심 확장, P2는 채널·연동·AI 확장 순서입니다.
우선순위는 취약점 심각도 등급이 아닙니다.
외부 승인·사업자·출시 국가·결제 조건이 필요한 작업은 구현 전에 실제 가능성을 확인합니다.
최신 [ManyChat 공개 플랜](https://manychat.com/pricing), [인박스](https://help.manychat.com/hc/en-us/articles/14281070478748-Manychat-Inbox), [필드](https://help.manychat.com/hc/en-us/articles/14281167138588-Custom-User-Fields-and-Bot-Fields)를 2026-09-27 조회했으며 가격·상표·화면 복제는 범위에 넣지 않았습니다.
새 필수 기능이나 제약을 발견하면 로드맵의 기능 매트릭스와 하위 이슈를 갱신합니다.

## 다음 순서와 완료 계약

1. [기능별 검증 매트릭스 #12](https://github.com/AndrewDongminYoo/auto-chatter/issues/12)에서 승인·실계정·운영 증거가 필요한 항목을 고정합니다.
2. [운영 적용 #13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13)은 병합된 기능을 발송 중지 상태에서 확인합니다.
3. [DM 식별자와 상담 전환 #17](https://github.com/AndrewDongminYoo/auto-chatter/issues/17)을 정한 뒤 [수동 답장 API #18](https://github.com/AndrewDongminYoo/auto-chatter/issues/18)와 [화면 #19](https://github.com/AndrewDongminYoo/auto-chatter/issues/19)를 구현합니다.
   로컬 구현은 운영 적용을 기다리지 않으며 실제 답장 검증은 운영 적용과 계정별 발송 승인을 확인한 후 수행합니다.
4. 각 선행 작업을 따라 작은 PR로 진행하고 [최종 검증 #64](https://github.com/AndrewDongminYoo/auto-chatter/issues/64)에서 모든 작업의 증거를 대조합니다.

전체 추가 사용자 App Review가 기존 승인 계정의 로컬 구현과 시험을 불필요하게 막지 않도록 분리했습니다.
최종 검증은 다른 모든 작업 이슈를 직접 선행 조건으로 연결했습니다.
수동 답장은 명확히 미발송인 실패만 감사 가능한 새 시도로 예약하고, `unknown`은 공급자 조회로 미발송을 확인하거나 공급자 멱등성이 검증되기 전에는 재전송하지 않습니다.
독립 검토에서 발견한 최종 의존성 누락과 안전 재처리 조건 누락을 등록 전에 수정했습니다.

기존 최대 10회 Ralph Loop 계약은 유지합니다.
이슈 수가 반복 예산을 늘리거나 제품 완성을 증명하지 않습니다.
필수 기능·승인·실계정·운영 검증이 남으면 `ManyChat 대체제 구현 및 검증 완료`를 사용하지 않습니다.

## 문서 드리프트 수정 근거

| 수정 대상                                                | 현재 근거                                                                                                                                    | 수정 내용                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| README·CLAUDE·다중 사용자 명세                           | `src/instagram/inbox.ts`, `src/app/inbox.ts`, `db/schema.sql`                                                                                | 선택 보관한 텍스트 DM·확인 버튼 응답을 저장하며, 기본 꺼짐·보관 시작 시각을 따른다고 명시했습니다.    |
| README·CLAUDE·Cloudflare·단일 서버·다중 사용자 배포 절차 | `deploy/migrate-multi-user.sql`                                                                                                              | 현재 runner가 003–012와 접근 정책을 하나의 트랜잭션으로 적용한다고 수정했습니다.                      |
| Cloudflare 배포 절차                                     | `deploy/supabase-access.sql`                                                                                                                 | 오래된 고정 테이블 수 대신 실제 접근 정책의 대상 목록을 기준으로 삼았습니다.                          |
| 전체 명세·최초 구현 계획·다중 사용자 명세                | `public/app/`, `src/app/instagram-oauth.ts`, [첫 실발송](2026-09-26-first-live-reply-test.md), [팔로우 분기](2026-09-26-live-follow-test.md) | 이미 구현한 사용자 화면·OAuth 및 제한된 실계정 발송을 미구현·미검증으로 적은 안내를 수정했습니다.     |
| 전체 기술 명세                                           | `public/app/index.html`, `public/app/app.js`, `package.json`                                                                                 | 실제 화면은 정적 HTML·CSS·JavaScript이며 React·Next.js는 도입하지 않았다고 수정했습니다.              |
| 다중 사용자 삭제 절차                                    | `db/schema.sql`의 외래 키                                                                                                                    | 인박스·태그·필드·필터·중지 테이블과 수신 DM 본문을 포함하고 자식 행부터 삭제하는 순서를 갱신했습니다. |
| 연락처 자동화 중지 계획                                  | `src/instagram/follow-flow.ts`, `src/instagram/inbox.ts`                                                                                     | 확인 receipt의 재실행 방지와 별도 인박스의 본문 보관 조건을 분리했습니다.                             |
| 배포 버전·발송 상태 안내                                 | 2026-09-26 검증 기록, `wrangler.json`                                                                                                        | 특정 버전과 종료 상태를 당시 관찰로 한정하고 최신 운영 상태를 조회한 것처럼 쓰지 않았습니다.          |

현재 코드의 마이그레이션 범위와 운영에서 실제 적용한 범위를 구분합니다.
당시 검증 건수·최초 배포의 003–006 적용 기록과 초기 조사 가격표는 역사적 기록으로 유지했습니다.
수동 삭제 정책·RLS·발송 스위치·코드·배포 설정은 이 문서 수정으로 변경하지 않았습니다.

## 검증 경계

문서 검사에서는 변경 파일의 형식·상대 링크·앵커·오래된 현재형 주장과 실제 runner 및 스키마의 대응을 확인했습니다.
Trunk의 markdownlint·Prettier·git-diff-check가 변경 문서 11개에서 문제를 찾지 않았으며 내부 링크·앵커 46개가 실제 파일과 제목으로 연결됩니다.
링크 검사기는 없는 파일과 앵커를 넣었을 때 먼저 실패하는 것을 확인했습니다.
GitHub 검증에서는 등록한 54개 이슈의 제목·본문·열림 상태·선행 링크와 로드맵 체크리스트를 다시 읽어 초안과 일치함을 확인했습니다.
GitHub 검사기는 로드맵 본문을 제거한 fixture에서 먼저 실패하는 것을 확인했습니다.
문서와 이슈만 바꾸므로 기능 테스트나 운영 배포를 새로 수행했다는 뜻이 아닙니다.

## Oracle 선례

`wiki/concepts/plan-audit-verify-against-code.md`의 체크 상태보다 실제 코드를 확인하라는 선례를 적용해 구현 완료·남은 구현·외부 검증을 분리했습니다.
`wiki/entities/plan-audit.md`의 manifest 기반 검증 선례에 따라 이슈의 검사 명령은 현재 `package.json`에 선언된 명령을 사용했습니다.
두 선례의 sourceCommit은 `c1681868ac634e4b2414874716bb75a7864113c4`이며 Wiki freshness는 미확인입니다.
개인 auto-chatter의 직접적인 `ManyChat parity` 선례는 `[no precedent found]`입니다.
