# codesh

사내망(폐쇄망) 환경을 위한 실시간 협업 코드 공유 서비스입니다.

외부 인터넷 연결 없이 사내망 안에서 실시간 코드 공유와 협업 편집을 수행할 수 있도록 설계된 독립형 시스템입니다. 배너 광고와 외부 추적 스크립트 없이 모든 기능을 제공하며, 충돌 없는 실시간 동시 편집과 사내망 환경에 맞춘 직관적인 공유 방식을 지원합니다.

## 안내서 바로가기

- [사용자 안내서 (USER-GUIDE.md)](docs/USER-GUIDE.md): 공유 시작, 입장, 동시 편집, 권한 제어, 실습실 모드, 단축키 및 문제 해결
- [운영자 안내서 (OPERATIONS.md)](docs/OPERATIONS.md): 요구사항, 오프라인 번들 설치, 환경 변수, TLS, 복제본 확장, 백업 및 복원, 모니터링, CLI
- [아키텍처 규약 (ARCHITECTURE.md)](docs/ARCHITECTURE.md): 시스템 토폴로지, 패키지 구성, 동기화 및 데이터 모델 명세
- [개발 계획 (PLAN.md)](docs/PLAN.md): 개발 마일스톤 및 기능 명세

## 주요 특징

- **완전한 사내망 독립 구동**: 외부 CDN, 상용 웹 폰트, 분석 도구 등 런타임 외부 네트워크 의존성이 전혀 없습니다.
- **충돌 없는 실시간 동시 편집**: CRDT(Yjs) 및 Hocuspocus 기반 동기화로 다중 사용자 동시 편집 시 충돌 없이 안전하게 병합됩니다.
- **편리한 사내 공유**: 6자리 숫자 참여 코드, 브라우저 자체 생성 QR 코드, 서브넷 및 방 기반 근처 공유, 접속자 직접 전송 및 방 전체 띄우기를 지원합니다.
- **사내 보안 및 권한 제어**: 보기 전용 링크, scrypt 기반 PIN 잠금, 대기실 입장 승인, 강퇴 및 차단 기능을 제공합니다.
- **삭제된 텍스트 보호**: 참여자는 현재 시점의 문서 상태만 수신합니다. 삭제된 텍스트 이력은 다른 참여자에게 전송되지 않으며 소유자만 확인할 수 있습니다.
- **강사용 실습실 모드**: 강사가 수강생 전원의 작업 상태를 실시간 격자로 확인하고 예제를 일괄 배포할 수 있습니다.
- **터미널 CLI 도구**: `codesh push`, `codesh open`, `codesh pull` 명령어로 터미널에서 즉시 코드를 공유하고 내려받을 수 있습니다.

## 기술 구성

| 영역 | 선택 | 역할 및 특징 |
|---|---|---|
| 저장소 구조 | pnpm workspaces + Turborepo | 모노레포 구조로 웹, 서버, 공용 라이브러리 일괄 관리 |
| 언어 | TypeScript 7 (strict) 전 구간 | 클라이언트와 서버 간 일관된 정적 타입 검증 |
| 웹 애플리케이션 | React 19 + Vite 8 + TanStack Router/Query | 반응형 SPA, 서버 상태 관리 및 클라이언트 라우팅 |
| 에디터 | CodeMirror 6 + Lezer | 모바일 지원, 100개 이상 언어 문법 강조, Vim/Emacs/Sublime 키맵 |
| 실시간 동기화 | Yjs + Hocuspocus 4 | CRDT 동시 편집, 다중 커서(Awareness), IndexedDB 오프라인 보관 |
| API 서버 | Fastify 5 | 고성능 HTTP API, Zod 기반 스키마 검증, SSE 이벤트 스트림 |
| 데이터베이스 | MongoDB 8 (공식 드라이버) | 문서 상태 저장, TTL 인덱스 자동 만료, GridFS 대용량 파일 저장 |
| 캐시/메시징 | Valkey 8 (BSD 라이선스) | 인스턴스 간 Pub/Sub, 접속자 상태, 참여 코드 관리, 속도 제한 |
| 에지 프록시 | Caddy 2 | 정적 자산 서빙, API/SSE 프록시, Collab 문서 단위 로드밸런싱 |
| UI / 스타일 | Tailwind CSS v4 + Radix UI | 접근성(WCAG 2.2 AA) 준수 및 자체 디자인 시스템 |
| 글꼴 | Pretendard, JetBrains Mono | 한글 가독성 지원 및 자체 호스팅 (외부 CDN 배제) |
| 테스트 | Vitest, Playwright, Node 부하 테스트 | 단위 테스트, 브라우저 e2e 테스트, 대규모 동시성 부하 테스트 |
| 배포 | Docker Compose, 오프라인 번들 | 단일 호스트 실행 및 폐쇄망용 오프라인 압축 번들 배포 |

## 개발자 빠른 시작 (Quick Start)

### 사전 요구사항
- Node.js 22 이상
- pnpm 9.15 이상
- Docker 및 Docker Compose

### 실행 단계

```sh
# 1. 의존성 설치
pnpm install

# 2. 로컬 개발용 인프라(MongoDB 8, Valkey 8) 실행
pnpm services:up

# 3. 개발 서버 실행 (웹: 5173, API: 3001, Collab: 3002)
pnpm dev

# 4. 전체 검사 (Biome 린트/포맷, TypeScript 타입체크, 단위 테스트, 라이선스 검증)
pnpm check

# 5. E2E 테스트 실행 (Playwright)
pnpm test:e2e

# 6. 인프라 종료
pnpm services:down
```

클라우드 개발 박스(instabox)를 사용하는 경우 `scripts/box <command>`를 통해 동일한 명령어를 원격 박스에서 실행할 수 있습니다.

## 의존성 및 라이선스 정책

codesh는 사내망 환경에서의 자유로운 사용과 배포를 위해 허용 라이선스 정책을 준수합니다.

- **허용 라이선스**: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, OFL-1.1 (글꼴), Python-2.0 (도구 한정), CC-BY-4.0 (데이터 한정).
- **MPL-2.0**: 수정 없이 사용되는 빌드 타임 개발 도구(`lightningcss`)에 한해 허용되며, 프로덕션 런타임 의존성에는 포함되지 않습니다.
- **Valkey 사용**: Redis 7.4 이상의 라이선스 변경에 대응하여 완전한 오픈소스인 Valkey 8(BSD-3-Clause)을 메시징 및 캐시 레이어로 사용합니다.
- **MongoDB Community Server**: 내부 데이터베이스 컨테이너로만 구동되며 소스코드 저장소에 직접 재배포되지 않습니다. 사용하는 클라이언트 드라이버(`mongodb`)는 Apache-2.0 라이선스입니다.
- **부하 테스트 스크립트**: AGPL 라이선스를 가진 k6 대신 Node.js 기반 자체 부하 테스트 스크립트(`scripts/load`)를 사용합니다.
- `pnpm check` 실행 시 `scripts/check-licenses.mjs`가 전체 의존성의 라이선스를 자동으로 검증합니다.
