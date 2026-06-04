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

// ─── 🔑 司機基本名冊 ───
const driverRegistry = {
    'ABC-1234': { name: '司機01', phone: '0912345678' },
    'XYZ-5678': { name: '司機02', phone: '0987654321' },
    'TAXI-999': { name: '司機03', phone: '0900111222' }
};

// ─── 💾 系統中央資料庫 (存在記憶體中) ───
let activeDrivers = {};      // 線上司機即時動態
let driverSchedules = {};    // 司機本人的預約單行程表
let globalOrders = [];       // 管理者派單總表 (所有單的歷史紀錄)
let creditLedger = [];       // 月結記帳總帳本

// ─── 🧮 數學核心函數 ───
function getDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))); 
}

function calculateETA(distanceInKm) {
    const averageSpeedKmh = 30; 
    let durationMinutes = (distanceInKm / averageSpeedKmh) * 60;
    durationMinutes += (distanceInKm * 1.5); 
    if (durationMinutes < 3) durationMinutes = 3; 
    return Math.round(durationMinutes);
}

// 發送最新資料給管理者更新畫面
function broadcastAdminData() {
    io.emit('admin_update_data', {
        orders: globalOrders,
        drivers: Object.values(activeDrivers),
        ledger: creditLedger
    });
}

// ─── 🚨 管理者網頁後台 ───
app.get('/admin', (req, res) => {
    const htmlLines = [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '    <title>管理者全功能調度後台</title>',
        '    <meta name="viewport" content="width=device-width, initial-scale=1">',
        '    <style>',
        '        body { font-family: sans-serif; background: #f4f6f9; padding: 15px; margin: 0; }',
        '        .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); margin-bottom: 20px; }',
        '        h2, h3 { margin-top: 0; color: #333; border-bottom: 2px solid #007bff; padding-bottom: 6px; }',
        '        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }',
        '        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }',
        '        th { background: #e9ecef; }',
        '        .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; color: white; }',
        '        .bg-gray { background: #6c757d; } .bg-blue { background: #007bff; } .bg-orange { background: #fd7e14; } .bg-green { background: #28a745; }',
        '    </style>',
        '</head>',
        '<body>',
        '    <div class="card">',
        '        <h2>🚨 管理者發送派單</h2>',
        '        <label><b>1. 訂單類型:</b></label>',
        '        <select id="orderType" style="width:100%; padding:10px; margin-bottom:12px;" onchange="toggleTimeInput()">',
        '            <option value="即時單">⚡ 即時派單 (立刻用車)</option>',
        '            <option value="預約單">📅 預約派單 (指定時間)</option>',
        '        </select>',
        '        <div id="bookingTimeDiv" style="display:none; margin-bottom:12px; background:#e9ecef; padding:10px; border-radius:5px;">',
        '            <label><b>預約用車時間:</b></label><br>',
        '            <input type="datetime-local" id="bookingTime" style="width:100%; padding:8px; margin-top:5px; box-sizing:border-box;">',
        '        </div>',
        '        <label><b>2. 上車地址 (輸入文字路名)：</b></label>',
        '        <input type="text" id="addr" value="桃園市桃園區中正路1號" style="width:100%; padding:8px; margin-bottom:12px; box-sizing:border-box;"><br>',
        '        <div style="display:flex; gap:10px; margin-bottom:12px;">',
        '            <div style="flex:1;">',
        '                <label>緯度：</label>',
        '                <input type="number" id="lat" value="24.9936" step="0.0001" style="width:100%; padding:8px; box-sizing:border-box;">',
        '            </div>',
        '            <div style="flex:1;">',
        '                <label>經度：</label>',
        '                <input type="number" id="lng" value="121.3130" step="0.0001" style="width:100%; padding:8px; box-sizing:border-box;">',
        '            </div>',
        '        </div>',
        '        <label><b>3. 通知最近司機人數:</b></label>',
        '        <select id="driverCount" style="width:100%; padding:10px; margin-bottom:15px;">',
        '            <option value="1">通知最近 1 位司機</option>',
        '            <option value="2" selected>通知最近 2 位司機</option>',
        '            <option value="3">通知最近 3 位司機</option>',
        '        </select>',
        '        <button onclick="sendOrder()" style="width:100%; padding:12px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px; cursor:pointer;">廣播發送派單</button>',
        '    </div>',
        '    ',
        '    <div class="card">',
        '        <h3>🚖 線上司機即時狀態</h3>',
        '        <div id="driverStatusDiv">等待資料載入...</div>',
        '    </div>',
        '    ',
        '    <div class="card">',
        '        <h3>📋 歷史與當前派單總表</h3>',
        '        <div style="overflow-x:auto;">',
        '            <table>',
        '                <thead>',
        '                    <tr>',
        '                        <th>時間/類型</th>',
        '                        <th>乘客上車點</th>',
        '                        <th>擔當司機</th>',
        '                        <th>當前狀態</th>',
        '                        <th>結帳回報</th>',
        '                    </tr>',
        '                </thead>',
        '                <tbody id="orderTableBody">',
        '                    <tr><td colspan="5" style="text-align:center; color:gray;">暫無派單紀錄</td></tr>',
        '                </tbody>',
        '            </table>',
        '        </div>',
        '    </div>',
        '    ',
        '    <div class="card">',
        '        <h3>💵 月結記帳總對帳單</h3>',
        '        <div style="font-size:16px; margin-bottom:10px; color:purple; font-weight:bold;">本月累計記帳總額: <span id="ledgerTotal">0</span> 元</div>',
        '        <div style="overflow-x:auto;">',
        '            <table>',
        '                <thead>',
        '                    <tr>',
        '                        <th>結帳時間</th>',
        '                        <th>車牌/司機</th>',
        '                        <th>客戶名稱(記帳)</th>',
        '                        <th>金額</th>',
        '                    </tr>',
        '                </thead>',
        '                <tbody id="ledgerTableBody">',
        '                    <tr><td colspan="4" style="text-align:center; color:gray;">暫無記帳紀錄</td></tr>',
        '                </tbody>',
        '            </table>',
        '        </div>',
        '    </div>',
        '    ',
        '    <script src="/socket.io/socket.io.js"></script>',
        '    <script>',
        '        const socket = io({ transports: ["polling", "websocket"] });',
        '        ',
        '        function toggleTimeInput() {',
        '            const type = document.getElementById("orderType").value;',
        '            document.getElementById("bookingTimeDiv").style.display = (type === "預約單") ? "block" : "none";',
        '        }',
        '        ',
        '        function sendOrder() {',
        '            const type = document.getElementById("orderType").value;',
        '            let bTime = "無 (即時單)";',
        '            if(type === "預約單") {',
        '                const rawTime = document.getElementById("bookingTime").value;',
        '                if(!rawTime) { alert("請選擇預約時間！"); return; }',
        '                bTime = rawTime.replace("T", " ");',
        '            }',
        '            fetch("/api/dispatch", {',
        '                method: "POST",',
        '                headers: {"Content-Type": "application/json"},',
        '                body: JSON.stringify({',
        '                    targetAddress: document.getElementById("addr").value,',
        '                    targetLat: parseFloat(document.getElementById("lat").value),',
        '                    targetLng: parseFloat(document.getElementById("lng").value),',
        '                    limitCount: parseInt(document.getElementById("driverCount").value),',
        '                    orderType: type,',
        '                    bookingTime: bTime',
        '                })',
        '            });',
        '        }',
        '        ',
        '        socket.on("admin_update_data", (data) => {',
        '            // 1. 渲染司機狀態',
        '            const drDiv = document.getElementById("driverStatusDiv");',
        '            if(data.drivers.length === 0) {',
        '                drDiv.innerHTML = "<span style=\'color:gray;\'>目前沒有司機上線上班</span>";',
        '            } else {',
        '                let drHtml = "";',
        '                data.drivers.forEach(d => {',
        '                    let statusBadge = d.isBusy ? "<span style=\'color:red; font-weight:bold;\'>[🔴 任務進行中]</span>" : "<span style=\'color:green; font-weight:bold;\'>[🟢 空車候客中]</span>";',
        '                    drHtml += "<div style=\'padding:6px 0; border-bottom:1px dashed #eee;\'>🚗 <b>" + d.name + " (" + d.id + ")</b> - " + statusBadge + " | GPS: " + d.lat.toFixed(4) + ", " + d.lng.toFixed(4) + "</div>";',
        '                });',
        '                drDiv.innerHTML = drHtml;',
        '            }',
        '            ',
        '            // 2. 渲染歷史派單表',
        '            const oBody = document.getElementById("orderTableBody");',
        '            if(data.orders.length === 0) {',
        '                oBody.innerHTML = "<tr><td colspan=\'5\' style=\'text-align:center; color:gray;\'>暫無派單紀錄</td></tr>";',
        '            } else {',
        '                let oHtml = "";',
        '                data.orders.slice().reverse().forEach(o => {',
        '                    let statusStr = "";',
        '                    if(o.status === "尚未接單") statusStr = "<span class=\'badge bg-gray\'>尚未接單</span>";',
        '                    if(o.status === "前往迎客") statusStr = "<span class=\'badge bg-blue\'>前往迎客</span>";',
        '                    if(o.status === "旅客已上車") statusStr = "<span class=\'badge bg-orange\'>旅客已上車</span>";',
        '                    if(o.status === "行程已完成") statusStr = "<span class=\'badge bg-green\'>行程已完成</span>";',
        '                    ',
        '                    let payInfo = o.paymentReport ? o.paymentReport : "-";',
        '                    oHtml += "<tr>" +',
        '                        "<td>" + o.bookingTime + "<br><small>(" + o.orderType + ")</small></td>" +',
        '                        "<td>" + o.targetAddress + "</td>" +',
        '                        "<td>" + (o.driverName ? o.driverName + " (" + o.driverId + ")" : "無") + "</td>" +',
        '                        "<td>" + statusStr + "</td>" +',
        '                        "<td>" + payInfo + "</td>" +',
        '                    "</tr>";',
        '                });',
        '                oBody.innerHTML = oHtml;',
        '            }',
        '            ',
        '            // 3. 渲染月結記帳本',
        '            const lBody = document.getElementById("ledgerTableBody");',
        '            let totalSum = 0;',
        '            if(data.ledger.length === 0) {',
        '                lBody.innerHTML = "<tr><td colspan=\'4\' style=\'text-align:center; color:gray;\'>暫無記帳紀錄</td></tr>";',
        '            } else {',
        '                let lHtml = "";',
        '                data.ledger.forEach(l => {',
        '                    totalSum += l.amount;',
        '                    lHtml += "<tr>" +',
        '                        "<td>" + l.time + "</td>" +',
        '                        "<td>" + l.driverId + " (" + l.driverName + ")</td>" +',
        '                        "<td><b style=\'color:purple;\'>" + l.clientName + "</b></td>" +',
        '                        "<td>$" + l.amount + "</td>" +',
        '                    "</tr>";',
        '                });',
        '                lBody.innerHTML = lHtml;',
        '            }',
        '            document.getElementById("ledgerTotal").innerText = totalSum;',
        '        });',
        '    </script>',
        '</body>',
        '</html>'
    ];
    res.send(htmlLines.join('\n'));
});

