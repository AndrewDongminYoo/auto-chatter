# 대시보드 디자인 토큰

## 목적

`/app/` 대시보드의 색, 글자 크기, 간격, 반지름과 포커스 표시를 하나의 토큰 집합으로 정합니다.
이 문서는 2026-11-11에 승인한 대시보드 디자인 기반 작업의 두 번째 단계이며, 첫 단계는 #327, #328, #329로 반영했습니다.
관련 이슈는 사용성과 접근성을 다루는 #63입니다(Refs #63).

배포된 대시보드를 검토한 결과 세 가지 문제가 있었습니다.

1. 본문, 도움말, 경고 문구의 크기와 색이 비슷해 글의 위계가 드러나지 않습니다.
   `public/app/styles.css`에는 `font-size` 선언이 75개 있고, 그중 49개가 11–13px입니다.
2. 입력란과 그 상태가 잘 보이지 않으며, 다크 모드에서 더 심합니다.
   입력란 테두리는 `--color-border`를 `--color-surface` 위에 그리며, 대비가 라이트 모드 1.30 : 1(`#dce1e5` / `#fdfefe`), 다크 모드 1.52 : 1(`#35414b` / `#19232d`)입니다.
   WCAG 2.2 SC 1.4.11이 조작 가능한 컨트롤의 경계에 요구하는 3 : 1에 미치지 못합니다.
3. 간격이 화면마다 다르고, `<details>` 접힘 영역이 열 수 있다는 표시를 보여 주지 않습니다.

## 범위와 비목표

