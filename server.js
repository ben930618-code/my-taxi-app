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

// ─── 💾 系統中央資料庫 ───
// 司機名冊資料庫（role: 'cadre' 為幹部，'driver' 為一般司機）
let driverRegistry = {
    'ABC-1234': { name: '幹部張三', phone: '111', role: 'cadre' },
    'XYZ-5678': { name: '幹部李四', phone: '222', role: 'cadre' },
    'TAXI-001': { name: '司機小明', phone: '333', role: 'driver' },
    'TAXI-002': { name: '司機小華', phone: '444', role: 'driver' }
};

let currentDutyPlate = 'ABC-1234'; // 當前值班幹部

let clientRegistry = [
    { id: 'client_1', name: '大發貿易公司' },
    { id: 'client_2', name: '鴻海科技經理' }
];

let activeDrivers = {};      // 線上司機動態定位與狀態
let globalOrders = [];       // 中央訂單總表
let creditLedger = [];       // 月結記帳總帳本

// ─── 🧮 數學計算 ───
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
    let durationMinutes = (distanceInKm / averageSpeedKmh) * 60 + (distanceInKm * 1.5); 
    return Math.max(3, Math.round(durationMinutes));
}

// 核心：推播更新給管理者
function broadcastAdminData() {
    io.emit('admin_update_data', {
        orders: globalOrders,
        drivers: Object.values(activeDrivers),
        ledger: creditLedger,
        driverRegistry: driverRegistry,
        clientRegistry: clientRegistry,
        currentDutyPlate: currentDutyPlate
    });
}

// 核心：推播更新給司機端
function broadcastToDrivers() {
    io.emit('driver_update_lists', { clientRegistry, currentDutyPlate });
    io.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate });
}