// ─── 🚖 司機端網頁工作台 ───
app.get('/driver', (req, res) => {
    const htmlLines = [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '    <title>司機端系統</title>',
        '    <meta name="viewport" content="width=device-width, initial-scale=1">',
        '    <style>',
        '        body { font-family: sans-serif; padding: 15px; max-width: 500px; margin: auto; text-align: center; background: #fafafa; }',
        '        .box { background: white; padding: 20px; border-radius: 10px; border: 1px solid #eee; margin-bottom: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.03); text-align: left; }',
        '        .btn { padding: 12px; font-size: 16px; font-weight: bold; border: none; border-radius: 5px; width: 100%; cursor: pointer; color: white; margin-top: 10px; }',
        '        .btn-green { background: #28a745; } .btn-red { background: #dc3545; } .btn-blue { background: #007bff; } .btn-orange { background: #fd7e14; }',
        '    </style>',
        '</head>',
        '<body>',
        '    <h2>🚖 司機工作台系統</h2>',
        '    ',
        '    <div id="loginSection" class="box">',
        '        <h3 style="margin-top:0; text-align:center;">🔐 司機身分驗證</h3>',
        '        <label><b>車牌號碼 (帳號):</b></label>',
        '        <input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;">',
        '        <label><b>手機號碼 (密碼):</b></label>',
        '        <input type="password" id="phoneNum" placeholder="請輸入密碼" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;">',
        '        <button id="toggleBtn" onclick="toggleStatus()" class="btn btn-green">驗證並開啟上班</button>',
        '    </div>',
        '    ',
        '    <div id="status" style="font-size:18px; color:gray; margin:15px; font-weight:bold;">🔴 目前下班中 (未定位)</div>',
        '    <div id="gpsDebug" style="font-size:12px; color:gray; margin-bottom:10px;"></div>',
        '    ',
        '    ',
        '    <div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-bottom:15px; text-align:left;">',
        '        <h3 style="color:#856404; margin-top:0; text-align:center;">🚨 收到新任務單！</h3>',
        '        <p><b>類型：</b><span id="popOrderType" style="color:blue; font-weight:bold;"></span></p>',
        '        <p><b>乘客上車點：</b><span id="addrText" style="font-weight:bold;"></span></p>',
        '        <button id="acceptBtn" class="btn btn-green" style="font-size:18px;">立刻接單 (搶)</button>',
        '    </div>',
        '    ',
        '    ',
        '    <div id="currentMissionSection" class="box" style="display:none; border:2px solid #007bff; background:#f8f9fa;">',
        '        <h3 style="margin-top:0; color:#007bff; text-align:center;">📍 當前執行中任務</h3>',
        '        <p><b>乘客上車點：</b><span id="missionAddr" style="font-weight:bold; color:#333;"></span></p>',
        '        ',
        '        <button onclick="clickNav()" class="btn btn-blue">🧭 開啟 Google Map 導航</button>',
        '        ',
        '        ',
        '        <div id="step1_board" style="margin-top:10px;">',
        '            <button onclick="reportBoarded()" class="btn btn-orange">🙋‍♂️ 客人已上車</button>',
        '        </div>',
        '        <div id="step2_complete" style="margin-top:10px; display:none;">',
        '            <button onclick="showCompleteModal()" class="btn btn-red">🏁 客人已下車 (回報結帳)</button>',
        '        </div>',
        '    </div>',
        '    ',
        '    ',
        '    <div id="completeModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:999; justify-content:center; align-items:center;">',
        '        <div style="background:white; padding:20px; border-radius:10px; width:90%; max-width:360px; text-align:left;">',
        '            <h3 style="margin-top:0;">💵 填寫本趟帳單明細</h3>',
        '            <label><b>本趟車資金額：</b></label>',
        '            <input type="number" id="payAmount" value="150" style="width:100%; padding:8px; margin:5px 0 12px 0;"><br>',
        '            <label><b>付款方式：</b></label>',
        '            <select id="payMethod" style="width:100%; padding:8px; margin:5px 0 12px 0;" onchange="toggleClientNameInput()">',
        '                <option value="現金">💵 現金交易</option>',
        '                <option value="記帳">📝 簽帳/公司記帳</option>',
        '            </select>',
        '            <div id="clientNameDiv" style="display:none;">',
        '                <label><b>記帳客戶公司/名字：</b></label>',
        '                <input type="text" id="clientName" placeholder="請輸入名字" style="width:100%; padding:8px; margin:5px 0 12px 0;">',
        '            </div>',
        '            <button onclick="submitFinishOrder()" class="btn btn-green">確認並送出明細</button>',
        '        </div>',
        '    </div>',
        '    ',
        '    <div id="scheduleSection" class="box" style="display:none;">',
        '        <h3 style="margin-top:0; color:#333; border-bottom:2px solid #6f42c1;">📅 我的預約行程表</h3>',
        '        <div id="scheduleList" style="font-size:14px; color:#555;">暫無已安排行程</div>',
        '    </div>',
        '    ',
        '    <script src="/socket.io/socket.io.js"></script>',
        '    <script>',
        '        const socket = io({ transports: ["polling", "websocket"], autoConnect: true });',
        '        let isOnline = false;',
        '        let watchId = null;',
        '        let currentLat = 0;',
        '        let currentLng = 0;',
        '        let currentActiveMission = null;',
        '        ',
        '        socket.on("login_failed", (data) => { alert("❌ " + data.message); resetToOfflineInfo(); });',
        '        ',
        '        socket.on("login_success", () => {',
        '            isOnline = true;',
        '            document.getElementById("toggleBtn").innerText = "關閉下班 (停止定位)";',
        '            document.getElementById("toggleBtn").className = "btn btn-red";',
        '            document.getElementById("status").innerText = "🟢 線上空車候客中...";',
        '            document.getElementById("status").style.color = "green";',
        '            document.getElementById("plateNum").disabled = true;',
        '            document.getElementById("phoneNum").disabled = true;',
        '            document.getElementById("scheduleSection").style.display = "block";',
        '            requestMySchedule();',
        '        });',
        '        ',
        '        function sendLocationUpdate() {',
        '            const pNum = document.getElementById("plateNum").value.trim();',
        '            const pwd = document.getElementById("phoneNum").value.trim();',
        '            if (pNum && pwd && currentLat && currentLng) {',
        '                socket.emit("driver_location_update", { ',
        '                    plateNumber: pNum, phoneNumber: pwd, lat: currentLat, lng: currentLng ',
        '                });',
        '            }',
        '        }',
        '        ',
        '        function toggleStatus() {',
        '            const pNum = document.getElementById("plateNum").value.trim();',
        '            const pwd = document.getElementById("phoneNum").value.trim();',
        '            if (!pNum || !pwd) { alert("請填寫欄位！"); return; }',
        '            if (!isOnline) {',
        '                if (navigator.geolocation) {',
        '                    navigator.geolocation.getCurrentPosition((position) => {',
        '                        currentLat = position.coords.latitude;',
        '                        currentLng = position.coords.longitude;',
        '                        document.getElementById("gpsDebug").innerText = "GPS定位成功";',
        '                        sendLocationUpdate();',
        '                        watchId = navigator.geolocation.watchPosition((pos) => {',
        '                            currentLat = pos.coords.latitude;',
        '                            currentLng = pos.coords.longitude;',
        '                            sendLocationUpdate();',
        '                        }, null, { enableHighAccuracy: true });',
        '                    }, () => { alert("請開啟GPS定位權限！"); }, { enableHighAccuracy: true });',
        '                }',
        '            } else {',
        '                socket.emit("driver_offline", { plateNumber: pNum });',
        '                resetToOfflineInfo();',
        '            }',
        '        }',
        '        ',
        '        function resetToOfflineInfo() {',
        '            isOnline = false;',
        '            document.getElementById("toggleBtn").innerText = "驗證並開啟上班";',
        '            document.getElementById("toggleBtn").className = "btn btn-green";',
        '            document.getElementById("status").innerText = "🔴 目前下班中 (未定位)";',
        '            document.getElementById("status").style.color = "gray";',
        '            document.getElementById("plateNum").disabled = false;',
        '            document.getElementById("phoneNum").disabled = false;',
        '            document.getElementById("scheduleSection").style.display = "none";',
        '            document.getElementById("currentMissionSection").style.display = "none";',
        '            if (watchId) navigator.geolocation.clearWatch(watchId);',
        '        }',
        '        ',
        '        socket.on("new_order_request", (data) => {',
        '            if(currentActiveMission) return; // 有單在身就不收新單廣播',
        '            document.getElementById("popOrderType").innerText = data.orderType;',
        '            document.getElementById("addrText").innerText = data.targetAddress;',
        '            document.getElementById("pop").style.display = "block";',
        '            ',
        '            document.getElementById("acceptBtn").onclick = function() {',
        '                const pNum = document.getElementById("plateNum").value.trim();',
        '                socket.emit("accept_order", { orderId: data.orderId, plateNumber: pNum, lat: currentLat, lng: currentLng });',
        '            };',
        '        });',
        '        ',
        '        socket.on("accept_result", (data) => {',
        '            document.getElementById("pop").style.display = "none";',
        '            if(data.success) {',
        '                if(data.orderType === "即時單") {',
        '                    currentActiveMission = data.order;',
        '                    document.getElementById("status").innerText = "🚖 任務執行中 (前往上車點)";',
        '                    document.getElementById("status").style.color = "blue";',
        '                    document.getElementById("missionAddr").innerText = data.order.targetAddress;',
        '                    document.getElementById("currentMissionSection").style.display = "block";',
        '                    document.getElementById("step1_board").style.display = "block";',
        '                    document.getElementById("step2_complete").style.display = "none";',
        '                } else {',
        '                    alert("🎉 預約單搶單成功！已排入行程表。");',
        '                }',
        '                requestMySchedule();',
        '            } else {',
        '                alert(data.message);',
        '            }',
        '        });',
        '        ',
        '        function clickNav() {',
        '            if(currentActiveMission) {',
        '                window.open("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(currentActiveMission.targetAddress), "_blank");',
        '            }',
        '        }',
        '        ',
        '        function reportBoarded() {',
        '            socket.emit("driver_report_status", { ',
        '                orderId: currentActiveMission.orderId, ',
        '                status: "旅客已上車",',
        '                plateNumber: document.getElementById("plateNum").value.trim()',
        '            });',
        '            document.getElementById("status").innerText = "🚖 旅客運送中...";',
        '            document.getElementById("step1_board").style.style.display = "none";',
        '            document.getElementById("step1_board").style.display = "none";',
        '            document.getElementById("step2_complete").style.display = "block";',
        '        }',
        '        ',
        '        function showCompleteModal() {',
        '            document.getElementById("completeModal").style.display = "flex";',
        '        }',
        '        function toggleClientNameInput() {',
        '            const m = document.getElementById("payMethod").value;',
        '            document.getElementById("clientNameDiv").style.display = (m === "記帳") ? "block" : "none";',
        '        }',
        '        ',
        '        function submitFinishOrder() {',
        '            const amt = parseInt(document.getElementById("payAmount").value) || 0;',
        '            const method = document.getElementById("payMethod").value;',
        '            const cName = document.getElementById("clientName").value.trim();',
        '            ',
        '            if(method === "記帳" && !cName) { alert("請輸入記帳客戶名稱"); return; }',
        '            ',
        '            socket.emit("driver_finish_order", {',
        '                orderId: currentActiveMission.orderId,',
        '                plateNumber: document.getElementById("plateNum").value.trim(),',
        '                amount: amt,',
        '                payMethod: method,',
        '                clientName: method === "記帳" ? cName : ""',
        '            });',
        '            ',
        '            document.getElementById("completeModal").style.display = "none";',
        '            document.getElementById("currentMissionSection").style.display = "none";',
        '            currentActiveMission = null;',
        '            document.getElementById("status").innerText = "🟢 線上空車候客中...";',
        '            document.getElementById("status").style.color = "green";',
        '        }',
        '        ',
        '        function requestMySchedule() {',
        '            const pNum = document.getElementById("plateNum").value.trim();',
        '            if(pNum) { socket.emit("get_driver_schedule", { plateNumber: pNum }); }',
        '        }',
        '        socket.on("update_schedule_list", (orders) => {',
        '            const listDiv = document.getElementById("scheduleList");',
        '            if(!orders || orders.length === 0) { listDiv.innerHTML = "暫無已安排行程"; return; }',
        '            let h = "";',
        '            orders.forEach(o => {',
        '                h += "<div style=\'background:#f1f3f5; padding:8px; border-left:4px solid purple; margin-top:5px;\'><b>["+o.bookingTime+"]</b> "+o.targetAddress+"</div>";',
        '            });',
        '            listDiv.innerHTML = h;',
        '        });',
        '    </script>',
        '</body>',
        '</html>'
    ];
    res.send(htmlLines.join('\n'));
});

