# #199 네트워크 재측정 기록

## 결과와 판단

2026-10-16 08:56~08:57 KST에 서비스는 `LAX`, 비교 호스트 `www.cloudflare.com`은 `ICN`으로 응답했습니다.
서비스 공개 URL의 첫 바이트 시간은 0.450~0.727초였고, 두 호스트의 ICMP 10회에서는 각각 손실이 0회였습니다.
이번 표본에서는 #199의 2026-10-12 측정에 있던 심한 손실과 2~5초의 공개 페이지 첫 바이트 지연을 재현하지 못했습니다.
그러나 해외 처리 데이터센터는 다시 관찰했으며, 시간대·회선 조건이 같다고 확인하지 않았으므로 장애가 해결됐거나 특정 변경이 지연을 줄였다고 판정하지 않습니다.
#199는 열린 상태로 유지합니다.

## 조건과 한계

- 현재 Mac에서 `curl 8.7.1`을 사용했습니다.
  `.curlrc`를 읽지 않는 `-q`, 명시적 프록시를 우회하는 `--noproxy '*'`, IPv4를 사용하는 `-4`, 연결 제한 5초·요청 제한 20초를 적용했습니다.
- 기본 표본은 URL마다 새 `curl` 프로세스로 실행했습니다.
  연결 재사용은 아래 별도 표본에서만 확인했습니다.
  HTTP/2로 응답했고 인증·쿠키·압축 요청·재시도·리다이렉트 추적은 사용하지 않았습니다.
- trace에서 허용한 필드만 출력했습니다.
  두 호스트 모두 `loc=KR`, `warp=off`였지만, 이것으로 ISP나 다른 VPN의 사용 여부를 확인할 수는 없습니다.
- ISP·VPN 상태는 `[UNKNOWN]`입니다.
  과거 이슈의 “KT 회선으로 보임”을 현재 회선의 확인된 정보로 사용하지 않습니다.
  다른 통신사, IPv6, workers.dev 주소는 이번에 측정하지 않았습니다.
- 로그인 API·DB 응답·브라우저 렌더링·브라우저 캐시는 측정하지 않았습니다.
  이 결과는 실제 화면의 로딩 완료 시간이나 운영 배포 버전을 검증하지 않습니다.

## 공개 URL 측정

