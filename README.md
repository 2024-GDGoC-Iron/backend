# backend

## 서비스 소개
### AWS 서버리스로 백엔드를 처리했습니다.
다음 세 코드는 람다함수입니닷~!

## DB 모델
1. ConnectionTable:

```json

{
  "connectionId": "string (PK)",
  "userId": "string",
  "timestamp": "number",
  "sessionId": "string"
}

```

1. ChatLogTable:

```json

{
  "sessionId": "string (PK)",
  "timestamp": "number (SK)",
  "userId": "string",
  "message": "string",
  "sender": "string (user/ai)",
  "isComplete": "boolean"
}

```
