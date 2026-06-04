const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json());

// ─── 🔑 管理者專屬：司機帳號密碼名冊 ───
const driverRegistry = {
    'ABC-1234': { name: '司機01', phone: '0912345678' },
    'XYZ-5678': { name: '司機02', phone: '0987654321' },
    'TAXI-999': { name: '司機03', phone: '0900111222' }
};

let activeDrivers = {}; 
let driverSchedules = {}; 

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))); 
}

function estimateAddress(lat, lng) {
    return "經緯度 (" + lat.toFixed(4) + ", " + lng.toFixed(4) + ") 附近位置";
}

function calculateETA(distanceInKm) {
    const averageSpeedKmh = 35; 
    let durationMinutes = (distanceInKm / averageSpeedKmh) * 60;
    durationMinutes += (distanceInKm * 1.5); 
    if (durationMinutes < 3) durationMinutes = 3; 
    return Math.round(durationMinutes);
}

// ─── 🚨 管理者網頁 ───
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>管理者派車後台</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; background:#f4f6f9;">
            <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,0.05);">
                <h2>🚨 管理者發送派單</h2>
                
                <label><b>1. 訂單類型:</b></label>
                <select id="orderType" style="width:100%; padding:10px; margin-bottom:15px; font-size:15px;" onchange="toggleTimeInput()">
                    <option value="即時單">⚡ 即時派單 (立刻用車)</option>
                    <option value="預約單">📅 預約派單 (指定時間)</option>
                </select>

                <div id="bookingTimeDiv" style="display:none; margin-bottom:15px; background:#e9ecef; padding:10px; border-radius:5px;">
                    <label><b>預約用車時間:</b></label><br>
                    <input type="datetime-local" id="bookingTime" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px;">
                </div>

                <label><b>2. 上車地址 (文字門牌)：</b></label>
                <input type="text" id="addr" value="桃園市桃園區中正路1號" style="width:100%; padding:8px; box-sizing:border-box; margin-bottom:10px;"><br>
                
                <div style="display:flex; gap:10px; margin-bottom:15px;">
                    <div style="flex:1;">
                        <label>緯度 (供大腦計算距離用)：</label>
                        <input type="number" id="lat" value="24.9936" step="0.0001" style="width:100%; padding:8px; box-sizing:border-box;">
                    </div>
                    <div style="flex:1;">
                        <label>經度 (供大腦計算距離用)：</label>
                        <input type="number" id="lng" value="121.3130" step="0.0001" style="width:100%; padding:8px; box-sizing:border-box;">
                    </div>
                </div>

                <label><b>3. 本單目標通知司機人數:</b></label>
                <select id="driverCount" style="width:100%; padding:10px; margin-bottom:20px; font-size:15px;">
                    <option value="1">通知最近的 1 位司機</option>
                    <option value="2" selected>通知最近的 2 位司機 (預設)</option>
                    <option value="3">通知最近的 3 位司機</option>
                    <option value="4">通知最近的 4 位司機</option>
                    <option value="5">通知最近的 5 位司機</option>
                </select>

                <button onclick="sendOrder()" style="width:100%; padding:14px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px; cursor:pointer;">發送派單單據</button>
            </div>

            <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,0.05); margin-top:20px;">
                <h3 style="margin-top:0;">📡 派單動態監聽（含司機位置與ETA回傳）：</h3>
                <div id="log" style="background:#eee; padding:15px; min-height:120px; border-radius:5px; font-family:monospace; line-height:1.5; font-size:14px; white-space:pre-wrap;">等待派單...</div>
            </div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io({ transports: ['polling', 'websocket'] });
                
                function toggleTimeInput() {
                    const type = document.getElementById('orderType').value;
                    document.getElementById('bookingTimeDiv').style.display = (type === '預約單') ? 'block' : 'none';
                }

                function sendOrder() {
                    const type = document.getElementById('orderType').value;
                    let bTime = "無 (即時單)";
                    if(type === "預約單") {
                        const rawTime = document.getElementById('bookingTime').value;
                        if(!rawTime) { alert("請選擇預約時間！"); return; }
                        bTime = rawTime.replace('T', ' ');
                    }

                    fetch('/api/dispatch', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            targetAddress: document.getElementById('addr').value,
                            targetLat: parseFloat(document.getElementById('lat').value),
                            targetLng: parseFloat(document.getElementById('lng').value),
                            limitCount: parseInt(document.getElementById('driverCount').value),
                            orderType: type,
                            bookingTime: bTime
                        })
                    });
                }

                socket.on('admin_notification', (data) => {
                    const logDiv = document.getElementById('log');
                    let color = "black";
                    if(data.status === "SUCCESS") color = "green";
                    if(data.status === "FAILED" || data.status === "TIMEOUT") color = "red";
                    if(data.status === "REPLY") color = "#0056b3";

                    logDiv.innerHTML += '<br><span style="color:' + color + '; font-weight:bold;">[' + data.status + '] ' + data.message + '</span>';
                });
            </script>
        </body>
        </html>
    `);
});

// ─── 🚖 司機端網頁 ───
app.get('/driver', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>司機端系統</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; text-align:center; background:#fafafa;">
            <h2>🚖 司機工作台系統</h2>
            
            <div id="loginSection" style="background:white; padding:20px; border-radius:10px; border:1px solid #eee; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.02);">
                <h3 style="margin-top:0;">🔐 司機身分驗證</h3>
                <div style="margin:10px 0; text-align:left;">
                    <label><b>車牌號碼 (帳號):</b></label>
                    <input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px; font-size:16px;">
                </div>
                <div style="margin:15px 0; text-align:left;">
                    <label><b>手機號碼 (密碼):</b></label>
                    <input type="password" id="phoneNum" placeholder="請輸入您的電話號碼" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px; font-size:16px;">
                </div>
                <button id="toggleBtn" onclick="toggleStatus()" style="padding:12px; font-size:16px; font-weight:bold; background:green; color:white; border:none; border-radius:5px; width:100%; margin-top:10px; cursor:pointer;">驗證並開啟上班</button>
            </div>
            
            <div id="status" style="font-size:18px; color:gray; margin:20px; font-weight:bold;">🔴 目前下班中 (未定位)</div>
            <div id="gpsDebug" style="font-size:12px; color:gray; margin-bottom:10px;"></div>

            <div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-top:20px; text-align:left; box-shadow: 0px 4px 12px rgba(0,0,0,0.08);">
                <h3 style="color:#856404; margin-top:0; text-align:center;">🚨 收到新任務單！</h3>
                <p><b>單據類型：</b><span id="popOrderType" style="