이 문서의 PR은 명세만 추가하며 `public/app/`을 바꾸지 않습니다.
토큰 파일, 컨트롤, 글자 크기, 간격의 실제 변경은 [적용 순서](#적용-순서)의 후속 PR에서 합니다.

다음은 이 작업의 범위가 아닙니다.

- React, Tailwind 또는 컴포넌트 라이브러리 도입
- 화면 배치의 재설계, 메뉴 구조나 문구의 변경
- 런타임 의존성이나 빌드 단계의 추가
- 브랜드 색의 새 12단계 스케일 제작

## 원천과 결정

### 이름: shadcn/ui 테마 변수

토큰의 이름과 역할은 shadcn/ui의 테마 변수 이름(`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--accent`, `--border`, `--input`, `--ring`, `--primary`, `--primary-foreground`, `--destructive`, `--radius`)을 따릅니다.
상태 색은 `--warning`, `--success`, `--info`와 `-background`, `-border` 변형으로 확장합니다.
이 문서는 shadcn/ui의 변수 이름만 가져오며, shadcn/ui의 기본값은 확인하지 않았고 사용하지도 않습니다.

### 값: Radix Colors 3.0.0

토큰 값은 npm 패키지 `@radix-ui/colors@3.0.0`(MIT)에서 가져옵니다.
내려받은 패키지는 npm integrity `sha512-FUOsGBkHrYJwCSEtWRCIfQbZG7q1e6DgxCIOe1SUQzDe/7rXXeA47s8yCn6fuTNQAj1Zq4oTFi9Yjp3wzElcxg==`와 일치함을 확인했습니다.
값은 그 패키지의 `slate.css`, `red.css`, `amber.css`, `green.css`, `blue.css`, `jade.css`와 각 `-dark.css` 파일에서 읽었습니다.
각 파일의 첫 블록인 sRGB 16진 값만 사용하고, 그 뒤의 `@supports (color: color(display-p3 …))` 블록(Display P3 값)은 사용하지 않습니다.

Radix 파일은 `.dark` 클래스로 다크 모드를 바꾸지만, 대시보드는 `@media (prefers-color-scheme: dark)`로 바꿉니다.
그래서 Radix 파일을 그대로 배포하지 않고, 필요한 16진 값만 우리 토큰 파일 하나(`public/app/tokens.css`)에 옮겨 적습니다.
이 파일의 첫 주석에는 Radix의 MIT 저작권 표시와 허가 문구를 그대로 둡니다.
런타임 의존성(`package.json`의 `dependencies`)은 `pg` 하나로 유지하며, 빌드 단계도 추가하지 않습니다.

### 대비 계산

모든 대비는 WCAG 2.x 상대 휘도 공식으로 계산했습니다.

```plaintext
채널 c = 8비트 값 / 255
선형 값 = c ≤ 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4
L = 0.2126 R + 0.7152 G + 0.0722 B
대비 = (밝은 L + 0.05) / (어두운 L + 0.05)
```

계산은 위 Radix 파일의 sRGB 블록을 읽는 로컬 Node 스크립트로 했고, 결과는 소수 둘째 자리에서 **버림**했습니다.
버림을 쓰는 이유는 3.00으로 적힌 값이 실제로 2.996일 수 없게 하기 위해서입니다.
그래서 예를 들어 라이트 slate-9 `#8b8d98` / slate-1 `#fcfcfd`는 3.21, 다크 slate-8 `#5a6169` / slate-1 `#111113`은 3.00으로 적힙니다.
이 스크립트는 저장소에 넣지 않습니다.
같은 계산은 첫 구현 PR의 단위 테스트가 토큰 파일의 값으로 다시 수행합니다([검증](#검증)).

## 색 토큰

### 표면과 글자

라이트 모드는 지금처럼 바탕(`--background`)이 카드(`--card`)보다 어둡고, 다크 모드는 카드가 바탕보다 밝습니다.
이 위계를 유지하려고 라이트와 다크에서 같은 토큰에 다른 단계를 씁니다.

| 토큰                   | 역할                                                       | 라이트 값 (Radix)    | 다크 값 (Radix)      |
| ---------------------- | ---------------------------------------------------------- | -------------------- | -------------------- |
| `--background`         | 페이지 바탕, 읽기 전용과 비활성 입력란의 배경              | `#f0f0f3` (slate-3)  | `#111113` (slate-1)  |
| `--card`               | 카드, 패널, 입력란의 배경                                  | `#fcfcfd` (slate-1)  | `#18191b` (slate-2)  |
| `--muted`              | 보조 배경(기본 배지, 필터, 개수 표시)                      | `#e8e8ec` (slate-4)  | `#272a2d` (slate-4)  |
| `--foreground`         | 본문과 제목                                                | `#1c2024` (slate-12) | `#edeef0` (slate-12) |
| `--muted-foreground`   | 도움말, 캡션, 자리표시자, `<summary>` 화살표               | `#60646c` (slate-11) | `#b0b4ba` (slate-11) |
| `--border`             | 장식 테두리(카드, 구분선, 패널)                            | `#d9d9e0` (slate-6)  | `#363a3f` (slate-6)  |
| `--input`              | 조작 가능한 컨트롤의 경계(텍스트 입력, 선택, 체크, 라디오) | `#80838d` (slate-10) | `#777b84` (slate-10) |
| `--primary`            | 주요 버튼, 링크형 `<summary>`, 브랜드 강조                 | `#122d50` (브랜드)   | `#b3cceb` (브랜드)   |
| `--primary-foreground` | `--primary` 위의 글자                                      | `#fcfcfd` (slate-1)  | `#122d50` (브랜드)   |
| `--ring`               | 키보드 포커스 표시                                         | `#122d50` (브랜드)   | `#b3cceb` (브랜드)   |
| `--accent`             | 강조 배경(라벨 칩, 보낸 말풍선, 실행 경로)                 | `#d6f1e3` (jade-4)   | `#0b3b2c` (jade-4)   |
| `--accent-foreground`  | `--accent` 위의 글자                                       | `#1d3b31` (jade-12)  | `#1fd8a4` (jade-11)  |

`--input`의 단계는 입력란이 놓이는 모든 중립 표면(`--card`, `--background`, `--muted`)에서 3 : 1을 넘는 단계 중 대비가 가장 낮은 단계입니다.
라이트 slate-9는 slate-1에서 3.21이지만 slate-3에서 2.90, slate-4에서 2.70이고, 다크 slate-9는 slate-4에서 2.81이라서 쓰지 않습니다.
다크 slate-8은 slate-1에서 3.00이지만 slate-2에서 2.80입니다.
두 모드 모두 slate-10이 세 표면을 모두 통과합니다.

버튼은 글자 자체로 식별되므로 `button.secondary`의 테두리는 `--border`를 유지합니다.
SC 1.4.11은 컨트롤을 식별하는 데 필요한 시각 정보에 3 : 1을 요구합니다.
비활성 컨트롤은 SC 1.4.11의 예외이므로 대비 기준을 적용하지 않습니다.
체크박스와 라디오 버튼은 지금 브라우저 기본 모양으로 그려집니다.
첫 구현 PR은 그 경계가 두 모드에서 3 : 1 이상인지 화면에서 확인하고, 미치지 못하면 `--input`으로 직접 그립니다.

### 브랜드 색

현재 브랜드 남색 `#122d50`(라이트), `#b3cceb`(다크)와 민트 강조색 `#d8ede3`은 Radix 3.0.0 파일 어디에도 없는 값입니다.

`--primary`는 현재 남색을 유지합니다.
남색은 서비스의 첫인상을 정하는 색이고, 두 모드 모두 대비 여유가 커서(아래 표의 7–9번 쌍, 최소 8.40) Radix 스케일로 바꿀 접근성상 이유가 없습니다.
새 12단계 스케일은 만들지 않고, 모드마다 `--primary`와 `--primary-foreground` 두 값만 브랜드 상수로 둡니다.
`--ring`도 지금 포커스 윤곽선처럼 `--primary`와 같은 값을 씁니다.

민트 강조색은 Radix jade-4 `#d6f1e3`으로 옮깁니다.
현재 값 `#d8ede3`과 가까운 녹청색 단계이며, 다크 모드도 같은 jade 스케일에서 가져옵니다.

### 상태 색

위험, 경고, 성공, 안내는 Radix red, amber, green, blue에서 가져옵니다.
배경은 3단계, 장식 테두리는 7단계입니다.
글자 단계는 상태 배경과 모든 중립 표면에서 4.5 : 1을 넘어야 합니다.
라이트 11단계는 이 기준을 통과하지 못하므로(amber-11 / amber-3 4.24, green-11 / green-3 4.21, blue-11 / blue-3 4.25, red-11 / slate-4 4.26) 라이트는 12단계를, 다크는 11단계를 씁니다.

| 토큰                       | 역할               | 라이트 값 (Radix)    | 다크 값 (Radix)      |
| -------------------------- | ------------------ | -------------------- | -------------------- |
| `--destructive`            | 위험 글자, 상태 띠 | `#641723` (red-12)   | `#ff9592` (red-11)   |
| `--destructive-background` | 위험 배경          | `#feebec` (red-3)    | `#3b1219` (red-3)    |
| `--destructive-border`     | 위험 장식 테두리   | `#f4a9aa` (red-7)    | `#8c333a` (red-7)    |
| `--warning`                | 경고 글자, 상태 띠 | `#4f3422` (amber-12) | `#ffca16` (amber-11) |
| `--warning-background`     | 경고 배경          | `#fff7c2` (amber-3)  | `#302008` (amber-3)  |
| `--warning-border`         | 경고 장식 테두리   | `#e9c162` (amber-7)  | `#714f19` (amber-7)  |
| `--success`                | 성공 글자, 상태 띠 | `#193b2d` (green-12) | `#3dd68c` (green-11) |
| `--success-background`     | 성공 배경          | `#e6f6eb` (green-3)  | `#132d21` (green-3)  |
| `--success-border`         | 성공 장식 테두리   | `#8eceaa` (green-7)  | `#28684a` (green-7)  |
| `--info`                   | 안내 글자, 상태 띠 | `#113264` (blue-12)  | `#70b8ff` (blue-11)  |
| `--info-background`        | 안내 배경          | `#e6f4fe` (blue-3)   | `#0d2847` (blue-3)   |
| `--info-border`            | 안내 장식 테두리   | `#8ec8f6` (blue-7)   | `#205d9e` (blue-7)   |

알림과 배너의 왼쪽 띠는 상태를 전하는 표시이므로 `-border`가 아니라 글자 토큰(`--destructive`, `--warning`, `--success`, `--info`)으로 그립니다.
`.reminder-count`처럼 상태 색을 채움으로 쓰는 곳은 배경에 글자 토큰을, 글자에 `--card`를 씁니다.

### 대비 표

아래 쌍은 첫 구현 PR의 단위 테스트가 다시 계산하는 목록입니다.
최소 기준이 4.5인 쌍은 글자, 3인 쌍은 컨트롤 경계와 포커스 표시이며, "없음"은 장식이라 기준이 없음을 뜻합니다.

| 번호 | 글자 또는 표시         | 배경                       | 라이트 | 다크  | 최소 기준 |
| ---- | ---------------------- | -------------------------- | ------ | ----- | --------- |
| 1    | `--foreground`         | `--background`             | 14.40  | 16.24 | 4.5       |
| 2    | `--foreground`         | `--card`                   | 15.98  | 15.15 | 4.5       |
| 3    | `--foreground`         | `--muted`                  | 13.41  | 12.42 | 4.5       |
| 4    | `--muted-foreground`   | `--background`             | 5.22   | 9.05  | 4.5       |
| 5    | `--muted-foreground`   | `--card`                   | 5.79   | 8.44  | 4.5       |
| 6    | `--muted-foreground`   | `--muted`                  | 4.85   | 6.92  | 4.5       |
| 7    | `--primary-foreground` | `--primary`                | 13.50  | 8.40  | 4.5       |
| 8    | `--primary`            | `--background`             | 12.17  | 11.45 | 4.5       |
| 9    | `--primary`            | `--card`                   | 13.50  | 10.68 | 4.5       |
| 10   | `--accent-foreground`  | `--accent`                 | 10.19  | 6.81  | 4.5       |
| 11   | `--destructive`        | `--destructive-background` | 10.84  | 7.74  | 4.5       |
| 12   | `--destructive`        | `--card`                   | 12.12  | 8.34  | 4.5       |
| 13   | `--destructive`        | `--background`             | 10.93  | 8.95  | 4.5       |
| 14   | `--warning`            | `--warning-background`     | 10.46  | 10.26 | 4.5       |
| 15   | `--warning`            | `--card`                   | 11.09  | 11.48 | 4.5       |
| 16   | `--warning`            | `--background`             | 9.99   | 12.31 | 4.5       |
| 17   | `--card`               | `--warning`                | 11.09  | 11.48 | 4.5       |
| 18   | `--success`            | `--success-background`     | 10.99  | 7.85  | 4.5       |
| 19   | `--success`            | `--card`                   | 12.01  | 9.37  | 4.5       |
| 20   | `--success`            | `--background`             | 10.83  | 10.05 | 4.5       |
| 21   | `--info`               | `--info-background`        | 11.25  | 7.07  | 4.5       |
| 22   | `--info`               | `--card`                   | 12.30  | 8.36  | 4.5       |
| 23   | `--info`               | `--background`             | 11.09  | 8.97  | 4.5       |
| 24   | `--input`              | `--card`                   | 3.69   | 4.14  | 3         |
| 25   | `--input`              | `--background`             | 3.32   | 4.44  | 3         |
| 26   | `--input`              | `--muted`                  | 3.09   | 3.40  | 3         |
| 27   | `--ring`               | `--background`             | 12.17  | 11.45 | 3         |
| 28   | `--ring`               | `--card`                   | 13.50  | 10.68 | 3         |
| 29   | `--ring`               | `--muted`                  | 11.32  | 8.76  | 3         |
| 30   | `--border`             | `--card`                   | 1.36   | 1.53  | 없음      |
| 31   | `--accent`             | `--card`                   | 1.16   | 1.40  | 없음      |
| 32   | `--destructive-border` | `--card`                   | 1.84   | 2.21  | 없음      |
| 33   | `--warning-border`     | `--card`                   | 1.66   | 2.37  | 없음      |
| 34   | `--success-border`     | `--card`                   | 1.77   | 2.65  | 없음      |
| 35   | `--info-border`        | `--card`                   | 1.74   | 2.61  | 없음      |
| 36   | `--destructive`        | `--muted`                  | 10.17  | 6.84  | 4.5       |
| 37   | `--warning`            | `--muted`                  | 9.30   | 9.42  | 4.5       |
| 38   | `--success`            | `--muted`                  | 10.08  | 7.69  | 4.5       |
| 39   | `--info`               | `--muted`                  | 10.32  | 6.86  | 4.5       |

상태별 `-border`와 `-background`는 장식이므로 30–35번처럼 기준이 없습니다.
상태의 의미는 글자와 왼쪽 띠가 전합니다.
`<summary>` 화살표는 상태를 알리는 그래픽이라 3 : 1이 필요하며, `--muted-foreground`를 쓰므로 4–6번 쌍(최소 4.85)으로 충족합니다.

## 글자, 간격, 반지름

### 글자 크기

| 토큰                       | 크기 | 줄 높이 | 쓰임                                            |
| -------------------------- | ---- | ------- | ----------------------------------------------- |
| `--font-size-h1`           | 28px | 1.3     | 페이지 제목                                     |
| `--font-size-h2`           | 20px | 1.3     | 영역 제목                                       |
| `--font-size-h3`           | 17px | 1.3     | 카드 제목                                       |
| `--font-size-body`         | 15px | 1.6     | 본문, 입력란, 버튼                              |
| `--font-size-help`         | 13px | 1.5     | 도움말, 라벨 아래 설명, 경고 부연               |
| `--font-size-caption`      | 12px | 1.5     | 배지, 개수, 시각                                |
| `--font-size-input-mobile` | 16px | 1.6     | 767px 이하 화면의 `input`, `select`, `textarea` |

767px 이하 화면에서 `input`, `select`, `textarea`는 지금의 `styles.css` `@media (max-width: 767px)` 규칙처럼 16px을 유지하며 `--font-size-body`(15px)를 쓰지 않습니다.
iOS Safari는 글자 크기가 16px보다 작은 입력란에 포커스가 가면 화면을 확대하므로, 이 규칙을 없애거나 15px로 바꾸지 않습니다.

본문 15px에 맞춰 제목 h2와 h3은 지금의 19px, 16px에서 20px, 17px로 올립니다.
h1 28px은 유지합니다.
한국어 본문과 도움말은 기본 자간을 유지하며, 제목의 기존 `letter-spacing: -0.035em`은 바꾸지 않습니다.
지금 11px(9개)과 10px(1개)인 선언은 가장 작은 단계인 캡션 12px으로 올립니다.
지금 `:root`의 `font: 14px/1.6 …` 때문에 `1rem`은 14px이며, `font-size`의 `rem` 선언 8개와 `rem` 값을 쓰는 다른 선언 15개가 이를 기준으로 계산됩니다.
글자 위계 PR은 `:root`를 15px로 바꾸면서 같은 PR에서 이 `rem` 값을 모두 토큰이나 px로 바꿔, 기준 크기 변경으로 다른 값이 함께 커지지 않게 합니다.

### 간격

간격은 4px 배수만 씁니다.

| 토큰         | 값   |
| ------------ | ---- |
| `--space-1`  | 4px  |
| `--space-2`  | 8px  |
| `--space-3`  | 12px |
| `--space-4`  | 16px |
| `--space-5`  | 20px |
| `--space-6`  | 24px |
| `--space-8`  | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |

최소 터치 높이 44px(`min-height: 44px`)은 간격이 아니라 조작 영역 기준이므로 그대로 둡니다.

### 반지름

| 토큰            | 값     | 쓰임                                       |
| --------------- | ------ | ------------------------------------------ |
| `--radius-sm`   | 4px    | 작은 표시(지금의 3px)                      |
| `--radius`      | 6px    | 버튼, 입력란(지금의 `--radius-control`)    |
| `--radius-lg`   | 10px   | 카드, 패널, 말풍선(지금의 7–15px)          |
| `--radius-full` | 9999px | 알약 모양 칩, 원형 표시(지금의 999px, 50%) |

## 포커스와 접힘 영역

### 포커스 표시

모든 `:focus-visible`과 입력란의 `:focus`는 `2px solid var(--ring)`, `outline-offset: 2px`로 통일합니다.
지금은 일반 요소 4px, 입력란 2px로 다릅니다.
포커스 표시의 대비는 대비 표 27–29번(최소 라이트 11.32, 다크 8.76)입니다.

### `<details>` 접힘 영역

접힘 영역은 `index.html`의 5개와 스크립트가 만드는 9개(`app.js` 6개, `flow-editor.js` 1개, `inbox.js` 2개, 2026-11-11 `createElement("details")`와 `node("details"` 검색 기준)입니다.
그래서 규칙은 클래스가 아니라 모든 `summary`에 적용합니다.

- `list-style: none`과 `summary::-webkit-details-marker { display: none; }`로 브라우저 기본 표시를 숨기고, `summary::before`에 CSS 테두리로 그린 화살표를 둡니다.
  이미지나 인라인 스타일은 쓰지 않습니다.
- 화살표 색은 `--muted-foreground`이며, 닫히면 오른쪽, `details[open] > summary`이면 아래쪽(90도 회전)을 가리킵니다.
- 회전 전환은 `@media (prefers-reduced-motion: reduce)`에서 끕니다.
- `cursor: pointer`, 마우스를 올리면 `--muted` 배경, 키보드 포커스에는 위의 포커스 표시를 씁니다.
- 지금의 `min-height: 44px`을 유지합니다.

## 현재 사용자 정의 속성의 대응

`public/app/styles.css`의 `:root`(2–16행)와 다크 모드 블록(1475–1488행)에 있는 사용자 정의 속성은 다음 15개이며, `--radius-control`을 뺀 14개는 다크 모드에서 값이 바뀝니다.
한 속성이 여러 쓰임을 가지면 쓰임별로 다른 토큰에 대응합니다.

| 현재 속성 (라이트 / 다크)                      | 쓰임                                                       | 새 토큰                    |
| ---------------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| `--color-ink` (`#202e3d` / `#e1e8ee`)          | 본문, `button.secondary` 글자                              | `--foreground`             |
| `--color-muted` (`#5c6875` / `#a4b1bd`)        | 보조 글자, 자리표시자                                      | `--muted-foreground`       |
| `--color-brand` (`#122d50` / `#b3cceb`)        | 주요 버튼 배경과 테두리, 링크형 `<summary>`                | `--primary`                |
|                                                | 포커스 윤곽선                                              | `--ring`                   |
| `--color-on-brand` (`#f8fafc` / `#122d50`)     | 주요 버튼 글자, 개수 알약                                  | `--primary-foreground`     |
| `--color-border` (`#dce1e5` / `#35414b`)       | 카드, 구분선, 패널, `button.secondary`                     | `--border`                 |
|                                                | `input`, `select`, `textarea`의 테두리                     | `--input`                  |
| `--color-surface` (`#fdfefe` / `#19232d`)      | 카드, 입력란 배경                                          | `--card`                   |
|                                                | `.reminder-count` 글자                                     | `--card` (대비 표 17번)    |
| `--color-canvas` (`#f0f3f4` / `#131b23`)       | 페이지 바탕, 읽기 전용과 비활성 입력란                     | `--background`             |
| `--color-soft` (`#e8edef` / `#24323e`)         | 보조 배경                                                  | `--muted`                  |
| `--color-accent` (`#d8ede3` / `#203e34`)       | 성공 알림, 발송 켜짐 배너, 완료한 체크리스트, 성공 배지    | `--success-background`     |
|                                                | 라벨 칩, 보낸 말풍선, 실행 경로                            | `--accent`                 |
| `--color-success` (`#24533e` / `#b0dfc6`)      | 성공 글자, 성공 알림과 배너의 왼쪽 띠, 실행 경로의 왼쪽 띠 | `--success`                |
|                                                | 라벨 칩과 보낸 말풍선의 글자                               | `--accent-foreground`      |
| `--color-danger` (`#9b3229` / `#ffc0b7`)       | 위험 글자, `button.danger`, 위험 알림의 왼쪽 띠            | `--destructive`            |
| `--color-danger-soft` (`#fbece9` / `#442c2b`)  | 위험 배지와 알림의 배경                                    | `--destructive-background` |
| `--color-warning` (`#765217` / `#e2c693`)      | 경고 글자, 경고 배너와 알림의 띠, 점선 메모 테두리         | `--warning`                |
|                                                | `.reminder-count` 배경                                     | `--warning` (대비 표 17번) |
| `--color-warning-soft` (`#f7efdf` / `#383326`) | 경고 배지, 배너, 알림의 배경                               | `--warning-background`     |
| `--radius-control` (`6px`)                     | 버튼, 입력란, 패널                                         | `--radius`                 |

`--info` 계열에는 대응하는 현재 속성이 없으며, 글자 위계 PR에서 경고 블록을 나눌 때 안내 문구에 씁니다.
사용자 정의 속성이 아닌 하드코딩 값 `#7d97b51a`(73행과 401행의 버튼 hover 덧칠)는 기본 컨트롤 PR에서 없앱니다.
`button.secondary`의 hover는 `--muted` 배경으로, 주요 버튼의 hover는 같은 덧칠 값을 토큰 파일의 `--primary-hover-overlay`로 옮겨 유지합니다.

## 적용 순서

각 단계는 작은 PR 하나이며, 배포 후 운영 화면을 라이트와 다크 모드에서 승인받은 뒤 다음 단계로 넘어갑니다.

1. **토큰 파일과 기본 컨트롤.** `public/app/tokens.css`를 추가하고 `index.html`에서 `styles.css`보다 먼저 `<link>`로 불러옵니다.
   `styles.css`의 두 `:root` 블록은 위 대응표의 첫 토큰을 가리키는 별칭(`--color-ink: var(--foreground);` 등)으로 바꾸고, 쓰임이 나뉘는 곳(입력란 테두리, 포커스 윤곽선, 라벨 칩, 보낸 말풍선, 실행 경로, `.reminder-count`)은 새 토큰을 직접 씁니다.
   입력란, 버튼, 포커스 표시, `<details>`도 이 PR에서 바꿉니다.
2. **글자 위계.** 75개 `font-size` 선언을 글자 크기 토큰으로 바꾸고, 본문과 부연이 한 블록에 섞인 경고 블록을 제목 문장과 도움말 크기의 부연으로 나눕니다.
3. **간격과 정리.** 간격과 반지름을 토큰으로 바꾸고, 1단계의 별칭을 모두 새 토큰으로 바꾼 뒤 별칭을 지웁니다.

배포 조건은 다음과 같습니다.

- `/app/*`의 CSP는 `style-src 'self'`입니다.
  같은 출처의 `<link rel="stylesheet">`는 허용되지만 인라인 `<style>`과 `style=` 속성은 쓸 수 없습니다.
- `src/app/static-security.test.ts`의 공개 파일 허용 목록 `/^app\/[a-z0-9-]+\.(?:js|html|css)$/`는 이미 `app/tokens.css`를 받아들입니다.
  토큰 파일을 다른 경로나 이름 형식으로 두면 허용 목록을 함께 바꿔야 합니다.
- `public/_headers`의 `Cache-Control: no-cache`가 `/app/*` 전체에 적용되므로 새 파일도 배포 직후 다시 검증됩니다.

## 검증

첫 구현 PR은 단위 테스트(예: `src/app/design-tokens.test.ts`)를 추가하고 `package.json`의 `test` 스크립트 목록에 넣습니다.
이 테스트는 `public/app/tokens.css`의 라이트 블록과 `@media (prefers-color-scheme: dark)` 블록에서 16진 값을 읽고, [대비 표](#대비-표)의 모든 쌍을 위 공식으로 다시 계산해 최소 기준보다 낮으면 실패합니다.
값을 테스트 안에 다시 적지 않고 토큰 파일에서 읽어야, 토큰을 바꾸는 PR이 대비 기준을 깨뜨릴 때 테스트가 이를 잡습니다.
테스트가 기준을 실제로 검사하는지는 한 토큰을 기준 미달 값(예: `--input`을 slate-6)으로 바꿔 실패하는지 확인한 뒤 되돌려 증명합니다.

이 테스트는 토큰 값의 대비만 확인합니다.
토큰이 실제 화면의 어느 요소에 적용됐는지, 브라우저 기본 체크박스의 경계가 어떻게 그려지는지는 확인하지 않으므로, 각 단계의 운영 화면 승인으로 따로 확인합니다.
