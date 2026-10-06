# 태그·단일 필드 AND/OR 검증

## 범위와 선행 상태

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 복합 조건 중 기존 태그와 단일 필드 두 조건의 AND/OR를 구현했습니다.
최신 main은 `791267e807fd54825b2abc720167c712f08bf7be`이며 선행 [Draft #158](https://github.com/AndrewDongminYoo/auto-chatter/pull/158)의 `db4c7dd6303257b8482f8e399c2b8d1733df72ca` 위에 별도 PR로 쌓습니다.
[보안 Draft #157](https://github.com/AndrewDongminYoo/auto-chatter/pull/157)과 #158의 현재 hosted CI는 통과했고 리뷰·인라인 지적은 없었습니다.
CodeRabbit은 Draft를 검토하지 않았다는 skip만 남겼으므로 리뷰 통과로 표현하지 않습니다.
이전 두 PR의 코드·scope를 변경하거나 병합하지 않습니다.

결합을 생략한 요청과 기존 저장 필터는 AND이며 응답의 기존 형태도 유지합니다.
OR는 태그와 필드 조건이 모두 있어야 하고 workspace·계정·페이지 커서는 항상 AND 제한입니다.
조회마다 현재 태그·값을 다시 평가하며 필터를 발송 동의나 발송 대상 스냅샷으로 사용하지 않습니다.

## 자동 검사와 업그레이드

새 DB 검사 네 개는 구현 전 미지원 조건의 400 또는 400 대 201/404 차이로 실패했고 구현 후 모두 통과했습니다.
AND/OR 매칭 조합, 0·false와 미입력, 같은 sender의 계정 격리, 외부·보관 필드 거부, 저장 재평가, 혼합·중복·잘못된 요청을 확인했습니다.
55명 OR 결과는 두 페이지에 중복 없이 나타났으며 두 조건을 모두 만족하는 사람도 한 명이었습니다.
제한된 서버 역할의 workerd에서도 저장·태그/값 재평가·외부 workspace 거부를 확인했습니다.

- `corepack pnpm check-types`: 통과.
- `corepack pnpm test`: 239개 통과.
- `TEST_DATABASE_URL=postgres://…@127.0.0.1:55433/automations_test corepack pnpm test:db`: 527개 통과.
- 같은 전용 DB의 `corepack pnpm test:cloudflare`: 58개 통과, bundle-only build 포함.
- 변경 파일 `trunk fmt`, 전체 `trunk check --all --no-fix`의 299개 파일과 `git diff --check`가 통과했습니다.

전용 PostgreSQL 17의 `data_directory`가 `/tmp/auto-chatter-segment-tests/pgdata`인지 확인한 뒤에만 테스트 DB를 재생성했습니다.
선행 #158의 스키마에서 0·false·빈 텍스트·윤일 일치 필터를 만들고 전체 마이그레이션 실행기로 037을 적용했습니다.
기존 필터는 AND로 보존됐고 업그레이드 후 저장한 OR도 실행기 두 번째 적용 뒤 유지됐습니다.
DB 제약은 잘못된 결합·OR의 태그/필드 제거를 거부했으며 RLS 활성화와 서버 DELETE 거부를 유지했습니다.

## 렌더링과 실제 조작

합성 사용자와 실제 로컬 API·DB를 연결한 Chromium에서 외부 요청을 차단했습니다.
negative·zero에 lead 태그를, zero·ten에 0 이상 값을 부여해 AND는 zero 한 명, OR는 세 명을 표시했습니다.
OR 질의 파라미터 전달 한 줄을 임시 제거하고 문서를 새로 로드하면 화면 검사가 `Expected 3 rendered contacts, received 1`로 실패했습니다.
원본 app.js 바이트는 finally로 복원했고 현재 코드의 화면 검사는 통과했습니다.

합성 저장 503 뒤 OR·0·이름 초안을 유지했고 재시도는 201이었습니다.
저장 필터를 다시 선택하면 OR와 값이 복원됐으며 보관 뒤 수동 조회도 OR를 유지했습니다.
태그나 필드를 제거하면 비활성화된 AND로 복귀했습니다.
키보드 Enter 제출과 390×844·1280×900 화면을 확인하고 스크린샷을 직접 검토했습니다.
390px 문서 폭은 390px이며 결합 문구·값·제출 버튼은 잘리지 않았습니다.
Safari·Firefox·실기기·화면 읽기 음성과 운영자 시각 승인은 수행하지 않았습니다.
날짜 선택기 조작은 이번 숫자 조건 화면 검증에 포함하지 않습니다.

## 후속과 적용 경계

#26의 다중·중첩 조건, 동의·활동, 대상 미리보기·제외 사유와 캠페인 대상 고정은 남아 있습니다.
기존 계약이 없는 제외 사유 분류나 #25의 식별자 병합 정책을 이 회차에서 새로 정하지 않았습니다.
개인 Wiki는 이번 세션에서 조회 도구가 없어 새 선례를 확인하지 않았으며 저장소의 필드·세그먼트 계약을 재사용했습니다.
Ralph 리뷰 예산을 재설정하거나 추가 중량 리뷰 에이전트를 시작하지 않았습니다.
운영 적용은 #157·#158을 포함한 선행 변경 검토와 전체 마이그레이션 실행기·배포의 별도 승인이 필요합니다.
`SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지하며 운영 DB·배포·실계정 변경·발송은 하지 않았습니다.
#11·#26은 열어 둡니다.