시각은 2026-10-15 23:56:45~23:56:50 UTC입니다.
각 URL을 세 번씩 번갈아 요청했고 12개 요청 모두 HTTP 200, `curl_exit=0`이었습니다.
아래 시간의 단위는 초이며, 연결 완료와 TLS 완료는 시작부터의 누적값입니다.
TLS 처리만의 시간은 두 누적값의 차이로 계산해야 합니다([curl 시간 필드](https://curl.se/docs/manpage.html#--write-out), 2026-10-16 확인).

| 대상                               | 처리 센터 | TCP 완료 중앙값 | TLS 완료 중앙값 | 첫 바이트 최소~최대 | 첫 바이트 중앙값 | 총시간 중앙값 | 본문 바이트 |
| ---------------------------------- | --------- | --------------- | --------------- | ------------------- | ---------------- | ------------- | ----------- |
| 서비스 `/privacy`                  | LAX       | 0.137171        | 0.293195        | 0.449867~0.726660   | 0.587173         | 0.588493      | 12,634      |
| 서비스 `/app/`                     | LAX       | 0.141606        | 0.292749        | 0.467930~0.637386   | 0.469238         | 0.501831      | 57,030      |
| 서비스 `/icons/auto-chatter.png`   | LAX       | 0.139827        | 0.291459        | 0.467421~0.618210   | 0.490230         | 0.496843      | 20,369      |
| `www.cloudflare.com/cdn-cgi/trace` | ICN       | 0.009168        | 0.019281        | 0.027116~0.031323   | 0.028563         | 0.028693      | 208~213     |

원표본의 첫 바이트·총시간과 `cf-ray`는 다음과 같습니다.
같은 표본 번호 안의 요청도 순차 실행이며 동시에 관찰한 값은 아닙니다.

| 표본 | 경로              | UTC 시각 | 첫 바이트 | 총시간   | cf-ray                 |
| ---- | ----------------- | -------- | --------- | -------- | ---------------------- |
| 1    | `/privacy`        | 23:56:45 | 0.726660  | 0.727959 | `a4b2c3205a69fda5-LAX` |
| 1    | `/app/`           | 23:56:45 | 0.637386  | 0.668265 | `a4b2c3250e4edb67-LAX` |
| 1    | 로고              | 23:56:46 | 0.618210  | 0.625890 | `a4b2c32968a2c78b-LAX` |
| 1    | 비교 호스트 trace | 23:56:47 | 0.031323  | 0.031380 | `a4b2c32b6d28ea21-ICN` |
| 2    | `/privacy`        | 23:56:47 | 0.587173  | 0.588493 | `a4b2c32dd96f7c43-LAX` |
| 2    | `/app/`           | 23:56:47 | 0.469238  | 0.501831 | `a4b2c3318dbb78ec-LAX` |
| 2    | 로고              | 23:56:48 | 0.490230  | 0.496843 | `a4b2c334ecac3777-LAX` |
| 2    | 비교 호스트 trace | 23:56:48 | 0.028563  | 0.028693 | `a4b2c3361e153f26-ICN` |
| 3    | `/privacy`        | 23:56:48 | 0.449867  | 0.454102 | `a4b2c338482afc03-LAX` |
| 3    | `/app/`           | 23:56:49 | 0.467930  | 0.497840 | `a4b2c33b6c5f8626-LAX` |
| 3    | 로고              | 23:56:49 | 0.467421  | 0.473683 | `a4b2c33eaf051e1d-LAX` |
| 3    | 비교 호스트 trace | 23:56:50 | 0.027116  | 0.027650 | `a4b2c33fbfb3018f-ICN` |

## 재검증·연결 재사용·ICMP

23:57:37 UTC에 `/app/app.js`는 `Cache-Control: no-cache`, ETag `"2d1b9b06b8ec1491493a7491ed84f767"`, HTTP 200으로 137,427바이트를 반환했습니다.
같은 ETag를 `If-None-Match`로 보낸 다음 요청은 HTTP 304, 본문 0바이트, 총시간 0.471040초였습니다(`cf-ray=a4b2c46bfbdd996a-LAX`).
이것은 조건부 요청이 전송량을 줄였다는 증거이며, 왕복 시간이 사라졌다는 뜻은 아닙니다.

23:57:38 UTC에 한 `curl` 프로세스로 `/privacy`를 두 번 요청했습니다.
첫 요청은 새 연결 1개·총시간 0.471830초, 다음 요청은 새 연결 0개·총시간 0.187957초였습니다.
두 요청 모두 HTTP/2 200, 12,634바이트였으며 두 번째 `cf-ray`는 `a4b2c4706872dc0e-LAX`였습니다.

23:57:38 UTC부터 서비스에, 23:57:47 UTC부터 비교 호스트에 `ping -n -c 10 -W 1000`을 실행했습니다(macOS의 `-W` 단위는 밀리초).
각각 10개 송신·10개 수신·손실 0.0%였으며 평균 RTT는 서비스 137.273ms, 비교 호스트 6.096ms였습니다.
이는 각 호스트에 대한 ICMP 10회 결과일 뿐 HTTP 요청의 손실률이나 모든 Cloudflare 주소의 상태가 아닙니다.

## 이전 기록과 공식 근거

- [#199 본문](https://github.com/AndrewDongminYoo/auto-chatter/issues/199)은 2026-10-12 밤 `SEA`, ICMP 10회 손실 60%, `/privacy` 첫 바이트 2~5초를 기록했습니다.
- [#199 후속 댓글](https://github.com/AndrewDongminYoo/auto-chatter/issues/199#issuecomment-6127964487)과 [운영 문서](2026-09-26-cloudflare-runbook.md)는 2026-10-13 01:01 KST에 `CDG`, 축소된 로고 20,369바이트·0.89초, ETag 재검증 304를 기록했습니다.
- [Cloudflare 경로 안내](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/geographic-traffic-routing/)(2026-10-16 확인)에 따르면 데이터센터는 시간·네트워크·IPv4/IPv6에 따라 달라질 수 있고, zone·계정·지원 요청으로 특정 센터를 고정할 수 없습니다.
  `cf-ray`의 처리 센터와 실제 네트워크 진입 지점도 다를 수 있으므로 이번 결과만으로 BGP 경로나 ISP를 원인으로 단정하지 않습니다.

## 다음 측정

우선 동일한 명령으로 다른 시간대와 다른 통신사에서 자료를 더 모읍니다.
매번 측정자가 알고 있는 회선 종류·통신사·VPN 상태와 UTC 시각을 함께 기록하고, 모르는 항목은 추정하지 않습니다.
반복 지연이 확인되면 공식 안내에 따라 ISP/ASN, 영향을 받은 요청의 시각·`cf-ray`, trace·traceroute·MTR을 준비하여 지원 문의 여부를 결정합니다.
방문자 IP가 들어 있는 trace 원문이나 네트워크 경로 원문은 공개 PR에 붙이지 않고 별도로 검토합니다.
이 작업에서는 요금제나 배포 구성을 변경하지 않았으며 지원 문의도 발송하지 않았습니다.

## 반복 측정 명령

아래는 `curl 8.7.1`과 zsh에서 실행한 측정 방식입니다.
`dns`, `tcp`, `tls`, `ttfb`, `total`은 초 단위입니다.
오류가 난 요청도 출력하므로 `curl_exit`가 0이 아니거나 상태가 200이 아닌 표본을 성공값에 섞지 않습니다.
trace 요청이 성공해도 `colo`가 비어 있으면 데이터센터를 확인하지 못한 것입니다.

```bash
set -o pipefail
date -u '+measurement_utc=%Y-%m-%dT%H:%M:%SZ'
for target_host in auto-chat.donminzzi.kr www.cloudflare.com; do
  printf 'trace_host=%s\n' "$target_host"
  curl -q --fail --silent --show-error --noproxy '*' -4 --connect-timeout 5 --max-time 20 "https://$target_host/cdn-cgi/trace" | awk -F= '$1 == "colo" || $1 == "loc" || $1 == "http" || $1 == "warp"'
  printf 'trace_exit=%s\n' "$?"
done
for sample in 1 2 3; do
  for target_url in https://auto-chat.donminzzi.kr/privacy https://auto-chat.donminzzi.kr/app/ https://auto-chat.donminzzi.kr/icons/auto-chatter.png https://www.cloudflare.com/cdn-cgi/trace; do
    printf 'sample=%s url=%s utc=%s\n' "$sample" "$target_url" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    curl -q --fail --silent --show-error --noproxy '*' -4 --connect-timeout 5 --max-time 20 -o /dev/null -w 'status=%{http_code} http=%{http_version} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download} ray=%header{cf-ray} cache=%header{cache-control}\n' "$target_url"
    printf 'curl_exit=%s\n' "$?"
  done
done
```
