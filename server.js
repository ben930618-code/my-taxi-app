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
    res.send('\
        <!DOCTYPE html>\
        <html>\
        <head><title>管理者派車後台</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>\
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; background:#f4f6f9;">\
            <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,0.05);">\
                <h2>🚨 管理者發送派單</h2>\
                <label><b>1. 訂單類型:</b></label>\
                <select id="orderType" style="width:100%; padding:10px; margin-bottom:15px; font-size:15px;" onchange="toggleTimeInput()">\
                    <option value="即時單">⚡ 即時派單 (立刻用車)</option>\
                    <option value="預約單">📅 預約派單 (指定時間)</option>\
                </select>\
                <div id="bookingTimeDiv" style="display:none; margin-bottom:15px; background:#e9ecef; padding:10px; border-radius:5px;">\
                    <label><b>預約用車時間:</b></label><br>\
                    <input type="datetime-local" id="bookingTime" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px;">\
                </div>\
                <label><b>2. 上車地址 (輸入文字路名門牌)：</b></label>\
                <input type="text" id="addr" value="桃園市桃園區中正路1號" style="width:100%; padding:8px; box-sizing:border-box; margin-bottom:10px;"><br>\
                <div style="display:flex; gap:10px; margin-bottom:15px;">\
                    <div style="flex:1;">\
                        <label>緯度 (計算距離用)：</label>\
                        <input type="number" id="lat" value="24.9936" step="0.0001" style="width:100%; padding:8px; box-sizing:border-box;">\
                    </div>\
                    <div style="flex:1;">\
                        <label>經度 (計算距離用)：</label>\
                        <input type="number" id="lng" value="121.3130" step="0.0001" style="width:100%; padding:8px; box-sizing:border-box;">\
                    </div>\
                </div>\
                <label><b>3. 本單目標通知司機人數:</b></label>\
                <select id="driverCount" style="width:100%; padding:10px; margin-bottom:20px; font-size:15px;">\
                    <option value="1">通知最近的 1 位司機</option>\
                    <option value="2" selected>通知最近的 2 位司機 (預設)</option>\
                    <option value="3">通知最近的 3 位司機</option>\
                    <option value="4">通知最近的 4 位司機</option>\
                    <option value="5">通知最近的 5 位司機</option>\
                </select>\
                <button onclick="sendOrder()" style="width:100%; padding:14px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px; cursor:pointer;">發送派單單據</button>\
            </div>\
            <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,0.05); margin-top:20px;">\
                <h3 style="margin-top:0;">📡 派單動態監聽：</h3>\
                <div id="log" style="background:#eee; padding:15px; min-height:120px; border-radius:5px; font-family:monospace; line-height:1.5; font-size:14px; white-space:pre-wrap;">等待派單...</div>\
            </div>\
            <script src="/socket.io/socket.io.js"></script>\
            <script>\
                const socket = io({ transports: ["polling", "websocket"] });\
                function toggleTimeInput() {\
                    const type = document.getElementById("orderType").value;\
                    document.getElementById("bookingTimeDiv").style.display = (type === "預約單") ? "block" : "none";\
                }\
                function sendOrder() {\
                    const type = document.getElementById("orderType").value;\
                    let bTime = "無 (即時單)";\
                    if(type === "預約單") {\
                        const rawTime = document.getElementById("bookingTime").value;\
                        if(!rawTime) { alert("請選擇預約時間！"); return; }\
                        bTime = rawTime.replace("T", " ");\
                    }\
                    fetch("/api/dispatch", {\
                        method: "POST",\
                        headers: {"Content-Type": "application/json"},\
                        body: JSON.stringify({\
                            targetAddress: document.getElementById("addr").value,\
                            targetLat: parseFloat(document.getElementById("lat").value),\
                            targetLng: parseFloat(document.getElementById("lng").value),\
                            limitCount: parseInt(document.getElementById("driverCount").value),\
                            orderType: type,\
                            bookingTime: bTime\
                        })\
                    });\
                }\
                socket.on("admin_notification", (data) => {\
                    const logDiv = document.getElementById("log");\
                    let color = "black";\
                    if(data.status === "SUCCESS") color = "green";\
                    if(data.status === "FAILED" || data.status === "TIMEOUT") color = "red";\
                    logDiv.innerHTML += "<br><span style=\'color:" + color + "; font-weight:bold;\'>[" + data.status + "] " + data.message.replace(/\\n/g, "<br>") + "</span>";\
                });\
            </script>\
        </body>\
        </html>\
    ');
});

