# Independent Windows Browser

Mixdog의 빌트인 Browser Use와 별개로 실행되는 Windows 브라우저 플러그인입니다.
같은 배포 폴더를 Claude Code에 일반 MCP 서버로 등록해 쓸 수도 있습니다.
기본 브라우저 엔진은 **Camoufox (패치된 Firefox 158)**이며, WebHID·WebUSB 장치 연결이
필요한 워크플로우에서는 `WB_ENGINE=electron`(또는 `browser-policy.json` `"engine": "electron"`)으로
내장 Electron 44.9.1 엔진을 명시적으로 선택할 수 있습니다.
배포 폴더에는 실행기와 런타임 구성이 포함되어 있어 사용자는 Node.js 설치나 수동 빌드를 하지 않습니다.

## 에이전트에게 제공되는 도구

공개 MCP 도구는 `browse` 하나이며 `action`으로 동작을 고릅니다. 에이전트가 보는 이름은
Mixdog에서 `mcp__plugin-win-browser__browse`, Claude Code에서 `mcp__win-browser__browse`입니다.
관련 웹 작업에는 `independent-browser` 스킬이 안내를 제공하며, Claude Code에서는 MCP 서버
지침(instructions)이 같은 안내를 전달합니다.
훅은 Mixdog에서만 쓰는 내부 인증·호출 수명 처리용이지 추가 에이전트 도구가 아닙니다.

| 범위 | action |
| --- | --- |
| 페이지·탭 | `open`, `navigate`, `list_tabs`, `close_tab` |
| 로그인 상태가 분리된 세션·영구 프로필 | `list_profiles`, `create_session`, `list_sessions`, `close_session` |
| 관측·읽기 | `observe`, `read`, `evaluate` |
| 개발자 도구(디버깅) | `console`, `network`, `inspect`, `performance` |
| 입력·폼 | `click`, `fill`, `type`, `press`, `select`, `scroll` |
| HTML 업로드·다운로드 상태·대화상자 | `upload`, `downloads`, `handle_dialog` |
| 요청·권한 | `requests`, `respond`, `permissions` |
| 표시·사람 인계·상태·회수 | `hide`, `show`, `handoff`, `status`, `revoke` |
| 여러 단계 한 번에 실행 | `run` |

`read`는 웹페이지 읽기이며 일반 파일 읽기가 아닙니다.

`run`은 폼 입력·선택·제출처럼 정해진 여러 단계를 짧은 스크립트(Playwright와 비슷한
`page.getByRole(...).click()` 형식)로 한 번에 실행합니다. 스크립트는 네트워크·Node·페이지에
직접 닿지 못하는 별도의 격리된 숨은 창에서 돌며, 각 단계는 직접 호출할 때와 똑같은 확인을
거쳐 한 번만 실행됩니다. 결과가 불확실한 단계가 나오거나, 사용자가 중지·직접 조작을 하거나,
제한 시간(기본 60초, 최대 100초)이 지나면 실행이 그 자리에서 끝납니다. 결과에는 단계별
처리 결과와 각 탭에서 바뀐 내용이 담깁니다. 스크립트 창은 미리 연결(preconnect)·WebRTC로도
네트워크에 닿지 못하며, 한 실행이 끝나면 그 창의 저장 데이터는 지워집니다. 스크립트의 한
단계가 연 대화상자나 파일 선택 요청은 실행이 끝난 뒤에도 남아 에이전트가 이어서 답할 수 있습니다.

페이지 결과는 짧은 텍스트입니다. 첫 줄은 처리 결과(`executed click e7 tab=t1 snap=s8 session=ctx1 name="Default"`),
그 다음은 새 알림(이동·팝업·다운로드·대화상자·대기 중 요청·콘솔 오류 수 등), 그리고 화면에
보이는 요소 목록입니다. 요소마다 `e<n>` 참조가 붙고, 참조는 그 요소가 바뀌지 않는 한 계속
쓸 수 있습니다. 클릭·입력 같은 동작은 화면 전체 대신 바뀐 내용만 돌려주며, 알림·상태 메시지·
토스트처럼 새로 나타난 문구와 스크롤로 새로 보이게 된 내용도 여기에 포함됩니다.
비밀번호·OTP·인증번호·보안코드·카드 번호 같은 민감한 입력값, CSS·스크립트 내용, 숨겨진
내용은 결과에 넣지 않습니다. 민감한 칸에 값이 들어 있는 동안에는 그 프레임과 같은 출처의
다른 프레임·창에서 `evaluate`와 `console`의 `expression`(페이지 코드 실행)을 거부하고,
사용자가 직접 조작 중인 창이 하나라도 있는 동안에도 거부합니다. 업로드할 파일은 이 PC의
드라이브 경로(`C:\…`)만 받으며, `\\서버\공유` 같은 네트워크 경로는 Windows 로그인 정보가
그 서버로 전송될 수 있어 파일에 접근하기 전에 거부합니다. 화면 이미지는 `screenshot:true`로
요청할 때만 붙습니다.
탭은 `t<n>`, iframe은 그 iframe 요소의 참조로 가리킵니다.
`status`·`list_tabs`·`create_session`·`list_sessions`·`close_session`·`requests`·`respond`·`permissions`·`downloads`·`revoke`와
개발자 도구 action은 짧은 JSON으로 답합니다.