// ─── 📡 核心調度通訊協定 ───
app.post('/api/dispatch', (req, res) => {
    const { targetAddress, targetLat, targetLng, limitCount, orderType, bookingTime } = req.body;
    
    // 過濾出目前「沒在忙碌（isBusy 為 false）」的線上司機來算距離
    let availableDrivers = Object.values(activeDrivers).filter(d => !d.isBusy);
    
    let sortedDrivers = availableDrivers.map(driver => {
        return { ...driver, distance: getDistance(targetLat, targetLng, driver.lat, driver.lng) };
    }).sort((a, b) => a.distance - b.distance);

    let topDrivers = sortedDrivers.slice(0, limitCount);
    
    let orderId = "order_" + Date.now();
    let newOrder = { 
        orderId, targetAddress, targetLat, targetLng, orderType, bookingTime,
        status: "尚未接單", driverId: null, driverName: null, paymentReport: null 
    };
    
    globalOrders.push(newOrder);
    broadcastAdminData();

    if (topDrivers.length === 0) {
        io.emit('admin_notification', { status: "FAILED", message: "廣播失敗：目前沒有任何空車司機在線上！" });
        return res.json({ status: "no_driver" });
    }

    topDrivers.forEach(driver => {
        if (driver.socketId) {
            io.to(driver.socketId).emit('new_order_request', newOrder);
        }
    });

    res.json({ status: "processing", orderId });
});