// ⚙️ 核心邏輯：啟動訂單倒數計時炸彈（2分鐘轉一般，再2分鐘轉外部）
function startOrderTimers(orderId) {
    // 1. 第一顆炸彈：2 分鐘後自動從「幹部優先」下放到「開放一般司機搶單」
    setTimeout(() => {
        const ord = globalOrders.find(o => o.orderId === orderId);
        if (ord && ord.status === "幹部審核優先中") {
            ord.status = "開放一般司機搶單";
            broadcastAdminData();
            broadcastToDrivers();

            // 📢 既然開放了一般司機，立刻幫沒在忙的一般司機跳出廣播強彈窗
            Object.values(activeDrivers).forEach(driver => {
                let regInfo = driverRegistry[driver.id];
                if (regInfo && regInfo.role === 'driver' && !driver.isBusy) {
                    io.to(driver.socketId).emit('new_order_request', { ...ord, forRole: 'driver' });
                }
            });

            // 2. 第二顆炸彈：下放一般司機後，再過 2 分鐘（累計4分鐘）如果還是無人承接，直接拋出外部
            setTimeout(() => {
                const reCheckOrd = globalOrders.find(o => o.orderId === orderId);
                if (reCheckOrd && (reCheckOrd.status === "開放一般司機搶單" || reCheckOrd.status === "幹部審核優先中")) {
                    reCheckOrd.status = "⚠️ 2分逾時-已轉傳外部群組";
                    broadcastAdminData();
                    broadcastToDrivers();
                }
            }, 120000); // 一般司機池的 2 分鐘
        }
    }, 120000); // 幹部優先池的 2 分鐘
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
        '        .bg-gray { background: #6c757d; } .bg-blue { background: #007bff; } .bg-orange { background: #fd7e14; } .bg-green { background: #28a745; } .bg-purple { background: #6f42c1; } .bg-red { background: #dc3545; }',
        '        .inp { width: 100%; padding: 8px; box-sizing: border-box; margin-top: 4px; }',
        '    </style>',
        '</head>',
        '<body>',
        '    <div class="card">',
        '        <h2>🚨 管理者發送新派單 (預設進入幹部優先池)</h2>',
        '        <div style="margin-bottom:12px;">',
        '            <label><b>1. 訂單類型:</b></label>',
        '            <select id="orderType" class="inp" onchange="toggleTimeInput()">',
        '                <option value="即時單">⚡ 即時派單 (立刻用車)</option>',
        '                <option value="預約單">📅 預約派單 (指定時間)</option>',
        '            </select>',
        '        </div>',
        '        <div id="bookingTimeDiv" style="display:none; margin-bottom:12px; background:#e9ecef; padding:10px; border-radius:5px;">',
        '            <label>預約用車時間:</label>',
        '            <input type="datetime-local" id="bookingTime" class="inp">',
        '        </div>',
        '        <div style="margin-bottom:12px;">',
        '            <label><b>2. 上車地址：</b></label>',
        '            <input type="text" id="addr" value="桃園市桃園區中正路1號" class="inp">',
        '        </div>',
        '        <div style="display:flex; gap:10px; margin-bottom:12px;">',
        '            <div style="flex:1;">',
        '                <label>緯度：</label>',
        '                <input type="number" id="lat" value="24.9936" step="0.0001" class="inp">',
        '            </div>',
        '            <div style="flex:1;">',
        '                <label>經度：</label>',
        '                <input type="number" id="lng" value="121.3130" step="0.0001" class="inp">',
        '            </div>',
        '        </div>',
        '        <button onclick="sendOrder()" style="width:100%; padding:12px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px; cursor:pointer;">建立訂單 (送入車隊池)</button>',
        '    </div>',
        '    ',
        '    <div class="card">',
        '        <h3>🚖 線上司機即時動態 (幹部與值班切換)</h3>',
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
        '                <tbody id="orderTableBody"></tbody>',
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
        '                    <tr><th>結帳時間</th><th>車牌/司機</th><th>客戶名稱</th><th>金額</th></tr>',
        '                </thead>',
        '                <tbody id="ledgerTableBody"></tbody>',
        '            </table>',
        '        </div>',
        '    </div>',
        '    ',
        '    <div class="card" style="border: 2px solid #6c757d;">',
        '        <h3>⚙️ 系統名單與身分設定</h3>',
        '        <div style="display:flex; gap:20px; flex-wrap: wrap;">',
        '            <div style="flex:1; min-width:240px; background:#f8f9fa; padding:12px; border-radius:6px;">',
        '                <h4>➕ 新增司機/幹部帳號</h4>',
        '                <input type="text" id="newPlate" placeholder="車牌號碼" style="width:100%; padding:6px; margin-bottom:6px;"><br>',
        '                <input type="text" id="newName" placeholder="姓名" style="width:100%; padding:6px; margin-bottom:6px;"><br>',
        '                <input type="text" id="newPhone" placeholder="手機號碼/密碼" style="width:100%; padding:6px; margin-bottom:6px;"><br>',
        '                <select id="newRole" style="width:100%; padding:6px; margin-bottom:10px;">',
        '                    <option value="driver">一般司機</option>',
        '                    <option value="cadre">車隊幹部</option>',
        '                </select><br>',
        '                <button onclick="addDriver()" style="background:green; color:white; border:none; padding:8px 12px; cursor:pointer; font-weight:bold;">確認新增</button>',
        '                <div style="margin-top:10px; font-size:12px; color:gray;" id="registryDriversList"></div>',
        '            </div>',
        '            ',
        '            <div style="flex:1; min-width:240px; background:#f8f9fa; padding:12px; border-radius:6px;">',
        '                <h4>➕ 新增月結客戶</h4>',
        '                <input type="text" id="newClientName" placeholder="客戶公司名稱" style="width:100%; padding:6px; margin-bottom:10px;"><br>',
        '                <button onclick="addClient()" style="background:purple; color:white; border:none; padding:8px 12px; cursor:pointer; font-weight:bold;">確認新增</button>',
        '                <div style="margin-top:10px; font-size:12px; color:gray;" id="registryClientsList"></div>',
        '            </div>',
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
        '                    orderType: type,',
        '                    bookingTime: bTime',
        '                })',
        '            });',
        '        }',
        '        ',
        '        function setDuty(plate) {',
        '            socket.emit("admin_set_duty", { plate });',
        '        }',
        '        ',
        '        function addDriver() {',
        '            const plate = document.getElementById("newPlate").value.trim().toUpperCase();',
        '            const name = document.getElementById("newName").value.trim();',
        '            const phone = document.getElementById("newPhone").value.trim();',
        '            const role = document.getElementById("newRole").value;',
        '            if(!plate || !name || !phone) { alert("請填齊資料"); return; }',
        '            socket.emit("admin_add_driver", { plate, name, phone, role });',
        '            document.getElementById("newPlate").value=""; document.getElementById("newName").value=""; document.getElementById("newPhone").value="";',
        '        }',
        '        ',
        '        function addClient() {',
        '            const name = document.getElementById("newClientName").value.trim();',
        '            if(!name) return;',
        '            socket.emit("admin_add_client", { name });',
        '            document.getElementById("newClientName").value = "";',
        '        }',
        '        ',
        '        socket.on("admin_update_data", (data) => {',
        '            // 渲染線上司機與設為值班按鈕',
        '            const drDiv = document.getElementById("driverStatusDiv");',
        '            if(data.drivers.length === 0) {',
        '                drDiv.innerHTML = "<span style=\'color:gray;\'>目前沒有司機上線</span>";',
        '            } else {',
        '                let drHtml = "";',
        '                data.drivers.forEach(d => {',
        '                    let isCadre = data.driverRegistry[d.id]?.role === "cadre";',
        '                    let roleTag = isCadre ? "<b style=\'color:purple;\'>[車隊幹部]</b>" : "[一般司機]";',
        '                    let dutyBtn = "";',
        '                    if(isCadre) {',
        '                        if(data.currentDutyPlate === d.id) {',
        '                            dutyBtn = " <span style=\'background:green; color:white; padding:2px 6px; border-radius:3px; font-size:12px;\'>[🟢 當值中]</span>";',
        '                        } else {',
        '                            dutyBtn = " <button onclick=\\"setDuty(\'" + d.id + "\')\\" style=\'font-size:11px; cursor:pointer;\'>設為今日值班</button>";',
        '                        }',
        '                    }',
        '                    let statusBadge = d.isBusy ? "<span style=\'color:red;\'>[🔴 任務中]</span>" : "<span style=\'color:green;\'>[🟢 空車]</span>";',
        '                    drHtml += "<div style=\'padding:6px 0; border-bottom:1px dashed #eee;\'>🚗 <b>" + d.name + " (" + d.id + ")</b> " + roleTag + " - " + statusBadge + dutyBtn + "</div>";',
        '                });',
        '                drDiv.innerHTML = drHtml;',
        '            }',
        '            ',
        '            // 渲染訂單',
        '            const oBody = document.getElementById("orderTableBody");',
        '            if(data.orders.length === 0) {',
        '                oBody.innerHTML = "<tr><td colspan=\'5\' style=\'text-align:center; color:gray;\'>暫無派單紀錄</td></tr>";',
        '            } else {',
        '                let oHtml = "";',
        '                data.orders.slice().reverse().forEach(o => {',
        '                    let statusStr = `<span class="badge bg-gray">${o.status}</span>`;',
        '                    if(o.status === "幹部審核優先中") statusStr = "<span class=\'badge bg-purple\'>幹部優先(剩餘2分)</span>";',
        '                    if(o.status === "開放一般司機搶單") statusStr = "<span class=\'badge bg-blue\'>一般司機搶單中</span>";',
        '                    if(o.status === "前往迎客") statusStr = `<span class="badge bg-blue">前往迎客 (${o.eta || "?"}分)</span>`;',
        '                    if(o.status === "旅客已上車") statusStr = "<span class=\'badge bg-orange\'>旅客已上車</span>";',
        '                    if(o.status === "行程已完成") statusStr = "<span class=\'badge bg-green\'>行程已完成</span>";',
        '                    if(o.status.includes("2分逾時")) statusStr = `<span class="badge bg-red">${o.status}</span>`;',
        '                    ',
        '                    oHtml += "<tr>" +',
        '                        "<td>" + o.bookingTime + "<br><small>(" + o.orderType + ")</small></td>" +',
        '                        "<td>" + o.targetAddress + "</td>" +',
        '                        "<td>" + (o.driverName ? o.driverName : "-") + "</td>" +',
        '                        "<td>" + statusStr + "</td>" +',
        '                        "<td>" + (o.paymentReport || "-") + "</td>" +',
        '                    "</tr>";',
        '                });',
        '                oBody.innerHTML = oHtml;',
        '            }',
        '            ',
        '            // 渲染月結帳目',
        '            let totalSum = 0; let lHtml = "";',
        '            data.ledger.forEach(l => { totalSum += l.amount; lHtml += `<tr><td>${l.time}</td><td>${l.driverId}</td><td><b>${l.clientName}</b></td><td>$${l.amount}</td></tr>`; });',
        '            document.getElementById("ledgerTableBody").innerHTML = lHtml || "<tr><td colspan=\'4\' style=\'text-align:center;\'>暫無紀錄</td></tr>";',
        '            document.getElementById("ledgerTotal").innerText = totalSum;',
        '            ',
        '            // 名冊列表',
        '            let dList = ""; for(let k in data.driverRegistry) { dList += `• ${k} (${data.driverRegistry[k].name}) [${data.driverRegistry[k].role === "cadre"?"幹部":"司機"}]<br>`; }',
        '            document.getElementById("registryDriversList").innerHTML = dList;',
        '            let cList = ""; data.clientRegistry.forEach(c => { cList += `• ${c.name}<br>`; });',
        '            document.getElementById("registryClientsList").innerHTML = cList;',
        '        });',
        '    </script>',
        '</body>',
        '</html>'
    ];
    res.send(htmlLines.join('\n'));
});