개발자 도구 action은 브라우저 개발자 도구 화면을 조작하지 않고 페이지·iframe·워커의 콘솔 메시지·오류,
네트워크 요청(HTTP/HTTPS 상태·리다이렉트 체인·요청/응답 헤더·POST 본문·응답 본문·타이밍·TLS·서비스 워커·WebSocket 프레임),
요소의 계산된 스타일·적용된 CSS 규칙(소스 파일·줄 번호)·DOM 이벤트 리스너, 성능 지표를
짧은 JSON으로 돌려줍니다. Camoufox에서는 Juggler 파이프와 로컬 읽기 전용 Firefox DevTools RDP를
결합해 동작하며, Electron 폴백에서는 CDP로 동작합니다. 화면 캡처나 페이지 관측을 붙이지 않으므로 토큰을 적게 쓰며,
에이전트의 다른 동작이 진행 중이어도 바로 응답합니다. 쿠키·인증 헤더, 토큰·인증 코드가
담긴 URL 값, `Bearer` 인증 값, 요청·응답 본문의 비밀번호·토큰 항목처럼 이름이나 형태로
알아볼 수 있는 값은 `[redacted]`로 가립니다. 다만 이 가림은 최선 노력 방식이라, 알아보기
어려운 이름의 비밀 값이나 HTML 본문은 그대로 보일 수 있습니다. 쿠키·저장소 값을 읽는 API는
쓰지 않습니다. 기록은 페이지당 정해진 개수(콘솔 500개, 네트워크 1000개)까지만 유지합니다.
사용자가 직접 조작하는 동안 생긴 콘솔·네트워크 기록은 저장하지도 에이전트에게 보여주지도
않습니다. 같은 브라우저 세션의 창 하나라도 직접 조작 중이면, 여러 창이 함께 쓰는 서비스 워커의
기록도 모든 창에서 제외합니다.
`withheld`는 이런 개인정보 보호 경계로 제외된 이벤트의 누적 개수이며, `withheldReason`에
사유가 표시됩니다. 제어권을 돌려줘도 제외된 기록은 복원되지 않습니다. 오래된 기록이 버퍼에서
밀려난 `dropped`, 한 결과에서 생략된 `omitted`와는 구분됩니다.
`console`의 `expression`은 페이지 자체 JavaScript 전역 값을 읽는 기능입니다. 값을 바꾸는
코드는 거부하려고 하지만 완전한 보호 장치는 아니며, 결과는 페이지가 알려 주는 값입니다.
에이전트가 중지된 동안에는 실행하지 않으며, 2초를 넘기면 멈춥니다. 페이지 대화상자가
열려 있으면 이 읽기와 응답 본문·성능 읽기는 실행하지 않고 대화상자를 먼저 처리하라고 답합니다.
`evaluate`에 `world:"page"`를 지정했을 때만 페이지 JavaScript 환경에서 값을 바꾸는
코드를 실행합니다. 이때 페이지 스크립트가 실행과 결과를 관찰하거나 바꿀 수 있습니다.
중단점·단계 실행, 요청 가로채기·변조, 기기 에뮬레이션은 제공하지 않습니다.
일반 OS 파일 작업과 지원하지 않는 API의 대체 도구 선택은 에이전트가 판단합니다.
소스·테스트·임시 산출물 전체가 자동으로 MCP 도구나 스킬 내용으로 전달되지는 않습니다.

## 설치와 사용

