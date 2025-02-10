const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = 3000;

// Body-parser 설정
app.use(bodyParser.urlencoded({ extended: true }));

// EJS 템플릿 엔진 사용
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// SQLite 데이터베이스 초기화 (예제에서는 메모리 DB 사용)
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
    // 직원 테이블 생성
    db.run(`
      CREATE TABLE IF NOT EXISTS employees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
      )
    `);

    // 출석 기록 테이블 생성
    db.run(`
      CREATE TABLE IF NOT EXISTS attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_name TEXT NOT NULL,
          check_in_time TEXT NOT NULL
      )
    `);

    // 예시 직원 데이터 삽입
    const stmt = db.prepare("INSERT INTO employees (name) VALUES (?)");
    ["Alice", "Bob", "Charlie", "Diana"].forEach(name => {
        stmt.run(name);
    });
    stmt.finalize();
});

// 체크인 페이지: 직원 이름 선택 폼 제공
app.get('/', (req, res) => {
    const currentDate = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).slice(0,10);
    db.all("SELECT * FROM employees WHERE name NOT IN (SELECT employee_name FROM attendance WHERE check_in_time LIKE ?)", [currentDate + '%'], (err, rows) => {
        if (err) {
            res.status(500).send("Database error");
        } else {
            const currentDateTime = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
            res.render('checkin', { employees: rows, currentDateTime });
        }
    });
});

// 체크인 요청 처리: 폼 제출 후 출석 체크 기록
app.post('/checkin', (req, res) => {
    const employeeName = req.body.employee;
    // 변경: toLocaleString을 사용해 베이징 시간 ("Asia/Shanghai")으로 생성
    const checkInTime = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
    
    db.run("INSERT INTO attendance (employee_name, check_in_time) VALUES (?, ?)", [employeeName, checkInTime], function(err) {
        if (err) {
            res.status(500).json({ success: false, message: "Database error" });
        } else {
            res.json({ success: true, message: "Check-in completed!" });
        }
    });
});

// 로그 페이지: 모든 출석 체크 기록 표시
app.get('/log', (req, res) => {
    const currentDate = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).slice(0,10);
    db.all("SELECT * FROM attendance ORDER BY check_in_time DESC", (err, rows) => {
        if (err) {
            res.status(500).send("데이터베이스 오류");
        } else {
            // 그룹화: 날짜별로 07:30 이전/이후 분리
            const groupedLogs = rows.reduce((acc, row) => {
                const date = row.check_in_time.slice(0, 10);
                if (!acc[date]) {
                    acc[date] = { before730: [], after730: [] };
                }
                const timePart = row.check_in_time.slice(11, 16);
                if (timePart > "07:30") {
                    acc[date].after730.push(row);
                } else {
                    acc[date].before730.push(row);
                }
                return acc;
            }, {});
            // 누적 지각 카운트 계산
            const lateCounts = {};
            rows.forEach(row => {
                const timePart = row.check_in_time.slice(11, 16);
                if (timePart > "07:30") {
                    lateCounts[row.employee_name] = (lateCounts[row.employee_name] || 0) + 1;
                }
            });
            // 조회: 오늘 미 체크인 직원
            db.all("SELECT * FROM employees WHERE name NOT IN (SELECT employee_name FROM attendance WHERE check_in_time LIKE ?)", [currentDate + '%'], (err2, notChecked) => {
                if (err2) {
                    res.status(500).send("데이터베이스 오류");
                } else {
                    res.render('log', { groupedLogs, notChecked, lateCounts });
                }
            });
        }
    });
});

app.listen(port, () => {
    console.log(`Attendance app listening on port ${port}`);
});