// ─── 🚖 司機端網頁 ───
app.get('/driver', (req, res) => {
    res.send('\
        <!DOCTYPE html>\
        <html>\
        <head><title>司機端系統</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>\
        <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; text-align:center; background:#fafafa;">\
            <h2>🚖 司機工作台系統</h2>\
            <div id="loginSection" style="background:white; padding:20px; border-radius:10px; border:1px solid #eee; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.02);">\
                <h3 style="margin-top:0;">🔐 司機身分驗證</h3>\
                <div style="margin:10px 0; text-align:left;">\
                    <label><b>車牌號碼 (帳號):</b></label>\
                    <input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px; font-size:16px;">\
                </div>\
                <div style="margin:15px 0; text-align:left;">\
                    <label><b>手機號碼 (密碼):</b></label>\
                    <input type="password" id="phoneNum" placeholder="請輸入您的電話號碼" style="width:100%; padding:8px; box-sizing:border-box; margin-top:5px; font-size:16px;">\
                </div>\
                <button id="toggleBtn" onclick="toggleStatus()" style="padding:12px; font-size:16px; font-weight:bold; background:green; color:white; border:none; border-radius:5px; width:100%; margin-top:10px; cursor:pointer;">驗證並開啟上班</button>\
            </div>\
            <div id="status" style="font-size:18px; color:gray; margin:20px; font-weight:bold;">🔴 目前下班中 (未定位)</div>\
            <div id="gpsDebug" style="font-size:12px; color:gray; margin-bottom:10px;"></div>\
            <div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-top:20px; text-align:left; box-shadow: 0px 4px 12px rgba(0,0,0,0.08);">\
                <h3 style="color:#856404; margin-top:0; text-align:center;">🚨 收到新任務單！</h3>\
                <p><b>單據類型：</b><span id="popOrderType" style="color:blue; font-weight:bold;"></span></p>\
                <div id="popBookingTimeRow" style="display:none; margin:5px 0;"><b>預約時間：</b><span id="popBookingTime" style="color:purple; font-weight:bold;"></span></div>\
                <p><b>乘客上車點：</b><span id="addrText" style="font-weight:bold;"></span></p>\
                <button id="acceptBtn" style="padding:14px 30px; background:green; color:white; border:none; font-size:18px; font-weight:bold; border-radius:5px; width:100%; cursor:pointer; margin-top:10px;">立刻接單 (搶)</button>\
            </div>\
            <div id="scheduleSection" style="display:none; background:white; padding:20px; border-radius:10px; border:1px solid #ddd; margin-top:20px; text-align:left; box-shadow:0 2px 8px rgba(0,0,0,0.05);">\
                <h3 style="margin-top:0; color:#333; border-bottom:2px solid #007bff; padding-bottom:5px;">📅 我的預約行程表</h3>\
                <div id="scheduleList" style="font-size:14px; color:#555;">\
                    <p style="color:gray; text-align:center;">目前尚無已接下的預約行程</p>\
                </div>\
            </div>\
            <script src="/socket.io/socket.io.js"></script>\
            <script>\
                const socket = io({ \
                    transports: ["polling", "websocket"],\
                    autoConnect: true,\
                    reconnection: true,\
                    reconnectionAttempts: Infinity,\
                    reconnectionDelay: 1000\
                });\
                let isOnline = false;\
                let watchId = null;\
                let currentLat = 0;\
                let currentLng = 0;\
                document.addEventListener("visibilitychange", () => {\
                    if (document.visibilityState === "visible" && isOnline) {\
                        sendLocationUpdate();\
                        requestMySchedule();\
                    }\
                });\
                socket.on("connect", () => {\
                    if (isOnline) {\
                        sendLocationUpdate();\
                        requestMySchedule();\
                    }\
                });\
                socket.on("login_failed", (data) => {\
                    alert("❌ 登入失敗：" + data.message);\
                    resetToOfflineInfo();\
                });\
                socket.on("login_success", () => {\
                    isOnline = true;\
                    const btn = document.getElementById("toggleBtn");\
                    const statusText = document.getElementById("status");\
                    btn.innerText = "關閉下班 (停止定位)";\
                    btn.style.background = "red";\
                    statusText.innerText = "🟢 線上候客中...";\
                    statusText.style.color = "green";\
                    document.getElementById("plateNum").disabled = true;\
                    document.getElementById("phoneNum").disabled = true;\
                    document.getElementById("scheduleSection").style.display = "block";\
                    requestMySchedule();\
                });\
                socket.on("update_schedule_list", (orders) => {\
                    const listDiv = document.getElementById("scheduleList");\
                    if(!orders || orders.length === 0) {\
                        listDiv.innerHTML = "<p style=\'color:gray; text-align:center;\'>目前尚無已接下的預約行程</p>";\
                        return;\
                    }\
                    let html = "";\
                    orders.forEach((ord, index) => {\
                        html += "<div style=\'background:#f1f3f5; padding:10px; border-radius:5px; margin-bottom:8px; border-left:4px solid purple;\'>" +\
                            "<b>任務 " + (index+1) + ". [" + ord.orderType + "]</b><br>" +\
                            "預約時間: <span style=\'color:purple; font-weight:bold;\'>" + ord.bookingTime + "</span><br>" +\
                            "上車點: " + ord.targetAddress + "<br>" +\
                            "<button onclick=\"openTextNav(\'" + encodeURIComponent(ord.targetAddress) + "\')\" style=\'margin-top:5px; padding:6px 12px; font-size:13px; background:#007bff; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:bold;\'>🧭 開啟地圖導航</button>" +\
                        "</div>";\
                    });\
                    listDiv.innerHTML = html;\
                });\
                function openTextNav(encodedAddress) {\
                    window.location.href = "https://www.google.com/maps/search/?api=1&query=" + encodedAddress;\
                }\
                function requestMySchedule() {\
                    const pNum = document.getElementById("plateNum").value.trim();\
                    if(pNum) { socket.emit("get_driver_schedule", { plateNumber: pNum }); }\
                }\
                function sendLocationUpdate() {\
                    const pNum = document.getElementById("plateNum").value.trim();\
                    const pwd = document.getElementById("phoneNum").value.trim();\
                    if (pNum && pwd && currentLat && currentLng) {\
                        socket.emit("driver_location_update", { \
                            plateNumber: pNum, \
                            phoneNumber: pwd, \
                            lat: currentLat, \
                            lng: currentLng \
                        });\
                    }\
                }\
                function toggleStatus() {\
                    const pNum = document.getElementById("plateNum").value.trim();\
                    const pwd = document.getElementById("phoneNum").value.trim();\
                    if (!pNum || !pwd) { alert("請完整輸入車牌與手機！"); return; }\
                    if (!isOnline) {\
                        if (navigator.geolocation) {\
                            navigator.geolocation.getCurrentPosition((position) => {\
                                currentLat = position.coords.latitude;\
                                currentLng = position.coords.longitude;\
                                document.getElementById("gpsDebug").innerText = "目前手機GPS: " + currentLat.toFixed(4) + ", " + currentLng.toFixed(4);\
                                sendLocationUpdate();\
                                watchId = navigator.geolocation.watchPosition((pos) => {\
                                    currentLat = pos.coords.latitude;\
                                    currentLng = pos.coords.longitude;\
                                    document.getElementById("gpsDebug").innerText = "目前手機GPS: " + currentLat.toFixed(4) + ", " + currentLng.toFixed(4);\
                                    sendLocationUpdate();\
                                }, null, { enableHighAccuracy: true });\
                            }, (err) => {\
                                alert("請允許獲取 GPS 定位權限！");\
                            }, { enableHighAccuracy: true });\
                        } else {\
                            alert("您的手機不支援 GPS 定位");\
                        }\
                    } else {\
                        socket.emit("driver_offline", { plateNumber: pNum });\
                        resetToOfflineInfo();\
                    }\
                }\
                function resetToOfflineInfo() {\
                    isOnline = false;\
                    const btn = document.getElementById("toggleBtn");\
                    const statusText = document.getElementById("status");\
                    btn.innerText = "驗證並開啟上班";\
                    btn.style.background = "green";\
                    statusText.innerText = "🔴 目前下班中 (未定位)";\
                    statusText.style.color = "gray";\
                    document.getElementById("gpsDebug").innerText = "";\
                    document.getElementById("plateNum").disabled = false;\
                    document.getElementById("phoneNum").disabled = false;\
                    document.getElementById("scheduleSection").style.display = "none";\
                    if (watchId) navigator.geolocation.clearWatch(watchId);\
                }\
                socket.on("new_order_request", (data) => {\
                    document.getElementById("popOrderType").innerText = data.orderType;\
                    if(data.orderType === "預約單") {\
                        document.getElementById("popBookingTime").innerText = data.bookingTime;\
                        document.getElementById("popBookingTimeRow").style.display = "block";\
                    } else {\
                        document.getElementById("popBookingTimeRow").style.display = "none";\
                    }\
                    document.getElementById("addrText").innerText = data.targetAddress;\
                    document.getElementById("pop").style.display = "block";\
                    document.getElementById("acceptBtn").onclick = function() {\
                        const pNum = document.getElementById("plateNum").value.trim();\
                        socket.emit("accept_order", {\
                            orderId: data.orderId,\
                            plateNumber: pNum\
                        });\
                    };\
                });\
                socket.on("accept_result", (data) => {\
                    document.getElementById("pop").style.display = "none";\
                    if(data.success) {\
                        requestMySchedule();\
                        if(data.orderType === "即時單") {\
                            openTextNav(encodeURIComponent(data.targetAddress));\
                        } else {\
                            alert("🎉 預約單搶單成功！已將此單排入您的預約行程表。");\
                        }\
                    } else {\
                        alert(data.message);\
                    }\
                });\
            </script>\
        </body>\
        </html>\
    ');
});

