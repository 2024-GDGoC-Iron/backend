const express = require("express")
const dotenv = require('dotenv').config();
const app = express() 
const port = process.env.PORT

app.use(express.json())

// 테스트 라우트
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html'); // __dirname을 사용해 현재 경로를 기반으로 파일을 제공
});

app.listen(port, () => {
    console.log(`${port}번에서 HTTP Web Server 실행`)
})