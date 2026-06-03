const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    // 解決兩台手機同時連線、或行動網路容易斷線的優化設定
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json());

// ─── 🔑 管理者專屬：司機帳號密碼名冊 ───
// 你可以在這裡自由增加、修改或刪除合法的司機。
// 格式： '車牌號碼': { name: '司機稱呼', phone: '手機號碼' }
const driverRegistry = {
    'BNH-2950': { name: '曾成竣', phone: '0930548588' },
    'EBA-9369': { name: '曾開正', phone: '0955298588' },
    'TAXI-999': { name: '司機03', phone: '0900111222' }
};

// 儲存目前「在線上」的真實司機動態資料
let activeDrivers = {}; 

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))); 
}

// ─── 🚨 管理者網頁 ───
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
            <button onclick="sendOrder()" style="width:100%; padding:12px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px;">確認派車 (找最近2位線上司機)</button>
            <h3 style="margin-top:30px;">📡 派單動態監聽：</h3>
            <div id="log" style="background:#eee; padding:10px; min-height:100px; border-radius:5px; font-family:monospace;">等待派單...</div>
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

// ─── 🚖 司機端網頁（升級版：含車牌電話登入、背景自動重連） ───
app.get('/driver', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>司機端系統</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; text-align:center;">
            <h2>🚖 司機工作台系統</h2>
            
            <div id="loginSection" style="background:#f8f9fa; padding:20px; border-radius:10px; border:1px solid #ddd; margin-bottom:20px;">
                <h3 style="margin-top:0;">🔐 司機身分驗證</h3>
                <div style="margin:10px 0; text-align:left;">
                    <label><b>車牌號碼 (帳號):</b></label>
                    <input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px; font-size:16px;">
                </div>
                <div style="margin:15px 0; text-align:left;">
                    <label><b>手機號碼 (密碼):</b></label>
                    <input type="password" id="phoneNum" placeholder="請輸入您的電話號碼" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px; font-size:16px;">
                </div>
                <button id="toggleBtn" onclick="toggleStatus()" style="padding:12px; font-size:16px; font-weight:bold; background:green; color:white; border:none; border-radius:5px; width:100%; margin-top:10px;">驗證並開啟上班</button>
            </div>
            
            <hr>
            <div id="status" style="font-size:18px; color:gray; margin:20px; font-weight:bold;">🔴 目前下班中 (未定位)</div>
            <div id="gpsDebug" style="font-size:12px; color:gray;"></div>

            <div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-top:20px; box-shadow: 0px 4px 10px rgba(0,0,0,0.1);">
                <h3 style="color:#856404; margin-top:0;">🚨 收到新派單通知！</h3>
                <p id="addrText" style="font-size:18px; font-weight:bold;"></p>
                <p style="color:red; font-weight:bold;">⏰ 請在 2 分鐘內完成搶單！</p>
                <button id="acceptBtn" style="padding:14px 30px; background:green; color:white; border:none; font-size:18px; font-weight:bold; border-radius:5px; width:100%;">立刻接單 (搶)</button>
            </div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
                // 開啟長輪詢機制，大幅減少斷線機率
                const socket = io({ 
                    transports: ['polling', 'websocket'],
                    autoConnect: true,
                    reconnection: true,
                    reconnectionAttempts: Infinity,
                    reconnectionDelay: 1000
                });

                let isOnline = false;
                let watchId = null;
                let currentLat = 0;
                let currentLng = 0;

                // 🌟 當手機從後台切回前台時，強迫立刻更新並補發定位
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible' && isOnline) {
                        console.log('司機回到網頁，補發定位快取...');
                        sendLocationUpdate();
                    }
                });

                // 斷線自動重連成功時，自動把上班狀態補回去給大腦
                socket.on('connect', () => {
                    if (isOnline) {
                        console.log('網路重連成功，自動恢復線上身分');
                        sendLocationUpdate();
                    }
                });

                // 處理登入失敗的回覆
                socket.on('login_failed', (data) => {
                    alert("❌ 登入失敗：" + data.message);
                    resetToOfflineInfo();
                });

                function sendLocationUpdate() {
                    const pNum = document.getElementById('plateNum').value.trim();
                    const pwd = document.getElementById('phoneNum').value.trim();
                    if (pNum && currentLat && currentLng) {
                        socket.emit('driver_location_update', { 
                            plateNumber: pNum, 
                            phoneNumber: pwd, 
                            lat: currentLat, 
                            lng: currentLng 
                        });
                    }
                }

                function toggleStatus() {
                    const pNum = document.getElementById('plateNum').value.trim();
                    const pwd = document.getElementById('phoneNum').value.trim();
                    const btn = document.getElementById('toggleBtn');
                    const statusText = document.getElementById('status');

                    if (!pNum || !pwd) {
                        alert("請完整輸入車牌號碼與手機號碼！");
                        return;
                    }

                    if (!isOnline) {
                        if (navigator.geolocation) {
                            // 先抓一次定位，成功才進行上班登入
                            navigator.geolocation.getCurrentPosition((position) => {
                                isOnline = true;
                                btn.innerText = "關閉下班 (停止定位)";
                                btn.style.background = "red";
                                statusText.innerText = "🟢 線上候客中 (防斷線守護中)...";
                                statusText.style.color = "green";
                                
                                // 鎖定輸入框，上班中不能亂改帳密
                                document.getElementById('plateNum').disabled = true;
                                document.getElementById('phoneNum').disabled = true;

                                currentLat = position.coords.latitude;
                                currentLng = position.coords.longitude;
                                document.getElementById('gpsDebug').innerText = "目前手機GPS: " + currentLat.toFixed(4) + ", " + currentLng.toFixed(4);
                                
                                // 發送登入與定位更新
                                sendLocationUpdate();

                                // 持續追蹤
                                watchId = navigator.geolocation.watchPosition((pos) => {
                                    currentLat = pos.coords.latitude;
                                    currentLng = pos.coords.longitude;
                                    document.getElementById('gpsDebug').innerText = "目前手機GPS: " + currentLat.toFixed(4) + ", " + currentLng.toFixed(4);
                                    sendLocationUpdate();
                                }, null, { enableHighAccuracy: true });

                            }, (err) => {
                                alert("請允許手機瀏覽器獲取 GPS 定位權限，否則無法上班！");
                            }, { enableHighAccuracy: true });
                        } else {
                            alert("您的手機不支援 GPS 定位");
                        }
                    } else {
                        // 點擊下班
                        const dId = document.getElementById('plateNum').value.trim();
                        socket.emit('driver_offline', { plateNumber: dId });
                        resetToOfflineInfo();
                    }
                }

                function resetToOfflineInfo() {
                    isOnline = false;
                    const btn = document.getElementById('toggleBtn');
                    const statusText = document.getElementById('status');
                    btn.innerText = "驗證並開啟上班";
                    btn.style.background = "green";
                    statusText.innerText = "🔴 目前下班中 (未定位)";
                    statusText.style.color = "gray";
                    document.getElementById('gpsDebug').innerText = "";
                    document.getElementById('plateNum').disabled = false;
                    document.getElementById('phoneNum').disabled = false;
                    if (watchId) navigator.geolocation.clearWatch(watchId);
                }

                socket.on('new_order_request', (data) => {
                    document.getElementById('addrText').innerText = "目的地：" + data.address;
                    document.getElementById('pop').style.display = "block";
                    
                    document.getElementById('acceptBtn').onclick = function() {
                        const pNum = document.getElementById('plateNum').value.trim();
                        socket.emit('accept_order', {
                            orderId: data.orderId,
                            plateNumber: pNum,
                            targetLat: data.lat,
                            targetLng: data.lng
                        });
                    };
                });

                socket.on('accept_result', (data) => {
                    if(data.success) {
                        document.getElementById('pop').style.display = "none";
                        // 🎉 修正後的標準 Google Map 導航跳轉格式
                        window.location.href = "https://www.google.com/maps/dir/?api=1&destination=" + data.lat + "," + data.lng;
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
    
    // 司機身分驗證與定位更新
    socket.on('driver_location_update', (data) => {
        const pNum = data.plateNumber;
        const pPwd = data.phoneNumber;

        // 🛡️ 檢查名冊中是否有這台車，且電話是否正確
        const registeredDriver = driverRegistry[pNum];
        if (!registeredDriver || registeredDriver.phone !== pPwd) {
            socket.emit('login_failed', { message: "車牌號碼不存在，或是手機號碼不正確！" });
            return;
        }

        // 驗證成功，寫入線上名單
        activeDrivers[pNum] = {
            id: pNum,
            name: registeredDriver.name,
            lat: data.lat,
            lng: data.lng,
            socketId: socket.id // 每次重連會自動更新這個小門牌，防止斷線收不到派單
        };
        console.log(`[認證成功] 司機: ${registeredDriver.name} (${pNum}) 座標: ${data.lat}, ${data.lng}`);
    });

    // 司機主動下線
    socket.on('driver_offline', (data) => {
        delete activeDrivers[data.plateNumber];
        console.log(`[主動下線] 車牌: ${data.plateNumber}`);
    });

    // 處理搶單
    socket.on('accept_order', (data) => {
        const driverInfo = activeDrivers[data.plateNumber];
        const driverDisplayName = driverInfo ? `${driverInfo.name} (${data.plateNumber})` : data.plateNumber;

        if (currentActiveOrder && currentActiveOrder.orderId === data.orderId && !currentActiveOrder.isAccepted) {
            currentActiveOrder.isAccepted = true;
            socket.emit('accept_result', { success: true, lat: currentActiveOrder.lat, lng: currentActiveOrder.lng });
            
            // 🌟 使用 + 號拼接，完美秀出真實車牌與名字！
            io.emit('admin_notification', { status: "SUCCESS", message: "司機 " + driverDisplayName + " 已成功搶單！" });
        } else {
            socket.emit('accept_result', { success: false, message: "單已被搶走或已逾時。" });
        }
    });

    socket.on('disconnect', () => {
        // 斷線時，不要立刻刪除司機！給予網頁切到後台重連的寬限緩衝
        setTimeout(() => {
            for (let pNum in activeDrivers) {
                if (activeDrivers[pNum].socketId === socket.id) {
                    // 檢查這台車在過去幾秒內有沒有透過新 socket 重連回來，如果沒有，才判定為真正下線
                    if (activeDrivers[pNum].socketId === socket.id) {
                        delete activeDrivers[pNum];
                        console.log(`[完全斷線] 車牌: ${pNum}`);
                    }
                }
            }
        }, 8000); // 8秒緩衝，足夠讓切換 App 的司機自動連回來
    });
});

// 監聽環境變數
server.listen(process.env.PORT || 3000, () => {
    console.log('\n🚀 權限與防斷線升級版派車大腦已啟動！');
});