// ─── 派單與定位中心 ───
let activeOrders = {};

app.post('/api/dispatch', (req, res) => {
    const { targetAddress, targetLat, targetLng, limitCount, orderType, bookingTime } = req.body;
    
    let driversArray = Object.values(activeDrivers);
    let sortedDrivers = driversArray.map(driver => {
        return { ...driver, distance: getDistance(targetLat, targetLng, driver.lat, driver.lng) };
    }).sort((a, b) => a.distance - b.distance);

    let topDrivers = sortedDrivers.slice(0, limitCount);
    if (topDrivers.length === 0) {
        io.emit('admin_notification', { status: "FAILED", message: "目前沒有任何司機在線上上班！" });
        return res.status(400).json({ status: "failed" });
    }

    let orderId = "order_" + Date.now();
    activeOrders[orderId] = { 
        orderId, targetAddress, targetLat, targetLng, orderType, bookingTime, isAccepted: false 
    };

    topDrivers.forEach(driver => {
        if (driver.socketId) {
            io.to(driver.socketId).emit('new_order_request', activeOrders[orderId]);
        }
    });

    setTimeout(() => {
        if (activeOrders[orderId] && !activeOrders[orderId].isAccepted) {
            io.emit('admin_notification', { status: "TIMEOUT", message: '地址：' + targetAddress + ' 的[' + orderType + ']派單逾時無人接單。' });
            delete activeOrders[orderId];
        }
    }, 120000);

    res.json({ status: "processing", orderId });
});