io.on('connection', (socket) => {
    // 剛連線時，同步一次最新歷史資料給管理者面板
    broadcastAdminData();
    
    socket.on('driver_location_update', (data) => {
        const pNum = data.plateNumber;
        const pPwd = data.phoneNumber;
        const registeredDriver = driverRegistry[pNum];

        if (!registeredDriver || registeredDriver.phone !== pPwd) {
            socket.emit('login_failed', { message: "帳號密碼不正確！" });
            return;
        }

        // 如果原本就存在，保留他的忙碌狀態，只更新 GPS 跟 socketId
        let wasBusy = activeDrivers[pNum] ? activeDrivers[pNum].isBusy : false;

        activeDrivers[pNum] = {
            id: pNum,
            name: registeredDriver.name,
            lat: data.lat,
            lng: data.lng,
            socketId: socket.id,
            isBusy: wasBusy
        };
        socket.emit('login_success');
        broadcastAdminData();
    });

    socket.on('accept_order', (data) => {
        const pNum = data.plateNumber;
        const driverInfo = activeDrivers[pNum];
        // 尋找存在中央總表裡的該筆訂單
        const ord = globalOrders.find(o => o.orderId === data.orderId);

        if (ord && ord.status === "尚未接單") {
            // 💡 關鍵修正：精準拿司機點擊接單那一瞬間回傳的真正 GPS（data.lat/lng）來算實際迎客距離！
            const realDist = getDistance(ord.targetLat, ord.targetLng, data.lat, data.lng);
            const durationEta = calculateETA(realDist);

            ord.status = "前往迎客";
            ord.driverId = pNum;
            ord.driverName = driverInfo.name;
            
            // 將司機設為忙碌中，不接受其他即時單
            driverInfo.isBusy = true;

            if (ord.orderType === "預約單") {
                if (!driverSchedules[pNum]) driverSchedules[pNum] = [];
                driverSchedules[pNum].push(ord);
                driverSchedules[pNum].sort((a,b) => new Date(a.bookingTime) - new Date(b.bookingTime));
            }

            socket.emit('accept_result', { success: true, orderType: ord.orderType, order: ord });
            
            const adminMsg = "【接單成功】司機 " + driverInfo.name + " (" + pNum + ") 已接單！\n" +
                             "📏 司機距乘客: " + realDist.toFixed(2) + " 公里，預計 " + durationEta + " 分鐘後抵達上車點。";
            io.emit('admin_notification', { status: "SUCCESS", message: adminMsg });
            broadcastAdminData();
        } else {
            socket.emit('accept_result', { success: false, message: "手速太慢！單已被搶走或已逾時。" });
        }
    });

    // 司機回報：客人已上車
    socket.on('driver_report_status', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        if(ord) {
            ord.status = data.status;
            broadcastAdminData();
        }
    });

    // 司機回報：客人已下車並填寫帳單
    socket.on('driver_finish_order', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        const driverInfo = activeDrivers[data.plateNumber];
        
        if(ord) {
            ord.status = "行程已完成";
            
            let reportText = "$" + data.amount + " (" + data.payMethod + ")";
            if(data.payMethod === "記帳") {
                reportText += " - 戶名: " + data.clientName;
                // 寫入月結對帳單
                const now = new Date();
                creditLedger.push({
                    time: (now.getMonth()+1) + "/" + now.getDate() + " " + now.getHours() + ":" + now.getMinutes(),
                    driverId: data.plateNumber,
                    driverName: driverInfo ? driverInfo.name : "未知",
                    clientName: data.clientName,
                    amount: data.amount
                });
            }
            ord.paymentReport = reportText;
        }

        // 解除司機忙碌狀態，變回空車
        if(driverInfo) {
            driverInfo.isBusy = false;
        }
        
        broadcastAdminData();
    });

    socket.on('get_driver_schedule', (data) => {
        const pNum = data.plateNumber;
        const list = driverSchedules[pNum] || [];
        socket.emit('update_schedule_list', list);
    });

    socket.on('driver_offline', (data) => {
        delete activeDrivers[data.plateNumber];
        broadcastAdminData();
    });

    socket.on('disconnect', () => {
        setTimeout(() => {
            for (let pNum in activeDrivers) {
                if (activeDrivers[pNum].socketId === socket.id) {
                    delete activeDrivers[pNum];
                    broadcastAdminData();
                }
            }
        }, 10000); 
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('\n🚀 全功能智慧派車調度中心大腦已正式開機！');
});
