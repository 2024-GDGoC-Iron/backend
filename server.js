const express = require("express")
const dotenv = require('dotenv').config();

const app = express() 
const port = process.env.PORT

app.use(express.json())

// 테스트 라우트
app.get('/', (req, res) => {
    res.send('Hello, World!');
});

app.listen(port, () => {
    console.log(`${port}번에서 HTTP Web Server 실행`)
})