// ─── 🚖 司機與幹部端網頁 ───
app.get('/driver', (req, res) => {
    const htmlLines = [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '    <title>車隊工作台系統</title>',
        '    <meta name="viewport" content="width=device-width, initial-scale=1">',
        '    <style>',
        '        body { font-family: sans-serif; padding: 15px; max-width: 500px; margin: auto; text-align: center; background: #fafafa; }',
        '        .box { background: white; padding: 18px; border-radius: 10px; border: 1px solid #eee; margin-bottom: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.02); text-align: left; }',
        '        .btn { padding: 12px; font-size: 16px; font-weight: bold; border: none; border-radius: 5px; width: 100%; cursor: pointer; color: white; margin-top: 10px; }',
        '        .btn-green { background: #28a745; } .btn-red { background: #dc3545; } .btn-blue { background: #007bff; } .btn-orange { background: #fd7e14; } .btn-purple { background: #6f42c1; }',
        '        .btn-small { padding: 6px 12px; font-size: 13px; width: auto; margin-right: 5px; margin-top: 5px;}',
        '    </style>',
        '</head>',
        '<body>',
        '    <h2>🚖 車隊工作台系統</h2>',
        '    ',
        '    <div id="loginSection" class="box">',
        '        <h3 style="margin-top:0; text-align:center;">🔐 身分驗證上線</h3>',
        '        <label><b>車牌號碼:</b></label>',
        '        <input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;">',
        '        <label><b>密碼 (手機):</b></label>',
        '        <input type="password" id="phoneNum" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;">',
        '        <button id="toggleBtn" onclick="toggleStatus()" class="btn btn-green">驗證並開啟上班</button>',
        '    </div>',
        '    ',
        '    <div id="status" style="font-size:18px; color:gray; margin:15px; font-weight:bold;">🔴 目前下班中 (未定位)</div>',
        '    <div id="roleTag" style="font-size:14px; color:purple; margin-bottom:10px; font-weight:bold;"></div>',
        '    ',
        '    ',
        '    <div id="cadreDashboard" class="box" style="display:none; border: 2px solid #6f42c1; background: #fdfbfe;">',
        '        <h3 style="margin-top:0; color:#6f42c1;">👑 幹部調度查閱大盤 (前2分限幹部)</h3>',
        '        <div id="cadreOrderList" style="font-size:14px; color:#333;">讀取中...</div>',
        '    </div>',
        '    ',
        '    ',
        '    <div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-bottom:15px; text-align:left;">',
        '        <h3 style="color:#856404; margin-top:0; text-align:center;">🚨 收到任務搶單廣播！</h3>',
        '        <p><b>單類：</b><span id="popOrderType" style="color:blue; font-weight:bold;"></span></p>',
        '        <p><b>乘客上車點：</b><span id="addrText" style="font-weight:bold;"></span></p>',
        '        <button id="acceptBtn" class="btn btn-green" style="font-size:18px;">立刻按此接單 (搶)</button>',
        '    </div>',
        '    ',
        '    ',
        '    <div id="currentMissionSection" class="box" style="display:none; border:2px solid #007bff; background:#f8f9fa;">',
        '        <h3 style="margin-top:0; color:#007bff; text-align:center;">📍 當前執行中任務</h3>',
        '        <p><b>上車點：</b><span id="missionAddr" style="font-weight:bold;"></span></p>',
        '        <p id="missionEtaRow" style="color:red; font-weight:bold;"></p>',
        '        ',
        '        <button onclick="clickNav()" class="btn btn-blue">🧭 開啟 Google Map 導航</button>',
        '        ',
        '        <div id="step1_board" style="margin-top:10px;">',
        '            <button onclick="reportBoarded()" class="btn btn-orange" style="margin-bottom:8px;">🙋‍♂️ 客人已上車</button>',
        '            ',
        '            <button onclick="cancelMyOrder()" class="btn btn-red" style="padding:8px; font-size:14px;">🚨 我有急事/取消接單(退單)</button>',
        '        </div>',
        '        <div id="step2_complete" style="margin-top:10px; display:none;"><button onclick="showCompleteModal()" class="btn btn-red">🏁 客人已下車 (結帳)</button></div>',
        '    </div>',
        '    ',
        '    <div id="scheduleSection" class="box" style="display:none;">',
        '        <h3 style="margin-top:0; color:#333; border-bottom:2px solid #6f42c1;">📅 全區可接單清單 (包含未接預約單)</h3>',
        '        <div id="scheduleList" style="font-size:14px; color:#555;">暫無可接訂單</div>',
        '    </div>',
        '    ',
        '    ',
        '    <div id="completeModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:999; justify-content:center; align-items:center;">',
        '        <div style="background:white; padding:20px; border-radius:10px; width:90%; max-width:360px; text-align:left;">',
        '            <h3 style="margin-top:0; text-align:center;">💵 填寫本趟帳單明細</h3>',
        '            <label><b>金額：</b></label><input type="number" id="payAmount" value="150" style="width:100%; padding:10px; margin:5px 0 12px 0;"><br>',
        '            <label><b>付款方式：</b></label>',
        '            <select id="payMethod" style="width:100%; padding:10px; margin:5px 0 12px 0;" onchange="toggleClientSelect()">',
        '                <option value="現金">💵 現金交易</option>',
        '                <option value="記帳">📝 簽帳 / 公司記帳</option>',
        '            </select>',
        '            <div id="clientSelectDiv" style="display:none; background:#f1f3f5; padding:10px; border-radius:5px; margin-bottom:12px;">',
        '                <label><b>選擇月結客戶：</b></label><select id="clientSelect" style="width:100%; padding:8px; margin-top:5px;"></select>',
        '            </div>',
        '            <button onclick="submitFinishOrder()" class="btn btn-green">確認並送出明細</button>',
        '        </div>',
        '    </div>',
        '    ',
        '    <script src="/socket.io/socket.io.js"></script>',
        '    <script>',
        '        const socket = io({ transports: ["polling", "websocket"], autoConnect: true });',
        '        let isOnline = false; let watchId = null;',
        '        let currentLat = 0; let currentLng = 0; let currentActiveMission = null;',
        '        let clientListMemory = []; myRole = "driver"; myPlate = "";',
        '        ',
        '        socket.on("login_failed", (data) => { alert(data.message); resetToOfflineInfo(); });',
        '        ',
        '        socket.on("login_success", (data) => {',
        '            isOnline = true; myRole = data.role; myPlate = document.getElementById("plateNum").value.trim().toUpperCase();',
        '            document.getElementById("toggleBtn").innerText = "關閉下班 (停止定位)";',
        '            document.getElementById("toggleBtn").className = "btn btn-red";',
        '            document.getElementById("status").innerText = "🟢 線上空車候客中...";',
        '            document.getElementById("status").style.color = "green";',
        '            document.getElementById("plateNum").disabled = true; document.getElementById("phoneNum").disabled = true;',
        '            ',
        '            let roleStr = (myRole === "cadre") ? "【👑 車隊幹部】" : "【🚖 一般司機】";',
        '            if(data.isDuty) { roleStr += " ⭐ 今日值班幹部"; }',
        '            document.getElementById("roleTag").innerText = roleStr;',
        '            ',
        '            if(myRole === "cadre") { document.getElementById("cadreDashboard").style.display = "block"; }',
        '            document.getElementById("scheduleSection").style.display = "block";',
        '            socket.emit("get_available_orders");',
        '        });',
        '        ',
        '        function sendLocationUpdate() {',
        '            const pNum = document.getElementById("plateNum").value.trim();',
        '            const pwd = document.getElementById("phoneNum").value.trim();',
        '            if (pNum && pwd && currentLat && currentLng) {',
        '                socket.emit("driver_location_update", { plateNumber: pNum, phoneNumber: pwd, lat: currentLat, lng: currentLng });',
        '            }',
        '        }',
        '        ',
        '        function toggleStatus() {',
        '            if (!isOnline) {',
        '                if (navigator.geolocation) {',
        '                    navigator.geolocation.getCurrentPosition((position) => {',
        '                        currentLat = position.coords.latitude; currentLng = position.coords.longitude;',
        '                        sendLocationUpdate();',
        '                        watchId = navigator.geolocation.watchPosition((pos) => {',
        '                            currentLat = pos.coords.latitude; currentLng = pos.coords.longitude; sendLocationUpdate();',
        '                        }, null, { enableHighAccuracy: true });',
        '                    }, () => { alert("請開啟GPS定位權限！"); }, { enableHighAccuracy: true });',
        '                }',
        '            } else {',
        '                socket.emit("driver_offline", { plateNumber: document.getElementById("plateNum").value.trim() });',
        '                resetToOfflineInfo();',
        '            }',
        '        }',
        '        ',
        '        function resetToOfflineInfo() {',
        '            isOnline = false; document.getElementById("toggleBtn").innerText = "驗證並開啟上班";',
        '            document.getElementById("toggleBtn").className = "btn btn-green";',
        '            document.getElementById("status").innerText = "🔴 目前下班中 (未定位)";',
        '            document.getElementById("roleTag").innerText = "";',
        '            document.getElementById("cadreDashboard").style.display = "none";',
        '            document.getElementById("scheduleSection").style.display = "none";',
        '            document.getElementById("currentMissionSection").style.display = "none";',
        '            if (watchId) navigator.geolocation.clearWatch(watchId);',
        '        }',
        '        ',
        '        socket.on("driver_update_lists", (data) => {',
        '            clientListMemory = data.clientRegistry || [];',
        '            const select = document.getElementById("clientSelect"); select.innerHTML = "";',
        '            clientListMemory.forEach(c => { let opt = document.createElement("option"); opt.value = c.name; opt.innerText = c.name; select.appendChild(opt); });',
        '        });',
        '        ',
        '        socket.on("sync_orders_to_driver", (data) => {',
        '            if(!isOnline) return;',
        '            // 1. 幹部大盤',
        '            if(myRole === "cadre") {',
        '                let html = "";',
        '                data.orders.forEach(o => {',
        '                    let opBtns = "";',
        '                    if(o.status === "幹部審核優先中" && data.currentDutyPlate === myPlate) {',
        '                        opBtns = ` <button class="btn-small btn-blue" onclick="cadreReleaseDirectly(\'${o.orderId}\')">提前放給一般司機</button>`;',
        '                    }',
        '                    html += `<div style="border-bottom:1px solid #eee; padding:6px 0;">⏰ <b>${o.bookingTime}</b> (${o.orderType})<br>📍 ${o.targetAddress}<br>狀態: <span style="color:purple;font-weight:bold;">${o.status}</span>${opBtns}</div>`;',
        '                });',
        '                document.getElementById("cadreOrderList").innerHTML = html || "當前無任何訂單";',
        '            }',
        '            ',
        '            // 2. 全區可接清單（一般司機前 2 分鐘會被自動過濾隔離，完全看不到）',
        '            const listDiv = document.getElementById("scheduleList");',
        '            let filterOrders = data.orders.filter(o => {',
        '                if(["行程已完成", "前往迎客", "旅客已上車"].includes(o.status)) return false;',
        '                if(myRole === "driver" && o.status === "幹部審核優先中") return false;',
        '                return true;',
        '            });',
        '            ',
        '            if(filterOrders.length === 0) { listDiv.innerHTML = "暫無可接訂單"; return; }',
        '            let h = "";',
        '            filterOrders.forEach(o => {',
        '                let typeTag = o.orderType === "預約單" ? `<b style="color:purple;">[📅預約]</b>` : `<b>[⚡即時]</b>`;',
        '                let takeBtn = `<button class="btn-small btn-green" onclick="clickTakeOrder(\'${o.orderId}\')">手動接此單</button>`;',
        '                h += `<div style="background:#f1f3f5; padding:8px; border-left:4px solid #007bff; margin-top:5px;">${typeTag} <b>[${o.bookingTime}]</b> ${o.targetAddress}<br>狀態: ${o.status} ${takeBtn}</div>`;',
        '            });',
        '            listDiv.innerHTML = h;',
        '        });',
        '        ',
        '        function cadreReleaseDirectly(orderId) {',
        '            socket.emit("cadre_release_force", { orderId, plateNumber: myPlate });',
        '        }',
        '        function clickTakeOrder(orderId) {',
        '            socket.emit("accept_order", { orderId, plateNumber: myPlate, lat: currentLat, lng: currentLng });',
        '        }',
        '        ',
        '        socket.on("new_order_request", (data) => {',
        '            if(currentActiveMission) return;',
        '            if(data.forRole === "cadre" && myRole !== "cadre") return;',
        '            document.getElementById("popOrderType").innerText = data.orderType;',
        '            document.getElementById("addrText").innerText = data.targetAddress;',
        '            document.getElementById("pop").style.display = "block";',
        '            document.getElementById("acceptBtn").onclick = function() {',
        '                socket.emit("accept_order", { orderId: data.orderId, plateNumber: myPlate, lat: currentLat, lng: currentLng });',
        '            };',
        '        });',
        '        ',
        '        socket.on("accept_result", (data) => {',
        '            document.getElementById("pop").style.display = "none";',
        '            if(data.success) {',
        '                currentActiveMission = data.order;',
        '                document.getElementById("status").innerText = "🚖 任務執行中 (前往上車點)";',
        '                document.getElementById("status").style.color = "blue";',
        '                document.getElementById("missionAddr").innerText = data.order.targetAddress;',
        '                document.getElementById("missionEtaRow").innerText = "⏳ 預計 " + (data.eta || "?") + " 分鐘後抵達上車地址";',
        '                document.getElementById("currentMissionSection").style.display = "block";',
        '                document.getElementById("step1_board").style.display = "block";',
        '                document.getElementById("step2_complete").style.display = "none";',
        '            } else { alert(data.message); }',
        '            socket.emit("get_available_orders");',
        '        });',
        '        ',
        '        // ⚡ 司機取消接單(退單)點擊事件',
        '        function cancelMyOrder() {',
        '            if(!currentActiveMission) return;',
        '            if(confirm("确定要取消這筆接單任務嗎？(此單會釋放重新回滾入派單池)")) {',
        '                socket.emit("driver_cancel_order", {',
        '                    orderId: currentActiveMission.orderId,',
        '                    plateNumber: myPlate',
        '                });',
        '                // 重置介面',
        '                document.getElementById("currentMissionSection").style.display = "none";',
        '                currentActiveMission = null;',
        '                document.getElementById("status").innerText = "🟢 線上空車候客中...";',
        '                document.getElementById("status").style.color = "green";',
        '            }',
        '        }',
        '        ',
        '        function clickNav() { if(currentActiveMission) window.open("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(currentActiveMission.targetAddress), "_blank"); }',
        '        function reportBoarded() {',
        '            socket.emit("driver_report_status", { orderId: currentActiveMission.orderId, status: "旅客已上車", plateNumber: myPlate });',
        '            document.getElementById("status").innerText = "🚖 旅客運送中...";',
        '            document.getElementById("step1_board").style.display = "none"; document.getElementById("step2_complete").style.display = "block";',
        '        }',
        '        function showCompleteModal() { document.getElementById("completeModal").style.display = "flex"; }',
        '        function toggleClientSelect() { document.getElementById("clientSelectDiv").style.display = (document.getElementById("payMethod").value === "記帳") ? "block" : "none"; }',
        '        ',
        '        function submitFinishOrder() {',
        '            const amt = parseInt(document.getElementById("payAmount").value) || 0; const method = document.getElementById("payMethod").value;',
        '            let chosenClient = (method === "記帳") ? document.getElementById("clientSelect").value : "";',
        '            if(method === "記帳" && !chosenClient) { alert("請選擇月結客戶"); return; }',
        '            ',
        '            socket.emit("driver_finish_order", { orderId: currentActiveMission.orderId, plateNumber: myPlate, amount: amt, payMethod: method, clientName: chosenClient });',
        '            document.getElementById("completeModal").style.display = "none"; document.getElementById("currentMissionSection").style.display = "none";',
        '            currentActiveMission = null; document.getElementById("status").innerText = "🟢 線上空車候客中..."; document.getElementById("status").style.color = "green";',
        '        }',
        '    </script>',
        '</body>',
        '</html>'
    ];
    res.send(htmlLines.join('\n'));
});

