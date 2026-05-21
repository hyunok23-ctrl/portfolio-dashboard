# 📊 내 포트폴리오 대시보드

카카오페이증권 보유종목을 직접 입력하고, 네이버증권 시세로 실시간(5분) 모니터링하는 웹 대시보드입니다.

## 기능
- 종목명 검색 후 수량/평균단가 입력
- 종목별 원금 / 평가금액 / 손익 / 수익률 표시
- 전체 포트폴리오 합계 요약
- 종목별 비중 도넛 차트
- 장중 5분마다 자동 시세 갱신
- 데이터는 브라우저 로컬스토리지에 저장 (앱 종료해도 유지)

## 로컬 실행

```bash
npm install
npm start
```

## Vercel 배포

### 방법 1: CLI
```bash
npm install -g vercel
vercel
```

### 방법 2: GitHub 연동 (추천)
1. 이 폴더를 GitHub 레포에 push
2. [vercel.com](https://vercel.com) → New Project → GitHub 레포 선택
3. Framework: **Create React App** 선택
4. Deploy 클릭 → 완료!

### 방법 3: Netlify
```bash
npm run build
# build 폴더를 netlify.com에 드래그 앤 드롭
```

## 구조

```
portfolio-dashboard/
├── api/
│   ├── price.js      ← 네이버증권 시세 조회 (Vercel Serverless)
│   └── search.js     ← 종목명 검색 (Vercel Serverless)
├── public/
│   └── index.html
├── src/
│   ├── App.js        ← 메인 대시보드 컴포넌트
│   ├── App.css       ← 스타일
│   └── index.js
├── vercel.json
└── package.json
```

## 주의사항
- 네이버증권 비공식 API 사용 → 안정적이나 구조 변경 시 수정 필요
- 장 마감 후에는 직전 종가가 표시됩니다
- 보유 종목 데이터는 로컬스토리지에만 저장 (서버 전송 없음, 보안 안전)