io.on('connection', (socket) => {
    
    socket.on('driver_location_update', (data) => {
        const pNum = data.plateNumber;
        const pPwd = data.phoneNumber;

        const registeredDriver = driverRegistry[pNum];
        if (!registeredDriver || registeredDriver.phone !== pPwd) {
            socket.emit('login_failed', { message: "帳號密碼不正確！" });
            return;
        }

        activeDrivers[pNum] = {
            id: pNum,
            name: registeredDriver.name,
            lat: data.lat,
            lng: data.lng,
            socketId: socket.id
        };
        socket.emit('login_success');
    });

    socket.on('get_driver_schedule', (data) => {
        const pNum = data.plateNumber;
        const list = driverSchedules[pNum] || [];
        socket.emit('update_schedule_list', list);
    });

    socket.on('driver_offline', (data) => {
        delete activeDrivers[data.plateNumber];
    });

    socket.on('accept_order', (data) => {
        const pNum = data.plateNumber;
        const ord = activeOrders[data.orderId];
        const driverInfo = activeDrivers[pNum];

        if (ord && !ord.isAccepted) {
            ord.isAccepted = true;
            
            const rawDist = getDistance(ord.targetLat, ord.targetLng, driverInfo.lat, driverInfo.lng);
            const durationEta = calculateETA(rawDist);
            const driverCurrentAddr = estimateAddress(driverInfo.lat, driverInfo.lng);

            if (ord.orderType === "預約單") {
                if (!driverSchedules[pNum]) driverSchedules[pNum] = [];
                driverSchedules[pNum].push(ord);
                driverSchedules[pNum].sort((a,b) => new Date(a.bookingTime) - new Date(b.bookingTime));
            }

            socket.emit('accept_result', { 
                success: true, 
                orderType: ord.orderType, 
                targetAddress: ord.targetAddress 
            });
            
            const adminMsg = "司機 " + driverInfo.name + " (" + pNum + ") 已搶下本單！\n" +
                             "📍 司機出發地址: " + driverCurrentAddr + "\n" +
                             "📏 直線距離: " + rawDist.toFixed(2) + " 公里\n" +
                             "🚦 當前路況估計: 車流正常，預計 " + durationEta + " 分鐘後到達乘客上車點！";
            
            io.emit('admin_notification', { status: "SUCCESS", message: adminMsg });
            delete activeOrders[data.orderId];
        } else {
            socket.emit('accept_result', { success: false, message: "單已被搶走或已逾時。" });
        }
    });

    socket.on('disconnect', () => {
        setTimeout(() => {
            for (let pNum in activeDrivers) {
                if (activeDrivers[pNum].socketId === socket.id) {
                    delete activeDrivers[pNum];
                }
            }
        }, 8000); 
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('\n🚀 門牌導航＋修正登入版大腦已開機！');
});
