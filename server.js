const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());

// 這裡改成動態資料庫：只紀錄「目前點擊上線」的真實司機
let activeDrivers = {}; 

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))); 
}

// ─── 管理者網頁 ───
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>管理者派車後台</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto;">
            <h2>🚨 管理者發送派單</h2>
            地址: <input type="text" id="addr" value="桃園市桃園區中正路1號" style="width:100%; padding:8px; margin-bottom:10px;"><br>
            緯度: <input type="number" id="lat" value="24.9936" step="0.0001" style="width:100%; padding:8px; margin-bottom:10px;"><br>
            經度: <input type="number" id="lng" value="121.3130" step="0.0001" style="width:100%; padding:8px; margin-bottom:20px;"><br>
            <button onclick="sendOrder()" style="width:100%; padding:12px; background:blue; color:white; border:none; font-size:16px;">確認派車 (找最近2位線上司機)</button>
            <h3 style="margin-top:30px;">📡 派單動態監聽：</h3>
            <div id="log" style="background:#eee; padding:10px; min-height:100px; border-radius:5px;">等待派單...</div>
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io({ transports: ['polling', 'websocket'] });
                function sendOrder() {
                    document.getElementById('log').innerText = "處理中...";
                    fetch('/api/dispatch', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            targetAddress: document.getElementById('addr').value,
                            targetLat: parseFloat(document.getElementById('lat').value),
                            targetLng: parseFloat(document.getElementById('lng').value)
                        })
                    });
                }
                socket.on('admin_notification', (data) => {
                    document.getElementById('log').innerHTML += '<br><span style="color:red;">[' + data.status + '] ' + data.message + '</span>';
                });
            </script>
        </body>
        </html>
    `);
});

// ─── 司機端網頁（含手機定位與上下線按鈕） ───
app.get('/driver', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>司機端系統</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; text-align:center;">
            <h2>🚖 司機工作台</h2>
<div style="margin:10px 0;">
    司機代號: <input type="text" id="driverId" value="司機01" style="padding:5px; font-size:16px; width:100px;">
</div>
<div style="margin:10px 0;">
    驗證 PIN 碼: <input type="password" id="pinCode" placeholder="請輸入4位數密碼" style="padding:5px; font-size:16px; width:120px; text-align:center;">
</div>
            
            <button id="toggleBtn" onclick="toggleStatus()" style="padding:10px 20px; font-size:16px; background:green; color:white; border:none; border-radius:5px; width:80%; margin:10px 0;">開啟上班 (開始定位)</button>
            
            <hr>
            <div id="status" style="font-size:18px; color:gray; margin:20px;">🔴 目前下班中 (未定位)</div>
            <div id="gpsDebug" style="font-size:12px; color:gray;"></div>

            <div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-top:20px;">
                <h3 style="color:#856404; margin-top:0;">🚨 收到新派單通知！</h3>
                <p id="addrText"></p>
                <p style="color:red; font-weight:bold;">⏰ 請在 2 分鐘內完成搶單！</p>
                <button id="acceptBtn" style="padding:12px 30px; background:green; color:white; border:none; font-size:18px; font-weight:bold; border-radius:5px; width:100%;">立刻接單 (搶)</button>
            </div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io({ transports: ['polling', 'websocket'] });
                let isOnline = false;
                let watchId = null;

                // 上下線開關邏輯
                function toggleStatus() {
    const dId = document.getElementById('driverId').value;
    const btn = document.getElementById('toggleBtn');
    const statusText = document.getElementById('status');
    const inputPin = document.getElementById('pinCode').value;

    if (!isOnline) {
        // 🚨 密碼檢查門神：如果密碼不是 8888，就直接攔截！
        if (inputPin !== "8888") {
            alert("❌ PIN 碼錯誤！您沒有權限登入司機系統。");
            return; // 密碼錯了，直接結束，不給連線、不抓 GPS！
        }

        // 密碼正確才繼續往下走原本的上班流程
                        // 【開啟定位】請求手機瀏覽器允許 GPS 定位權限
                        if (navigator.geolocation) {
                            isOnline = true;
                            btn.innerText = "關閉下班 (停止定位)";
                            btn.style.background = "red";
                            statusText.innerText = "🟢 線上候客中 (GPS持續更新)...";
                            statusText.style.color = "green";

                            // 每當司機位置改變，自動回傳經緯度給大腦
                            watchId = navigator.geolocation.watchPosition((position) => {
                                let lat = position.coords.latitude;
                                let lng = position.coords.longitude;
                                document.getElementById('gpsDebug').innerText = "目前手機GPS: " + lat.toFixed(4) + ", " + lng.toFixed(4);
                                socket.emit('driver_location_update', { driverId: dId, lat: lat, lng: lng });
                            }, (err) => {
                                alert("請允許手機瀏覽器獲取 GPS 定位權限！");
                            }, { enableHighAccuracy: true });
                        } else {
                            alert("您的手機不支援 GPS 定位");
                        }
                    } else {
                        // 【關閉定位】
                        isOnline = false;
                        btn.innerText = "開啟上班 (開始定位)";
                        btn.style.background = "green";
                        statusText.innerText = "🔴 目前下班中 (未定位)";
                        statusText.style.color = "gray";
                        document.getElementById('gpsDebug').innerText = "";
                        if (watchId) navigator.geolocation.clearWatch(watchId);
                        socket.emit('driver_offline', { driverId: dId });
                    }
                }

                socket.on('new_order_request', (data) => {
                    document.getElementById('addrText').innerText = "目的地：" + data.address;
                    document.getElementById('pop').style.display = "block";
                    
                    document.getElementById('acceptBtn').onclick = function() {
                        const dId = document.getElementById('driverId').value;
                        socket.emit('accept_order', {
                            orderId: data.orderId,
                            driverId: dId,
                            targetLat: data.lat,
                            targetLng: data.lng
                        });
                    };
                });

                socket.on('accept_result', (data) => {
                    if(data.success) {
                        document.getElementById('pop').style.display = "none";
                        // 【跳轉至 Google Maps App 開始導航】
                        window.location.href = "https://www.google.com/maps/search/?api=1&query=" + data.lat + "," + data.lng;
                    } else {
                        alert(data.message);
                        document.getElementById('pop').style.display = "none";
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// ─── 派單與定位邏輯 ───
let currentActiveOrder = null;

app.post('/api/dispatch', (req, res) => {
    const { targetAddress, targetLat, targetLng } = req.body;
    
    // 將目前「在線上的真實司機」拿出來計算距離
    let driversArray = Object.values(activeDrivers);
    let sortedDrivers = driversArray.map(driver => {
        return { ...driver, distance: getDistance(targetLat, targetLng, driver.lat, driver.lng) };
    }).sort((a, b) => a.distance - b.distance);

    let top2Drivers = sortedDrivers.slice(0, 2);
    if (top2Drivers.length === 0) {
        io.emit('admin_notification', { status: "FAILED", message: "目前沒有任何司機在線上上班！" });
        return res.status(400).json({ status: "failed" });
    }

    let orderId = "order_" + Date.now();
    currentActiveOrder = { orderId, isAccepted: false, lat: targetLat, lng: targetLng };

    top2Drivers.forEach(driver => {
        if (driver.socketId) {
            io.to(driver.socketId).emit('new_order_request', { orderId, address: targetAddress, lat: targetLat, lng: targetLng });
        }
    });

    setTimeout(() => {
        if (currentActiveOrder && currentActiveOrder.orderId === orderId && !currentActiveOrder.isAccepted) {
            io.emit('admin_notification', { status: "TIMEOUT", message: `地址：${targetAddress} 的派單逾時無人接單。` });
            currentActiveOrder = null;
        }
    }, 120000);

    res.json({ status: "processing", orderId });
});

io.on('connection', (socket) => {
    // 司機定位更新
    socket.on('driver_location_update', (data) => {
        activeDrivers[data.driverId] = {
            id: data.driverId,
            lat: data.lat,
            lng: data.lng,
            socketId: socket.id
        };
        console.log(`[定位更新] 司機: \${data.driverId} 座標: \${data.lat}, \${data.lng}`);
    });

    // 司機下線
    socket.on('driver_offline', (data) => {
        delete activeDrivers[data.driverId];
        console.log(`[下線] 司機: \${data.driverId}`);
    });

    socket.on('accept_order', (data) => {
        if (currentActiveOrder && currentActiveOrder.orderId === data.orderId && !currentActiveOrder.isAccepted) {
            currentActiveOrder.isAccepted = true;
            socket.emit('accept_result', { success: true, lat: currentActiveOrder.lat, lng: currentActiveOrder.lng });
            io.emit('admin_notification', { status: "SUCCESS", message: "司機 " + data.driverId + " 已成功搶單！" });
        } else {
            socket.emit('accept_result', { success: false, message: "單已被搶走或已逾時。" });
        }
    });

    socket.on('disconnect', () => {
        // 斷線自動清除
        for (let id in activeDrivers) {
            if (activeDrivers[id].socketId === socket.id) {
                delete activeDrivers[id];
                console.log("[斷線下線] 司機: " + id);
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('\n🚀 全球定位版派車大腦已啟動！Port: 3000');
});