[GitHub Releases](https://github.com/eerraa/mixdog-browser-use-extension/releases)에서
Windows x64 ZIP을 받아 압축을 풉니다. 공개된 SHA256 파일로 다운로드를 확인할 수 있습니다.

1. **배포된 플러그인 폴더**를 Mixdog의 로컬 플러그인 설정에 등록하고 MCP를 활성화합니다.
   소스 저장소 폴더가 아니라 `bin`, `runtime`, `app`, `skills`, `hooks`, `plugin.json`이
   함께 들어 있는, 패키저가 출력한 경로 끝의 `win-browser` 폴더를 등록합니다.
   고유 번호가 붙은 상위 폴더를 등록하거나 `win-browser` 이름을 바꾸면 안 됩니다.
   기본 패키지는 `browser-policy.json`에 명시된 자동화 위임을 포함합니다. 등록·활성화하면
   인증된 에이전트가 자신이 소유한 페이지에서 새 HID·USB 장치와 알림·위치 권한을
   선택할 수 있습니다. 요청마다 별도 사람 확인을 요구하는 패키지가 아닙니다.
2. 빌트인 Browser Use 비활성화와 필요한 앱 재시작은 사용자가 직접 진행합니다.
3. 새 대화에서 원하는 웹 작업을 평소처럼 요청합니다. 특정 도구명이나 스킬명을
   지시할 필요는 없습니다. 기본 MCP 이름과 플러그인 이름은 바꾸지 않습니다.

정상 등록 시 MCP 서버 이름은 `plugin-win-browser`여야 합니다. 별칭이나 중복 등록으로
다른 이름이 붙는 구성은 지원하지 않습니다. 비활성화된 이전 등록도 이름 충돌을
일으킬 수 있으므로, 충돌이 있으면 사용자가 지원되는 플러그인 설정에서 확인해야 합니다.
새 경로의 패키지를 등록하면 별도 플러그인 ID·데이터를 사용하며 기존 로그인·설정을
자동으로 이전하지 않습니다.

### Claude Code에 등록

Claude Code에서는 플러그인 마켓플레이스나 훅 없이, `win-browser` 폴더의 실행기를 일반 MCP
서버(stdio)로 등록합니다. 아래 "고정 경로와 업데이트"의 고정 경로를 한 번 등록해 두면 버전이
바뀌어도 다시 등록할 필요가 없습니다. 등록은 사용자 설정(`~/.claude.json`)을 바꾸므로 사용자가
직접 실행합니다(PowerShell 예시).

```powershell
claude mcp add --scope user win-browser -e WB_AUTHORITY=connection -e "WB_DATA_DIR=$env:LOCALAPPDATA\independent-windows-browser\claude-code" -- "C:\설치루트\win-browser\bin\bridge.exe" --mcp
```

- `WB_AUTHORITY=connection`: Claude Code는 세션마다 MCP 서버를 따로 띄우므로 그 연결 자체를
  호출자로 인증합니다. Mixdog 훅이 넣던 `_lease`는 쓰지 않으며, 인수로 보내면 아무것도 실행하지
  않고 거부합니다. 같은 세션의 하위 에이전트는 탭·프로필을 함께 쓰고, 다른 세션은 별도
  브라우저 프로세스·프로필을 씁니다.
- 세션 도중 서버가 다시 시작되거나 `/mcp`로 다시 연결되면 새 브라우저 연결로 시작하므로 이전
  탭 ID는 닫힙니다(`CLOSED_TAB`). 다만 기본 Camoufox 엔진에서는 `WB_DATA_DIR\profiles\camoufox-default`
  영구 기본 프로필을 잠금(`camoufox-default.lock`)으로 보호해 재사용하므로, 유휴 종료나 버전 업그레이드
  뒤에도 자체 프로필의 로그인 상태가 유지됩니다(다른 브라우저 프로필은 복사하지 않으며, 동시에 다른
  연결이 잠금을 사용 중이면 자동으로 격리된 임시 프로필 `ephemeral-busy`로 떨어지고, `WB_PERSISTENT_PROFILE=0`으로
  영구 프로필을 끌 수 있습니다). 도구 정의에는 연결마다 바뀌는 값이 없어 같은 세션에서 그대로 이어서 쓸 수 있습니다.
- `WB_DATA_DIR`: 연결별 Electron 데이터·프로필·다운로드를 둘 절대 경로입니다. Mixdog 데이터와
  섞이지 않으며 연결 키를 디스크에 쓰지 않습니다. 연결이 끝나도 프로필 폴더는 지우지 않습니다.
- 둘 중 하나라도 없거나 잘못되면 서버가 시작하지 않으며 `claude mcp get win-browser`에 실패로
  표시됩니다.
- 이미 실행 중인 세션에는 `/mcp`에서 다시 연결하거나 새 세션을 열어야 도구가 나타납니다.
  제거는 `claude mcp remove --scope user win-browser`입니다.
- 사용법은 스킬 대신 서버 지침으로 전달됩니다. 매 호출 권한 확인을 없애려면 사용자가 Claude Code
  권한 설정에서 `mcp__win-browser__browse`를 허용합니다.
- 기본 `browser-policy.json`의 HID·USB·알림·위치 위임은 Claude Code 등록에도 같게 적용됩니다.
  대화 턴 경계는 MCP 서버에 전달되지 않으므로 위임의 caller generation은 그 연결(세션)이
  끝날 때까지 하나로 유지됩니다.
- Codex·DSH 같은 다른 MCP 호스트도 같은 실행기(`bin\bridge.exe --mcp`)와 두 환경 변수로
  등록합니다.

### 고정 경로와 업데이트

MCP 호스트에는 버전마다 바뀌는 폴더 대신 고정 경로 하나만 등록합니다. 버전별 폴더는 나란히
두고, 고정 경로는 현재 버전을 가리키는 디렉터리 정션으로 둡니다.

```text
C:\설치루트\win-browser                               ← 호스트에 등록하는 경로(정션)
C:\설치루트\win-browser-versions\v<버전>\win-browser   ← 버전별 설치
C:\설치루트\win-browser-runtime\camoufox              ← 버전 간 공유 Camoufox 158 런타임(1회 배치)
```

- **엔진 선택 (`WB_ENGINE`) 및 이중 등록 권장 구성**: 기본 엔진은 `camoufox`(Firefox 158)입니다.
  일반 웹·로그인·영구 프로필과 WebHID·WebUSB 장치 작업(`usekb.cc` 등)을 모두 쓰는 MCP 호스트
  (Claude Code·Codex·Antigravity·DSH PTC)에서는 같은 `bin\bridge.exe --mcp`를 두 등록으로 나누어
  고정하는 구성을 권장합니다: `win-browser`(`WB_ENGINE=camoufox`)와 `win-browser-hid`(`WB_ENGINE=electron`,
  별도 `WB_DATA_DIR`). `win-browser-hid`는 연결 권한 모드에서 첫 실제 동작 전까지 Electron GUI
  프로세스를 띄우지 않고 지연 시작(`companionState: "not-started"`)하므로 평소 메모리를 차지하지
  않습니다. Camoufox 실행 파일은 `WB_CAMOUFOX_PATH` → 패키지 내부 `camoufox/` → 공유
  `<설치루트>\win-browser-runtime\camoufox` 순으로 찾습니다.
- **Camoufox 제어 툴바**: 웹페이지 DOM에는 아무것도 주입하지 않고, Camoufox 자체 주소창 툴바(`#nav-bar`)
  오른쪽에 다크/라이트 테마와 맞춘 프로필 배지(`default`·`work`·`personal` 등)와 1클릭 네이티브 제어 버튼(**직접 조작 / 에이전트에게 돌려주기 / 모두 반환 /
  중지 / 권한 상승 · 권한 해제 / 연결 종료**)을 직접 내장합니다. **연결 종료**(영문 `Disconnect`)는 이
  MCP 브라우저 연결의 모든 창을 닫고 연결을 끝내므로(다시 쓰려면 MCP 호스트에서 재연결 필요),
  창 하나만 닫으려면 일반 브라우저처럼 창 오른쪽 위의 **×** 버튼을 사용하세요(마지막 창을 ×로 닫아도
  연결은 유지되어 다음 `open` 때 새 창이 열립니다). 별도 떠다니는 창 없이 브라우저와 한 몸으로 움직이므로 창
  이동·크기 조절·DPI 배율 변경 시 지연이나 어긋남이 없으며, 창 높이(`outerHeight - innerHeight`) 변화도
  0px입니다. 상태 동기화와 버튼 클릭은 32바이트 랜덤 토큰으로 보호된 로컬 루프백(`127.0.0.1`) 스트림으로
  즉시 처리됩니다. Camoufox에서는 `window.prompt()`까지 네이티브로 지원하며, `WB_ENGINE=electron`에서는
  기존 툴바·보호막 UI와 Electron 44.9.1 제약을 따르고 첫 최상위 창 열기·`show` 호출 시 포커스를 뺏지
  않은 채 작업 표시줄 아이콘을 짧게 깜박여 창 위치를 알려 줍니다.

- 새 버전은 옆 폴더에 풀고 정션만 바꿉니다. 실행 중인 폴더는 덮어쓰지 않습니다.
- 이미 실행 중인 연결은 시작할 때의 버전을 끝까지 쓰고, 다음 연결(새 세션, `/mcp` 재연결,
  호스트 재시작)부터 새 버전을 씁니다. 실행 중인 버전은 `status` 결과의 `version`에 나옵니다.
- ZIP으로 받았다면 `C:\설치루트\win-browser-versions\v<버전>\`에 압축을 풀고 정션을 바꿉니다.
  `cmd /c rmdir "C:\설치루트\win-browser"`는 정션만 지우고 대상 폴더는 지우지 않습니다.
  그다음 `cmd /c mklink /J "C:\설치루트\win-browser" "C:\설치루트\win-browser-versions\v<버전>\win-browser"`를
  실행합니다.
- 소스 저장소에서는 `npm run install:local -- "C:\설치루트"`가 릴리즈 폴더를 파일별 SHA256으로
  확인해 설치하고 정션을 바꾼 뒤, 실행 중이 아닌 이전 버전 폴더를 지웁니다.
- Claude Code는 긴 MCP 결과를 줄이거나 파일로 넘기므로 큰 페이지는 `mode:"full"`보다
  `find`·`scope`로 읽습니다.

`list_profiles`로 기본 제공 영구 프로필(`default`, `work`, `personal`)과 이미 생성된 커스텀 영구 프로필의
사용 가능 여부(`available`·`in-use-here`·`in-use-other`)를 조회하고, `create_session { profile, name? }`로
원하는 영구 프로필을 열어 계정별 로그인을 디스크(`WB_DATA_DIR\profiles\camoufox-<프로필명>`)에 유지할 수 있습니다.
서로 다른 MCP 스레드가 각각 다른 영구 프로필(`default`와 `work` 등)을 열면 잠금 충돌 없이 동시에 로그인 상태를 유지합니다.
`profile`을 생략한 `create_session { name? }`은 기존과 같이 쿠키가 비어 있는 임시 세션을 만듭니다.
`sessionId`는 브라우저 저장소 선택용이며 호출자 인증 정보를 바꾸지 않습니다.

```javascript
browse({ action: "list_profiles" }); // default, work, personal 등 영구 프로필 목록과 잠금 상태 확인
browse({ action: "create_session", profile: "work", name: "업무 계정" }); // 영구 프로필 바인딩 (로그인 유지)
browse({ action: "create_session", name: "참조 계정" }); // profile 생략 시 빈 임시 세션
browse({ action: "open", sessionId: "ctx2", url: "https://example.com/" });
browse({ action: "list_sessions" });
browse({ action: "list_tabs" });
// 임시 세션은 데이터 정리, 영구 프로필 세션은 프로세스 종료·잠금 해제만 수행하고 디스크 로그인은 보존(storagePreserved:true)
browse({ action: "close_session", sessionId: "ctx2" });
```

`open`에서 `sessionId`를 생략하면 기존 기본 세션을 씁니다. 같은 세션의 탭들은 로그인을
공유하고, 서로 다른 세션의 쿠키·localStorage·IndexedDB·서비스 워커·Cache Storage·HTTP 캐시는
분리됩니다. 창 제목과 툴바, 탭 목록과 각 탭의 결과에 세션 이름과 ID가 표시됩니다.
임시 세션은 마지막 탭을 닫아도 연결 안에 남으며, `close_session`이나 연결 종료 시 저장소와
인증·캐시·연결을 정리합니다. 기본 세션은 `close_session`으로 종료할 수 없습니다. 내려받은
파일은 남고, 종료하는 세션의 진행 중인 다운로드만 취소됩니다. 정리 실패는
`cleanupComplete:false`와 `SESSION_CLEANUP_FAILED`로 알려 주며 그 세션은 다시 열 수 없습니다.
한 호출자가 연결 하나에서 만들 수 있는 임시 세션은 종료한 것을 포함해 16개이고, 열린 탭은
모든 세션을 합쳐 32개까지입니다. 사람이 중지하거나 직접 조작 중인 탭이 있으면 임시 세션
생성·새 탭 열기를 거부합니다. 해당 세션 안에 그런 탭이 있으면 종료도 거부하므로 먼저
사람이 창에서 재개·제어권 반환을 해야 합니다. 권한 거부 기록은 세션을 새로 만들어도 유지됩니다.

각 페이지는 일반 브라우저처럼 주소창, 뒤로·앞으로, 새로고침(로딩 중에는 중지)과
현재 제어 상태 표시가 있는 창 하나로 열리며, 창 제목에는 페이지 제목과 세션 이름·ID가 표시됩니다.
에이전트가 창을 열거나 조작해도 창이 포커스를 가져가지 않으므로, 다른 앱에서 치던 키가
브라우저 창으로 새지 않습니다. 에이전트가 사람에게 넘길 때(`handoff`)는 작업 표시줄에서
창이 깜박이기만 하며, 사용자가 창을 클릭해 이어서 조작합니다.
이 창은 Mixdog 사이드패널이 아닌 별도 창입니다. 현재 Mixdog 플러그인이 공식적으로
기여할 수 있는 항목은 skill·MCP 서버·hook이며, 플러그인 브라우저를 사이드패널에
넣는 공식 API는 없습니다.

에이전트가 조작하는 동안에는 페이지 위에 투명한 보호막이 덮여 있어 사용자의 클릭과
키 입력이 페이지에 전달되지 않고, 주소창과 이동 버튼도 잠깁니다. 페이지를 클릭하거나
툴바의 **직접 조작**(Take control)을 누르면, 진행 중인 자동 입력이 안전하게 끝나고
누르고 있던 마우스 버튼·키를 놓을 때까지 기다린 뒤 **같은 페이지**의 제어권을
사용자에게 넘깁니다. 전환을 시작한 첫 조작은 페이지에 전달하지 않으므로 전환된 다음
다시 조작합니다. 스크롤 휠로는 전환을 확정할 수 없으므로 툴바의 **직접 조작**을 누릅니다.

날짜·색상·목록 선택 창은 보호막 밖에 따로 뜹니다. 자동화 중에 그 창에서 값을 고르면 고른 값은
페이지에 들어가지만, 자동화는 안전을 위해 일시정지됩니다(`unexpected-page-input`). 툴바의
**에이전트 재개**(Resume agent)를 누르면 에이전트가 페이지를 다시 확인한 뒤 이어서 작업합니다.

직접 조작 중에는 주소창과 뒤로·앞으로·새로고침을 쓸 수 있습니다. 주소창은 http(s)
주소만 열며, `example.com`처럼 입력하면 https로(`localhost`는 http로) 엽니다.
로그인·비밀번호·CAPTCHA·2FA도 이 창에서 직접 처리합니다. 이 동안 에이전트의 페이지
읽기·캡처와 입력은 차단되고, 그 사이에 열린 페이지 주소·대화상자·팝업·다운로드도 에이전트에게
알리지 않습니다. 로그인은 제출까지 마친 뒤 돌려주세요. 직접 입력한 칸은 돌려준 뒤에도
민감한 칸으로 취급되어 값이 에이전트에게 보이지 않습니다. 끝나면 툴바의 **에이전트에게 돌려주기**(Return to agent)나
네이티브 메뉴의 `Resume automation`을 선택합니다. 에이전트는 페이지를 다시 확인한 뒤
이어서 작업하며, 에이전트나 도구가 제어권을 스스로 되찾을 수는 없습니다.

반환·재개에 실패하면 **반환 실패**와 **반환 재시도** 버튼을 표시합니다. 대기 시간은
진행 중 작업 정리를 포함해 최대 25초이며, `list_tabs`의 `returnFailure`에 시도 번호·실패
단계(`stage`)·코드(`code`)가 남습니다. 표시된 `null` 주소·제목은 개인정보 보호로 가린 값입니다.
`CONTROLS_HELD`면 누르고 있는 키·버튼을 놓은 뒤 같은 창에서 다시 반환합니다. 해제 이벤트는
페이지와 툴바·보호막에서 확인하며, 창의 포커스가 바뀌었다는 이유로 해제됐다고 추정하지 않습니다.
다른 창이나 메뉴에서 키를 놓아 해제 기록이 남지 않았다면, 사람이 반환할 때 Windows에서
실제 키·버튼이 모두 해제됐는지 확인해 오래된 기록을 정리합니다. 해당 브라우저 창이 전경이고
활성 데스크톱과 접근 권한을 확인할 수 있을 때만 적용하며, 키 이름·입력 내용은 수집하지 않습니다.
실제로 누른 키가 있거나 확인할 수 없는 상태면 계속 차단합니다.
그 외 실패는 보호막과 일시정지를 유지합니다. **직접 조작**으로 같은 페이지를 계속 쓰거나,
원인을 해소한 뒤 사람이 **반환 재시도**를 누릅니다. 이미 실행했거나 결과가 불확실한 입력은
반복하지 않습니다. 반환 도중 누른 **에이전트 중지**도 유지되며, 다른 세션의 로그인·탭에는
영향을 주지 않습니다.

직접 조작 중에는 창 메뉴(Alt)의 `Open DevTools (while you have control)`로 그 페이지의
개발자 도구를 별도 창으로 열 수 있습니다. 에이전트가 조작하는 동안에는 열리지 않으며,
제어권을 돌려주면 에이전트가 페이지를 다시 확인하기 전에 자동으로 닫힙니다.
제어권 전환 뒤 이전 iframe·요소 참조로 `STALE_REF`가 나오면 같은 탭을 다시 관찰해 새 참조를
사용합니다. 이 오류에는 갱신 안내가 붙으며, 이미 실행했거나 결과가 불확실한 입력을 반복하는
근거로 사용하지 않습니다.

툴바의 **에이전트 중지**(Stop agent)나 `Stop automation`은 해당 페이지의 자동화를
중단합니다. 자동화 중에 창을 최소화해도 안전을 위해 일시정지됩니다. 어느 경우든
창을 숨기거나 다시 보여주는 것만으로는 해제되지 않으며, 사용자가 툴바의
**에이전트 재개**(Resume agent)나 `Resume automation`을 선택해야 다시 시작합니다.

### 권한 상승 전체 자동화 모드 (`elevated`, 명시적 옵트인)

기본 실행 모드는 `standard`입니다. `standard` 모드에서는 비밀번호·OTP·인증번호·카드 칸처럼
민감한 입력 칸에 에이전트가 비어 있지 않은 값을 `fill`·`type`하려 하면 `SENSITIVE_INPUT_REFUSED`로
거부되며, 사람이 `handoff`로 직접 로그인합니다(기존 값을 지우는 빈 `fill { text: "" }`만 허용).

사용자가 로그인·비밀번호·OTP 입력까지 에이전트 자동화에 명시적으로 맡기려는 경우에만
호스트 설정이나 정책 파일로 `elevated` 모드를 켤 수 있습니다. 에이전트가 MCP 인수로 이 모드를
켜거나 바꿀 수는 없으며, 허용되지 않은 값(`standard`·`elevated` 외)을 주면 서버가 시작 시
실패합니다.

- **환경 변수로 옵트인**: MCP 서버 등록에 `WB_AUTOMATION_MODE=elevated`를 추가합니다(가장 높은 우선순위; `WB_AUTOMATION_MODE=standard`로 고정하면 아래 저장 설정보다 우선합니다).
- **정책 파일로 옵트인**: 등록 전 `browser-policy.json`에 `"automationMode": "elevated"`를 추가합니다(`disabled`·`manual`·`delegated` 정책 모두에 선택 필드로 지정 가능; 배포 기본 파일에는 들어 있지 않습니다).
- **브라우저 `#nav-bar` 1클릭 영구 저장 (권장, 호스트 설정 편집 불필요)**: 환경 변수나 정책으로 고정되지 않은 연결에서는 Camoufox `#nav-bar`의 **`[권한 상승]`** 버튼을 사람이 직접 클릭해 즉시 전환하고 `WB_DATA_DIR\user-preferences.json`에 저장할 수 있습니다. 이후 버전 업그레이드나 같은 `WB_DATA_DIR`를 쓰는 다른 호스트 연결에서도 `elevated`가 계속 유지되며, **`[권한 해제]`** 를 누르면 해당 연결은 즉시 단방향으로 `standard`로 내려가고 저장 설정도 `standard`로 되돌아갑니다. (에이전트가 MCP 인수나 스크립트로 이 설정을 올릴 수는 없으며, `user-preferences.json`과 프로필 파일은 웹 업로드에서도 자동 차단됩니다.)

권한 상승 모드가 활성화된 동안의 동작과 안전 장치는 다음과 같습니다.

- **명확한 상태 표시**: 모든 창 제목에 `[권한 상승]`(`[Elevated]`)이 붙고, 툴바에 주황색
  **권한 상승 · 해제**(`Elevated · Revert`) 버튼이 표시되며, 보호막에도 주황색 테두리와 상태 문구가
  표시됩니다. `status`와 `list_tabs` JSON 응답에도 `automationMode: "elevated"`가 노출됩니다.
- **허용되는 작업**: 민감한 로그인·비밀번호·OTP 칸에 대한 `fill`·`type`·`click`·`observe`가 자동
  `PRIVATE_HANDOFF` 없이 동작합니다. 또한 자동화가 정상 실행 중이고 보호막이 덮여 있는 동안에는
  보호막 위 실수 클릭·키 입력으로 자동 인계(`shell-pointer-intervention`·`shell-keyboard-intervention`)가
  발동하지 않습니다.
- **유지되는 보호 장치**:
  - 민감한 칸의 값은 스냅샷·diff·`read`·`find`·DevTools·`run` 보고서에서 계속 가려지며, 민감한 값이
    들어 있는 동안 `evaluate`와 `console(expression)`도 계속 `SENSITIVE_PRESENT`로 거부됩니다.
    (단, 호출자가 `fill.text`나 `run.script` 인수로 직접 전달한 문자열이나 `screenshot:true` 화면
    픽셀 자체까지 끝단 간 암호화·은닉하는 경계는 아닙니다.)
  - 보호막 밖 네이티브 선택창(날짜·색상·`select`·`datalist`) 조작 시 `unexpected-page-input` 안전
    정지와 모든 fail-closed 보호는 그대로 유지됩니다.
  - CAPTCHA나 사람 확인이 필요한 단계는 기존과 동일하게 수동 `handoff`와 반환 절차로 처리합니다.
- **즉시 단방향 해제**: 툴바의 **권한 상승 · 해제** 버튼이나 창 메뉴(Alt)의
  `Revert connection to standard mode`를 선택하면 해당 MCP 연결의 모든 탭·팝업·대기 작업과 실행 중인
  `run` 스크립트의 다음 단계가 즉시 `standard` 모드로 내려갑니다. 이미 활성화된 Stop이나 직접 조작
  상태는 그대로 유지되며, 같은 연결 안에서는 다시 `elevated`로 올릴 수 없습니다.

## 권한과 안전 경계

- 자체 프로필만 사용하며 다른 브라우저나 Mixdog의 쿠키·계정·프로필을 복사하지 않습니다.
- 웹페이지에는 실제 내장 Chromium 버전의 브라우저 식별 값을 사용합니다.
  Electron 앱 전용 연동으로 잘못 분류되는 것을 막으며 장치 권한·Windows 승인은 바꾸지 않습니다.
  이 기본값은 플러그인 전용 실행기 안에만 적용되며 Mixdog 본체와 다른 브라우저는 변경하지 않습니다.
- 사이트 버튼 클릭, HTML 파일 입력의 파일 선택, JS 대화상자, HID·USB와 알림·위치 요청을 하나의
  `requests`/`respond` 인터페이스로 처리합니다. 실제 브라우저 이벤트에서 나온 요청과
  선택지만 사용할 수 있으며, 장치를 이름이나 첫 번째 항목만 보고 임의 선택하지 않습니다.
  파일 선택은 해당 사이트에 파일 내용을 공개하므로 작업에 필요한 명시적 파일만 전달합니다.
- 기본 정책은 특정 사이트를 미리 승인하는 대신 현재 연결의 인증된 caller generation에
  origin과 실제 제공된 선택지를 고르는 권한을 위임합니다. 장치 연결·읽기·설정 쓰기는
  서로 다른 결과이며, 이 위임이 장치 프로토콜의 쓰기를 기술적으로 차단하지는 않습니다.
  Chromium의 기존 장치 허가는 origin/session 수명이며 문서별 독점 접근을 보장하지 않습니다.
- 정책은 고정된 패키지 경로에서 연결 시작에 한 번 검증하고 다시 읽지 않습니다.
  누락·오류·비활성 정책은 새 자동 허가를 차단하며, 에이전트가 MCP 인수로 정책이나 승인을
  만들 수 없습니다. 사용자는 등록 전에 `{"version":1,"mode":"disabled"}` 또는
  `{"version":1,"mode":"manual"}`로 바꿀 수 있습니다. manual 모드의 알림·위치 Windows
  사용자 확인은 Windows 11 build 22000 이상을 대상으로 합니다.
- Stop·인계·복귀 시작·창 숨김·연결 단절·탐색·호출자 종료·만료는 대기 중 요청을 철회하며,
  이를 사람의 거부로 기록하지 않습니다. 명시적 거부·취소는 재요청으로 우회하지 않습니다.
  인계된 기존 페이지는 여전히 사용자가 그 창의 툴바나 `Resume automation` 메뉴로 돌려줄 때만 돌아옵니다.
- 권한 회수는 이 MCP 연결의 모든 브라우저 창과 실행기를 종료합니다.
  열린 페이지와 미저장 입력은 닫히며 프로필 파일은 삭제하지 않습니다.
  프로세스 종료 확인과 실물 장치 입출력 검증은 구분해서 표시합니다.
- 요청자와 범위를 확실히 확인할 수 없는 권한 API는 이유와 함께 거부합니다.
  OS 승인, 사용자 활성화와 Chromium의 보안 정책·장치 차단 목록을 해제하지 않습니다.
- 훅은 이 플러그인 도구의 호출만 변경합니다. 다른 도구나 전역 세션을 차단하지 않습니다.
  훅 종료 알림은 호스트의 best-effort 계약이므로 놓친 종료·이벤트 순서를
  완전히 관측한다고 보장하지 않습니다.
- 로컬 훅 자격정보는 웹페이지와 일반 MCP 인수에서 분리됩니다. 그러나 같은 OS 사용자
  권한으로 플러그인 파일·프로세스를 바꾸거나 훅을 위조하는 프로그램을 격리하는
  샌드박스는 아닙니다. 패키지 등록은 암호학적 동의 영수증이 아니며, 같은 사용자 권한의
  로컬 코드 변조를 막지 못합니다. 자동화는 native 요청 adapter를 사용하며 승인창을 조작하지 않습니다.

일부 회전·왜곡 프레임과 실제 wheel 이벤트가 필요한 위젯은 지원하지 않습니다.
JS `alert`·`confirm`은 자동 응답합니다. Electron 44.9.1의 `window.prompt()`는
대화상자 생성 전에 `prompt() is not supported.` 오류를 내므로 지원하지 않습니다.
그 기능이 필요한 앱은 검증 완료가 아니라 runtime capability blocker로 보고합니다.
`alert`·`confirm`의 중복 native UI 방지는 전용 companion 안의 공개 `dialog.showMessageBox`
함수를 감싸 실제 CDP 이벤트와 연결하는 Electron 44.9.1 호환성 처리입니다.
공식 dialog interception 확장 API는 아니므로 runtime 버전 변경 시 재검증이 필요합니다.
설치된 Electron·Mixdog 파일이나 페이지 스크립트를 패치하지 않습니다.
파일 선택 자동 응답은 DOM에 묶인 HTML 파일 입력만 지원합니다.
File System Access API의 `showOpenFilePicker`·`showSaveFilePicker`·`showDirectoryPicker`와
일반 OS 파일 작업은 이 도구의 지원 범위가 아닙니다.
플러그인은 다른 도구를 자동 호출하지 않으며, 추가 도구 선택과 작업을 이어갈 방법은
에이전트가 판단합니다. Stop·거부·불확실한 입력의 비재실행 원칙은 그대로 유지합니다.
실제 한국어 IME·비밀 입력·Windows 승인·실물 HID/USB 입출력은 단위 테스트나
로컬 페이지 테스트만으로 검증됐다고 간주하지 않습니다.

## 소스에서 개발하는 경우

이 절은 개발자용이며 배포 폴더를 등록하는 사용자에게는 필요하지 않습니다.

소스 구조, 빌드·테스트·패키징·릴리즈 절차와 유지보수 규칙은 저장소 루트의
`AGENTS.md`에서 시작하는 `docs/agents/` 문서를 기준으로 합니다.
이 문서들은 배포 폴더에 포함되지 않습니다.

Mixdog에서 가져온 코드는 Mixdog 1.3.4(`968ee089`)에서 분기한 독자 코드이며, 이후
원본 변경은 따라가지 않습니다. 분기 시점, 라이선스와 변경 범위는 `THIRD_PARTY_NOTICES.md`와
`third_party/mixdog/`에 있습니다.
