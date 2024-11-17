# backend

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
