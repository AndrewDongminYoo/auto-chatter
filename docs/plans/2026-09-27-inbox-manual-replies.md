# 수동 답장 서버 구현 계획

## 승인된 범위

#18의 서버 API·outbox·발신 이력을 현재 작업 공간에서 구현합니다.
기존 인증·상담 전환·Graph 오류 분류를 사용하며 새 의존성을 추가하지 않습니다.
화면·운영 배포·실발송은 별도 승인과 후속 이슈로 남깁니다.

## 실행과 성공 기준

1. 소유권·UUID 키·상담 버전·답장 창과 감사 재시도 API → 검증: settings.db.test.ts의 API·동시 요청·키 충돌·만료·다른 작업 공간 테스트.
2. migration 014와 append-only 권한 → 검증: 새 설치·migration 재적용·Supabase 두 서버 역할·Compose 초기 grants·API 역할 차단.
3. 대화별 claim·attempt 조건부 결과·중단 복구 → 검증: 동시 워커·미해결 unknown 차단·운영자 no_retry 결정·명확한 거부·감사 실패 rollback.
4. Cloudflare OAuth 수동 워커와 최종 POST guard → 검증: test:cloudflare의 모의 Graph, 토큰 변경·상담 재개·창 만료·계정 수신 중지·중복 알림·cron 복구.
5. 타입·전체 unit/DB/workerd·Trunk → 검증: check-types, test, test:db, test:cloudflare, trunk check.
6. 로컬 적대적 코드·보안 검토와 수정 → 검증: 실제 후보 diff, 실패 재현과 수정 후 관련 테스트.
7. 작은 의미 단위 커밋·푸시·PR → 검증: 현재 head CI, Code Review와 Security Review, 모든 리뷰 thread와 적용 가능한 CodeRabbit 신호.
8. 운영자 merge 요청 → 검증: 원격 PR head와 로컬 HEAD 일치; 화면 변경 없음.

## 위험과 경계

DB와 공급자 POST는 원자적이지 않습니다.
애매한 결과를 재발송하지 않으며 최종 검사 뒤 이미 시작한 요청을 취소했다고 주장하지 않습니다.
전체 발송 중지는 예약을 막지만 기존 요청 키의 이력 조회를 막지 않습니다.
다른 대화는 독립적으로 처리하고 같은 대화는 pending·sending·미해결 unknown 앞 행을 기다립니다.
기존 Node 환경 변수 워커와 follow-flow의 빠른 확인 시각 문제는 이번 작업에서 변경하지 않습니다.