// ─── 📡 API 派單起點 ───
app.post('/api/dispatch', (req, res) => {
    const { targetAddress, targetLat, targetLng, orderType, bookingTime } = req.body;
    let orderId = "order_" + Date.now();
    
    // 💡 預設新建立的單一律進入「幹部審核優先中」
    let newOrder = { 
        orderId, targetAddress, targetLat, targetLng, orderType, bookingTime,
        status: "幹部審核優先中", driverId: null, driverName: null, paymentReport: null, eta: null,
        createdAt: Date.now() // 記下出生時間，退單時判斷是否滿2分鐘
    };
    
    globalOrders.push(newOrder);
    broadcastAdminData();
    broadcastToDrivers();

    // ⚡ 強制彈窗推播：前 2 分鐘只發給「線上的全體幹部」
    Object.values(activeDrivers).forEach(driver => {
        let registryInfo = driverRegistry[driver.id];
        if (registryInfo && registryInfo.role === 'cadre' && !driver.isBusy) {
            io.to(driver.socketId).emit('new_order_request', { ...newOrder, forRole: 'cadre' });
        }
    });

    // ⏱️ 開啟中央自動計時炸彈流程
    startOrderTimers(orderId);

    res.json({ status: "processing", orderId });
});

// ─── 📡 Socket 中央動態通訊 ───
io.on('connection', (socket) => {
    broadcastAdminData();
    socket.emit('driver_update_lists', { clientRegistry, currentDutyPlate });
    
    socket.on('get_available_orders', () => {
        socket.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate });
    });

    socket.on('admin_set_duty', (data) => {
        currentDutyPlate = data.plate;
        broadcastAdminData();
        broadcastToDrivers();
    });

    socket.on('admin_add_driver', (data) => {
        driverRegistry[data.plate] = { name: data.name, phone: data.phone, role: data.role };
        broadcastAdminData();
        broadcastToDrivers();
    });

    socket.on('admin_add_client', (data) => {
        clientRegistry.push({ id: 'client_' + Date.now(), name: data.name });
        broadcastAdminData();
        broadcastToDrivers();
    });

    socket.on('driver_location_update', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const registeredDriver = driverRegistry[pNum];

        if (!registeredDriver || registeredDriver.phone !== data.phoneNumber) {
            socket.emit('login_failed', { message: "車牌或密碼不正確！" });
            return;
        }

        let wasBusy = activeDrivers[pNum] ? activeDrivers[pNum].isBusy : false;
        activeDrivers[pNum] = { id: pNum, name: registeredDriver.name, lat: data.lat, lng: data.lng, socketId: socket.id, isBusy: wasBusy };
        
        socket.emit('login_success', { role: registeredDriver.role, isDuty: (currentDutyPlate === pNum) });
        socket.emit('driver_update_lists', { clientRegistry, currentDutyPlate });
        socket.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate });
        broadcastAdminData();
    });

    // 👑 值班幹部在後台大盤覺得不用等了，一鍵手動下放
    socket.on('cadre_release_force', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        if (ord && ord.status === "幹部審核優先中") {
            ord.status = "開放一般司機搶單";
            broadcastAdminData();
            broadcastToDrivers();

            Object.values(activeDrivers).forEach(driver => {
                let regInfo = driverRegistry[driver.id];
                if (regInfo && regInfo.role === 'driver' && !driver.isBusy) {
                    io.to(driver.socketId).emit('new_order_request', { ...ord, forRole: 'driver' });
                }
            });
        }
    });

    // 🚖 司機或幹部點擊搶單
    socket.on('accept_order', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const driverInfo = activeDrivers[pNum];
        const ord = globalOrders.find(o => o.orderId === data.orderId);

        if (ord && ["幹部審核優先中", "開放一般司機搶單"].includes(ord.status)) {
            let regInfo = driverRegistry[pNum];
            // 防偷跑：如果是普通司機，想要強按「幹部審核優先中」的單，予以拒絕
            if(regInfo.role === 'driver' && ord.status === "幹部審核優先中") {
                socket.emit('accept_result', { success: false, message: "此單目前還在【幹部2分鐘優先池】內，一般司機暫時無法搶單。" });
                return;
            }

            const realDist = getDistance(ord.targetLat, ord.targetLng, data.lat, data.lng);
            const durationEta = calculateETA(realDist);

            ord.status = "前往迎客";
            ord.driverId = pNum;
            ord.driverName = driverInfo.name;
            ord.eta = durationEta;
            
            driverInfo.isBusy = true; // 鎖定司機變紅燈

            socket.emit('accept_result', { success: true, order: ord, eta: durationEta });
            broadcastAdminData();
            broadcastToDrivers();
        } else {
            socket.emit('accept_result', { success: false, message: "單已被搶走、取消或已被拋出外部。" });
        }
    });

    // ⚡ 核心追加：司機中途有急事取消接單(退單)事件
    socket.on('driver_cancel_order', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        const driverInfo = activeDrivers[pNum];

        if(ord && ord.driverId === pNum) {
            // 1. 將司機釋放，變回🟢空車
            if(driverInfo) driverInfo.isBusy = false;

            // 2. 計算這筆單到現在過了幾分鐘
            const timeElapsed = Date.now() - ord.createdAt;
            
            if (timeElapsed < 120000) {
                // 如果在2分鐘內退單，訂單重回「幹部審核優先中」
                ord.status = "幹部審核優先中";
                ord.driverId = null; ord.driverName = null; ord.eta = null;
                
                // 重新通知線上幹部彈窗
                Object.values(activeDrivers).forEach(driver => {
                    let regInfo = driverRegistry[driver.id];
                    if (regInfo && regInfo.role === 'cadre' && !driver.isBusy) {
                        io.to(driver.socketId).emit('new_order_request', { ...ord, forRole: 'cadre' });
                    }
                });
            } else {
                // 如果已經建立超過2分鐘才被退單，直接開放給一般司機搶
                ord.status = "開放一般司機搶單";
                ord.driverId = null; ord.driverName = null; ord.eta = null;

                // 通知線上一般司機彈窗
                Object.values(activeDrivers).forEach(driver => {
                    let regInfo = driverRegistry[driver.id];
                    if (regInfo && regInfo.role === 'driver' && !driver.isBusy) {
                        io.to(driver.socketId).emit('new_order_request', { ...ord, forRole: 'driver' });
                    }
                });
            }

            // 3. 重新為這張被退回的單開啟倒數計時炸彈（防止退單後單卡死）
            startOrderTimers(ord.orderId);

            // 全端重新渲染
            broadcastAdminData();
            broadcastToDrivers();
        }
    });

    socket.on('driver_report_status', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        if(ord) { ord.status = data.status; broadcastAdminData(); }
    });

    socket.on('driver_finish_order', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        const driverInfo = activeDrivers[data.plateNumber.toUpperCase()];
        
        if(ord) {
            ord.status = "行程已完成";
            let reportText = "$" + data.amount + " (" + data.payMethod + ")";
            if(data.payMethod === "記帳") {
                reportText += " - 戶名: " + data.clientName;
                const now = new Date();
                creditLedger.push({
                    time: (now.getMonth()+1) + "/" + now.getDate() + " " + String(now.getHours()).padStart(2,'0') + ":" + String(now.getMinutes()).padStart(2,'0'),
                    driverId: data.plateNumber.toUpperCase(), driverName: driverInfo? driverInfo.name : "未知", clientName: data.clientName, amount: data.amount
                });
            }
            ord.paymentReport = reportText;
        }
        if(driverInfo) driverInfo.isBusy = false;
        broadcastAdminData();
        broadcastToDrivers();
    });

    socket.on('driver_offline', (data) => {
        delete activeDrivers[data.plateNumber.toUpperCase()];
        broadcastAdminData();
    });

    socket.on('disconnect', () => {
        setTimeout(() => {
            for (let pNum in activeDrivers) {
                if (activeDrivers[pNum].socketId === socket.id) { delete activeDrivers[pNum]; broadcastAdminData(); }
            }
        }, 10000); 
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('\n🚀 終極版：幹部2分階梯派遣 + 司機急事退單回滾系統啟動！');
});
