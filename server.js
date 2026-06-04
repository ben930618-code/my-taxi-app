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
let driverRegistry = {
    'ABC-1234': { name: '幹部張三', phone: '111', role: 'cadre' },
    'XYZ-5678': { name: '幹部李四', phone: '222', role: 'cadre' },
    'TAXI-001': { name: '司機小明', phone: '333', role: 'driver' },
    'TAXI-002': { name: '司機小華', phone: '444', role: 'driver' }
};

let clientRegistry = [
    { id: 'client_1', name: '大發貿易公司' },
    { id: 'client_2', name: '鴻海科技經理' }
];

// 🗓️ 30天排班表：Key 為 YYYY-MM-DD，Value 為包含 4 個時段 的車牌物件
let dutySchedule30Days = {};

function init30DaysSchedule() {
    const today = new Date();
    for (let i = 0; i < 30; i++) {
        const nextDate = new Date(today);
        nextDate.setDate(today.getDate() + i);
        const yyyy = nextDate.getFullYear();
        const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
        const dd = String(nextDate.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        if (!dutySchedule30Days[dateStr]) {
            dutySchedule30Days[dateStr] = {
                "00_06": 'ABC-1234',
                "06_12": 'ABC-1234',
                "12_18": 'ABC-1234',
                "18_24": 'ABC-1234'
            }; 
        }
    }
}
init30DaysSchedule();

function getCurrentDutyPlate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    
    const hour = today.getHours();
    let slot = "00_06";
    if (hour >= 6 && hour < 12) slot = "06_12";
    else if (hour >= 12 && hour < 18) slot = "12_18";
    else if (hour >= 18) slot = "18_24";

    const daySchedule = dutySchedule30Days[dateStr];
    return daySchedule ? daySchedule[slot] : 'ABC-1234';
}

let activeDrivers = {};      // 線上司機狀態
let globalOrders = [];       // 中央訂單總表
let creditLedger = [];       // 月結記帳總帳本

// ─── ⏰ 預約單自動釋放機制 ───
setInterval(() => {
    const now = Date.now();
    let updated = false;
    globalOrders.forEach(o => {
        if (o.orderType === "預約單" && o.status === "等" && o.bookingTimestamp) {
            if (o.bookingTimestamp - now <= 1800000 && !o.autoReleasedToDrivers) {
                o.status = "丟"; 
                o.autoReleasedToDrivers = true;
                o.driverNote += "\n⚠️ [系統提示] 預約單出車前30分無幹部承接，已開放全區搶單！";
                updated = true;
                
                Object.values(activeDrivers).forEach(driver => {
                    if (!driver.isBusy) {
                        io.to(driver.socketId).emit('new_order_request', { ...o, targetScope: 'all' });
                    }
                });
            }
        }
    });
    if (updated) {
        broadcastAdminData();
        broadcastToDrivers();
    }
}, 15000);

// ─── 🧮 數學與距離計算 ───
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

function broadcastAdminData() {
    io.emit('admin_update_data', {
        orders: globalOrders,
        drivers: Object.values(activeDrivers),
        ledger: creditLedger,
        driverRegistry: driverRegistry,
        clientRegistry: clientRegistry,
        dutySchedule30Days: dutySchedule30Days,
        currentDutyPlate: getCurrentDutyPlate()
    });
}

function broadcastToDrivers() {
    const currentDuty = getCurrentDutyPlate();
    io.emit('driver_update_lists', { clientRegistry, currentDutyPlate: currentDuty, orders: globalOrders });
    io.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate: currentDuty });
}

// ─── 🚨 管理者網頁後台 ───
app.get('/admin', (req, res) => {
    const htmlLines = [
        '<!DOCTYPE html><html><head><title>管理者調度後台</title>',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<style>body{font-family:sans-serif; background:#f4f6f9; padding:15px; margin:0;} .card{background:white; padding:20px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.06); margin-bottom:20px;} h2,h3,h4{margin-top:0; color:#333; border-bottom:2px solid #007bff; padding-bottom:6px;} table{width:100%; border-collapse:collapse; margin-top:10px; font-size:14px;} th,td{border:1px solid #ddd; padding:10px; text-align:left;} th{background:#e9ecef;} .badge{padding:4px 8px; border-radius:4px; font-size:12px; font-weight:bold; color:white;} .bg-gray{background:#6c757d;} .bg-blue{background:#007bff;} .bg-orange{background:#fd7e14;} .bg-green{background:#28a745;} .bg-purple{background:#6f42c1;} .bg-red{background:#dc3545;} .inp{width:100%; padding:8px; box-sizing:border-box; margin-top:4px;} .schedule-container{display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:12px; margin-top:10px;} .setting-btn{background:#495057; color:white; padding:12px; width:100%; font-size:16px; font-weight:bold; border:none; border-radius:6px; cursor:pointer; margin-bottom:15px;} .btn-cancel{background:#dc3545; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:12px;}</style></head><body>',
        
        '<h2>🚕 豪車隊中央大盤調度中心</h2>',

        '<!-- ⚙️ 系統設定整合隱藏區 -->',
        '<button class="setting-btn" onclick="toggleSettingPanel()">🛠️ 點此「開啟 / 關閉」系統核心設定專區 (30天6小時排班 / 新增名單)</button>',
        '<div id="settingPanel" class="card" style="display:none; border: 3px solid #495057; background:#f8f9fa;">',
        '   <h2 style="color:#495057; border-bottom:3px solid #495057;">⚙️ 系統核心密室設定面板</h2>',
        '   <h3 style="color:#28a745; border-bottom:2px solid #28a745; margin-top:15px;">🗓️ 未來 30 天值班幹部手動排班 (每6小時為一班次)</h3>',
        '   <div class="schedule-container" id="schedule30DaysBoard"></div>',
        '   <div style="display:flex; gap:20px; flex-wrap: wrap; margin-top:20px;">',
        '       <div style="flex:1; min-width:240px; background:white; padding:12px; border:1px solid #ddd; border-radius:6px;">',
        '           <h4>➕ 新增司機/幹部帳號</h4>',
        '           <input type="text" id="newPlate" placeholder="車牌號碼" class="inp"><br>',
        '           <input type="text" id="newName" placeholder="姓名" class="inp"><br>',
        '           <input type="text" id="newPhone" placeholder="手機號碼/密碼" class="inp"><br>',
        '           <select id="newRole" class="inp"><option value="driver">一般司機</option><option value="cadre">車隊幹部</option></select><br><br>',
        '           <button onclick="addDriver()" style="background:green; color:white; border:none; padding:8px 12px; cursor:pointer; font-weight:bold; width:100%;">確認新增</button>',
        '           <div style="margin-top:10px; font-size:12px; color:gray;" id="registryDriversList"></div>',
        '       </div>',
        '       <div style="flex:1; min-width:240px; background:white; padding:12px; border:1px solid #ddd; border-radius:6px;">',
        '           <h4>➕ 新增月結客戶</h4>',
        '           <input type="text" id="newClientName" placeholder="客戶公司名稱" class="inp"><br><br>',
        '           <button onclick="addClient()" style="background:purple; color:white; border:none; padding:8px 12px; cursor:pointer; font-weight:bold; width:100%;">確認新增</button>',
        '           <div style="margin-top:10px; font-size:12px; color:gray;" id="registryClientsList"></div>',
        '       </div>',
        '   </div>',
        '</div>',

        '<!-- 主畫面主要功能 -->',
        '<div class="card"><h2>🚨 管理者發送新派單</h2>',
        '<div style="margin-bottom:12px;"><label><b>1. 服務類型:</b></label>',
        '<select id="serviceType" class="inp">',
        '  <option value="載人">🚗 載人服務</option>',
        '  <option value="代購">🛍️ 代購服務</option>',
        '  <option value="代駕">🍷 代駕服務</option>',
        '</select></div>',
        '<div style="margin-bottom:12px;"><label><b>2. 訂單時效:</b></label><select id="orderType" class="inp" onchange="toggleTimeInput()"><option value="即時單">⚡ 即時派單</option><option value="預約單">📅 預約派單</option></select></div>',
        '<div id="bookingTimeDiv" style="display:none; margin-bottom:12px; background:#e9ecef; padding:10px; border-radius:5px;"><label>預約出車時間:</label><input type="datetime-local" id="bookingTime" class="inp"></div>',
        '<div style="margin-bottom:12px;"><label><b>3. 上車/服務地址：</b></label><input type="text" id="addr" value="桃園市桃園區中正路1號" class="inp"></div>',
        '<div style="display:flex; gap:10px; margin-bottom:12px;"><div style="flex:1;"><label>緯度：</label><input type="number" id="lat" value="24.9936" step="0.0001" class="inp"></div><div style="flex:1;"><label>經度：</label><input type="number" id="lng" value="121.3130" step="0.0001" class="inp"></div></div>',
        '<button onclick="sendOrder()" style="width:100%; padding:12px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px; cursor:pointer;">建立新訂單</button></div>',
        
        '<div class="card"><h3>🚖 線上司機即時動態 (當前值班：<span id="currentDutyDisplay" style="color:red; font-weight:bold;">載入中</span>)</h3><div id="driverStatusDiv">等待資料載入...</div></div>',
        '<div class="card"><h3>📋 歷史與當前派單總表</h3><div style="overflow-x:auto;"><table><thead><tr><th>類型/時間</th><th>乘客上車點</th><th>擔當司機</th><th>司機即時回報動態</th><th>結帳回報</th><th>系統操作</th></tr></thead><tbody id="orderTableBody"></tbody></table></div></div>',
        '<div class="card"><h3>💵 月結記帳總對帳單</h3><div style="font-size:16px; margin-bottom:10px; color:purple; font-weight:bold;">本月累計記帳總額: <span id="ledgerTotal">0</span> 元</div><div style="overflow-x:auto;"><table><thead><tr><th>結帳時間</th><th>車牌/司機</th><th>客戶名稱</th><th>金額</th></tr></thead><tbody id="ledgerTableBody"></tbody></table></div></div>',
        
        '<script src="/socket.io/socket.io.js"></script><script>',
        'function toggleSettingPanel() { const panel = document.getElementById("settingPanel"); panel.style.display = (panel.style.display === "none") ? "block" : "none"; }',
        'function toggleTimeInput() { const type = document.getElementById("orderType").value; document.getElementById("bookingTimeDiv").style.display = (type === "預約單") ? "block" : "none"; }',
        'function sendOrder() { fetch("/api/dispatch", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ targetAddress: document.getElementById("addr").value, targetLat: parseFloat(document.getElementById("lat").value), targetLng: parseFloat(document.getElementById("lng").value), orderType: document.getElementById("orderType").value, bookingTime: document.getElementById("orderType").value==="預約單"?document.getElementById("bookingTime").value.replace("T"," "):"無 (即時單)", serviceType: document.getElementById("serviceType").value }) }); }',
        'function updateSlotDuty(dateStr, slot, selectElem) { socket.emit("admin_update_slot_duty", { dateStr, slot, plate: selectElem.value }); }',
        'function adminCancelOrder(orderId) { if(confirm("確定要由管理者端取消這筆訂單嗎？")) { socket.emit("admin_cancel_order", { orderId }); } }',
        'function addDriver() { const plate = document.getElementById("newPlate").value.trim().toUpperCase(); const name = document.getElementById("newName").value.trim(); const phone = document.getElementById("newPhone").value.trim(); const role = document.getElementById("newRole").value; if(!plate || !name || !phone) return; socket.emit("admin_add_driver", { plate, name, phone, role }); document.getElementById("newPlate").value=""; document.getElementById("newName").value=""; document.getElementById("newPhone").value=""; }',
        'function addClient() { const name = document.getElementById("newClientName").value.trim(); if(!name) return; socket.emit("admin_add_client", { name }); document.getElementById("newClientName").value = ""; }',
        
        'const socket = io({ transports: ["polling", "websocket"] });',
        'socket.on("admin_update_data", (data) => {',
        '    document.getElementById("currentDutyDisplay").innerText = data.currentDutyPlate + " (" + (data.driverRegistry[data.currentDutyPlate]?.name || "未知") + ")";',
        '    const board = document.getElementById("schedule30DaysBoard"); board.innerHTML = "";',
        '    Object.keys(data.dutySchedule30Days).sort().forEach(dateStr => {',
        '        let item = document.createElement("div"); item.style = "background:white; padding:10px; border:1px solid #ccc; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,0.05);";',
        '        item.innerHTML = `<div><b style="color:#007bff;">📅 ${dateStr}</b></div>`;',
        '        const slots = [ {k:"00_06", n:"深夜 00-06"}, {k:"06_12", n:"早班 06-12"}, {k:"12_18", n:"午班 12-18"}, {k:"18_24", n:"晚班 18-24"} ];',
        '        slots.forEach(s => {',
        '            let row = document.createElement("div"); row.style="margin-top:6px; font-size:12px; color:#555;"; row.innerText = s.n + "：";',
        '            let sel = document.createElement("select"); sel.style="width:100%; padding:4px; margin-top:2px;"; sel.onchange = function() { updateSlotDuty(dateStr, s.k, this); };',
        '            for(let k in data.driverRegistry) { if(data.driverRegistry[k].role === "cadre") { let opt = document.createElement("option"); opt.value = k; opt.innerText = `${k}(${data.driverRegistry[k].name})`; if(k === data.dutySchedule30Days[dateStr][s.k]) opt.selected = true; sel.appendChild(opt); } }',
        '            row.appendChild(sel); item.appendChild(row);',
        '        });',
        '        board.appendChild(item);',
        '    });',
        '    const drDiv = document.getElementById("driverStatusDiv"); if(data.drivers.length === 0) { drDiv.innerHTML = "<span style=\'color:gray;\'>目前沒有司機上線</span>"; } else { let drHtml = ""; data.drivers.forEach(d => { let isCadre = data.driverRegistry[d.id]?.role === "cadre"; let roleTag = isCadre ? "<b style=\'color:purple;\'>[車隊幹部]</b>" : "[一般司機]"; let dutyTag = (data.currentDutyPlate === d.id) ? " <span style=\'background:green; color:white; padding:2px 6px; border-radius:3px; font-size:12px;\'>[🟢 正在值班]</span>" : ""; let statusBadge = d.isBusy ? "<span style=\'color:red;\'>[🔴 任務中]</span>" : "<span style=\'color:green;\'>[🟢 空車]</span>"; drHtml += "<div style=\'padding:6px 0; border-bottom:1px dashed #eee;\'>🚗 <b>" + d.name + " (" + d.id + ")</b> " + roleTag + " - " + statusBadge + dutyTag + "</div>"; }); drDiv.innerHTML = drHtml; }',
        '    const oBody = document.getElementById("orderTableBody"); if(data.orders.length === 0) { oBody.innerHTML = "<tr><td colspan=\'6\' style=\'text-align:center; color:gray;\'>暫無派單紀錄</td></tr>"; } else { let oHtml = ""; data.orders.slice().reverse().forEach(o => { let statusStr = `<span class="badge bg-gray">${o.status}</span>`; if(o.status === "等") statusStr = "<span class=\'badge bg-purple\'>⏳ 幹部抉擇中</span>"; if(o.status === "讓") statusStr = "<span class=\'badge bg-purple\'>👑 幹部優先單</span>"; if(o.status === "丟") statusStr = "<span class=\'badge bg-blue\'>👥 全區搶單中</span>"; if(o.status === "前往迎客") statusStr = `<span class="badge bg-blue">前往迎客 (${o.eta || "?"}分)</span>`; if(o.status === "旅客已上車") statusStr = "<span class=\'badge bg-orange\'>旅客已上車</span>"; if(o.status === "行程已完成") statusStr = "<span class=\'badge bg-green\'>行程已完成</span>"; if(o.status === "顧客已取消") statusStr = "<span class=\'badge bg-red\'>❌ 顧客已取消</span>"; if(o.status === "已預約排定") statusStr = "<span class=\'badge bg-green\' style=\'background:darkgreen;\'>📅 預約已接單</span>";',
        '                    let reports = []; if(o.reportedHighSpeed) reports.push("<b style=\'color:purple;\'>⚠️ 司機回報：已上高速</b>"); if(o.reportedWaitingTooLong) reports.push("<b style=\'color:darkorange;\'>⚠️ 司機回報：等客人太久(沒看到客人)</b>"); if(reports.length===0) reports.push("<span style=\'color:gray;\'>正常執行中</span>"); if(o.status === "顧客已取消") reports = ["-"];',
        '                    let timeLabel = o.orderType === "預約單" ? `<b style="color:brown;">[預約]</b><br>${o.bookingTime}` : `<b style="color:green;">[即時]</b><br>${o.bookingTime}`;',
        '                    let cancelBtn = (["行程已完成", "顧客已取消"].includes(o.status)) ? "-" : `<button class="btn-cancel" onclick="adminCancelOrder(\'${o.orderId}\')">❌ 取消此單</button>`;',
        '                    oHtml += "<tr><td><b>[" + o.serviceType + "]</b><br>" + timeLabel + "</td><td>" + o.targetAddress + "</td><td>" + (o.driverName ? o.driverName : "-") + "</td><td>" + statusStr + "<br>" + reports.join("<br>") + "</td><td>" + (o.paymentReport || "-") + "</td><td>" + cancelBtn + "</td></tr>"; }); oBody.innerHTML = oHtml; }',
        '    let totalSum = 0; let lHtml = ""; data.ledger.forEach(l => { totalSum += l.amount; lHtml += `<tr><td>${l.time}</td><td>${l.driverId}</td><td><b>${l.clientName}</b></td><td>$${l.amount}</td></tr>`; }); document.getElementById("ledgerTableBody").innerHTML = lHtml || "<tr><td colspan=\'4\' style=\'text-align:center;\'>暫無紀錄</td></tr>"; document.getElementById("ledgerTotal").innerText = totalSum;',
        '    let dList = ""; for(let k in data.driverRegistry) { dList += `• ${k} (${data.driverRegistry[k].name}) [${data.driverRegistry[k].role === "cadre"?"幹部":"司機"}]<br>`; } document.getElementById("registryDriversList").innerHTML = dList;',
        '    let cList = ""; data.clientRegistry.forEach(c => { cList += `• ${c.name}<br>`; }); document.getElementById("registryClientsList").innerHTML = cList;',
        '});',
        '</script></body></html>'
    ];
    res.send(htmlLines.join('\n'));
});

// ─── 🚖 司機與當值幹部端工作台 ───
app.get('/driver', (req, res) => {
    const htmlLines = [
        '<!DOCTYPE html><html><head><title>車隊工作台系統</title>',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<style>body{font-family:sans-serif; padding:15px; max-width:500px; margin:auto; text-align:center; background:#fafafa;} .box{background:white; padding:18px; border-radius:10px; border:1px solid #eee; margin-bottom:15px; box-shadow:0 2px 5px rgba(0,0,0,0.02); text-align:left;} .btn{padding:12px; font-size:16px; font-weight:bold; border:none; border-radius:5px; width:100%; cursor:pointer; color:white; margin-top:10px;} .btn-green{background:#28a745;} .btn-red{background:#dc3545;} .btn-blue{background:#007bff;} .btn-orange{background:#fd7e14;} .btn-purple{background:#6f42c1;} .btn-small{padding:6px 12px; font-size:13px; width:auto; margin-right:5px; margin-top:5px;}</style></head><body>',
        '<h2>🚖 豪車隊工作台系統</h2>',
        
        '<!-- 🔓 密碼驗證區 -->',
        '<div id="loginSection" class="box"><h3 style="margin-top:0; text-align:center;">🔐 幹部 / 司機登入上線</h3>',
        '<label><b>車牌號碼:</b></label><input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;">',
        '<br><label><b>密碼 (手機號碼):</b></label><input type="password" id="phoneNum" placeholder="請輸入密碼" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;">',
        '<button id="toggleBtn" onclick="loginAndStart()" class="btn btn-green">確認登入上班</button></div>',
        
        '<div id="status" style="font-size:18px; color:gray; margin:15px; font-weight:bold;">🔴 目前離線狀態 (請先登入)</div>',
        '<div id="roleTag" style="font-size:14px; color:purple; margin-bottom:10px; font-weight:bold;"></div>',
        
        '<!-- 📅 本週預約大盤 (幹部專屬) -->',
        '<div id="cadreWeeklyReservationsBox" class="box" style="display:none; border:2px solid #6f42c1; background:#f3f0fa;">',
        '    <h3 style="margin-top:0; color:#6f42c1;">📅 本週預約單總表 (幹部提早接單區)</h3>',
        '    <div id="cadreWeeklyList" style="font-size:14px; color:#333;">暫無本週預約資料</div>',
        '</div>',

        '<!-- 👑 當值幹部即時案件決策台 -->',
        '<div id="dutyCadreSection" class="box" style="display:none; border:2px solid red; background:#fff5f5;">',
        '    <h3 style="margin-top:0; color:red;">👑 您是目前時段【當值幹部】(決策大盤)</h3>',
        '    <div id="dutyOrderList">暫無新進即時案件等待決策</div>',
        '</div>',
        
        '<!-- 🔊 即時搶單廣播彈窗 -->',
        '<div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-bottom:15px; text-align:left;"><h3 style="color:#856404; margin-top:0; text-align:center;">🚨 收到任務搶單廣播！</h3><p><b>服務類型：</b><span id="popServiceType" style="color:red; font-weight:bold;"></span></p><p><b>乘客上車點：</b><span id="addrText" style="font-weight:bold;"></span></p><p><b style="color:blue;">📋 司機內建規範規範：</b><br><span id="popDriverNote" style="color:#333; white-space:pre-wrap;"></span></p><button id="acceptBtn" class="btn btn-green" style="font-size:18px;">立刻按此接單 (搶)</button></div>',
        
        '<!-- 📍 執行中任務區 -->',
        '<div id="currentMissionSection" class="box" style="display:none; border:2px solid #007bff; background:#f8f9fa;"><h3 style="margin-top:0; color:#007bff; text-align:center;">📍 當前執行中任務</h3><p><b>服務類型：</b><span id="missionServiceType" style="color:red; font-weight:bold;"></span></p><p><b>上車點：</b><span id="missionAddr" style="font-weight:bold;"></span></p><p id="missionEtaRow" style="color:red; font-weight:bold;"></p><p><b style="color:blue;">📋 司機內部規範備註：</b><br><span id="missionNoteText" style="color:#333; white-space:pre-wrap;"></span></p>',
        '    <div style="background:#e9ecef; padding:10px; border-radius:5px; margin-bottom:10px;">',
        '        <label>📢 <b>即時路況回報給管理員：</b></label><br>',
        '        <button onclick="reportHighway()" class="btn-small btn-purple">🔴 我上高速了</button>',
        '        <button onclick="reportTooLong()" class="btn-small btn-purple">⏳ 等客人太久(沒看到客人)</button>',
        '    </div>',
        '    <button onclick="clickNav()" class="btn btn-blue">🧭 開啟 Google Map 導航</button>',
        '    <div id="step1_board" style="margin-top:10px;">',
        '         <button onclick="reportBoarded()" class="btn btn-orange" style="margin-bottom:8px;">🙋‍♂️ 客人已上車</button>',
        '         <button onclick="cancelMyOrder()" class="btn btn-red" style="padding:10px; font-size:15px; font-weight:bold;">🚨 棄單 / 取消接單</button>',
        '    </div>',
        '    <div id="step2_complete" style="margin-top:10px; display:none;">',
        '         <button onclick="showCompleteModal()" class="btn btn-red">🏁 客人已下車 (結帳)</button>',
        '    </div>',
        '</div>',
        
        '<!-- 📅 我的預約行程表 -->',
        '<div id="myReservationsSection" class="box" style="display:none; border: 2px solid brown; background:#fffdfa;">',
        '    <h3 style="margin-top:0; color:brown;">📅 我的預約行程表 (您已接下的預約)</h3>',
        '    <div id="myReservationsList" style="font-size:14px; color:#333;">暫無排定預約</div>',
        '</div>',

        '<div id="scheduleSection" class="box" style="display:none;"><h3 style="margin-top:0; color:#333; border-bottom:2px solid #6f42c1;">👥 全區開放搶單大池</h3><div id="scheduleList" style="font-size:14px; color:#555;">暫無可接訂單</div></div>',
        '<div id="completeModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:999; justify-content:center; align-items:center;"><div style="background:white; padding:20px; border-radius:10px; width:90%; max-width:360px; text-align:left;"><h3 style="margin-top:0; text-align:center;">💵 填寫本趟帳單明細</h3><label><b>金額：</b></label><input type="number" id="payAmount" value="150" style="width:100%; padding:10px; margin:5px 0 12px 0;"><br><label><b>付款方式：</b></label><select id="payMethod" style="width:100%; padding:10px; margin:5px 0 12px 0;" onchange="toggleClientSelect()"><option value="現金">💵 現金交易</option><option value="記帳">📝 簽帳 / 公司記帳</option></select><div id="clientSelectDiv" style="display:none; background:#f1f3f5; padding:10px; border-radius:5px; margin-bottom:12px;"><label><b>選擇月結客戶：</b></label><select id="clientSelect" style="width:100%; padding:8px; margin-top:5px;"></select></div><button onclick="submitFinishOrder()" class="btn btn-green">確認並送出明細</button></div></div>',
        
        '<script src="/socket.io/socket.io.js"></script><script>',
        'const socket = io({ transports: ["polling", "websocket"], autoConnect: true });',
        'let isOnline = false; let watchId = null; let currentLat = 24.9936; let currentLng = 121.3130; let currentActiveMission = null; let clientListMemory = []; let myRole = "driver"; let myPlate = "";',
        
        'function loginAndStart() {',
        '   const pNum = document.getElementById("plateNum").value.trim().toUpperCase();',
        '   const pwd = document.getElementById("phoneNum").value.trim();',
        '   if(!pNum || !pwd) { alert("車牌與密碼不能留空！"); return; }',
        '   if(!isOnline) {',
        '       socket.emit("driver_location_update", { plateNumber: pNum, phoneNumber: pwd, lat: currentLat, lng: currentLng });',
        '   } else {',
        '       socket.emit("driver_offline", { plateNumber: myPlate });',
        '       resetToOfflineInfo();',
        '   }',
        '}',

        'socket.on("login_failed", (data) => { alert(data.message); resetToOfflineInfo(); });',
        'socket.on("login_success", (data) => {',
        '    isOnline = true; myRole = data.role; myPlate = document.getElementById("plateNum").value.trim().toUpperCase();',
        '    document.getElementById("toggleBtn").innerText = "關閉下班 (下線)"; document.getElementById("toggleBtn").className = "btn btn-red";',
        '    document.getElementById("status").innerText = "🟢 線上候客中..."; document.getElementById("status").style.color = "green";',
        '    document.getElementById("plateNum").disabled = true; document.getElementById("phoneNum").disabled = true;',
        '    syncDutyUI(data.currentDutyPlate);',
        '    document.getElementById("scheduleSection").style.display = "block"; document.getElementById("myReservationsSection").style.display = "block";',
        '    if(myRole === "cadre") { document.getElementById("cadreWeeklyReservationsBox").style.display = "block"; }',
        '    if(navigator.geolocation) { watchId = navigator.geolocation.watchPosition(pos => { currentLat = pos.coords.latitude; currentLng = pos.coords.longitude; if(isOnline) { socket.emit("driver_location_update", { plateNumber: myPlate, phoneNumber: document.getElementById("phoneNum").value.trim(), lat: currentLat, lng: currentLng }); } }, null, {enableHighAccuracy:true}); }',
        '    socket.emit("get_available_orders");',
        '});',

        'function resetToOfflineInfo() { isOnline = false; document.getElementById("toggleBtn").innerText = "確認登入上班"; document.getElementById("toggleBtn").className = "btn btn-green"; document.getElementById("status").innerText = "🔴 目前離線狀態 (請先登入)"; document.getElementById("status").style.color = "gray"; document.getElementById("roleTag").innerText = ""; document.getElementById("dutyCadreSection").style.display = "none"; document.getElementById("cadreWeeklyReservationsBox").style.display = "none"; document.getElementById("scheduleSection").style.display = "none"; document.getElementById("myReservationsSection").style.display = "none"; document.getElementById("currentMissionSection").style.display = "none"; document.getElementById("plateNum").disabled = false; document.getElementById("phoneNum").disabled = false; if(watchId) navigator.geolocation.clearWatch(watchId); }',
        'function syncDutyUI(dutyPlate) { let isDuty = (dutyPlate === myPlate); let roleStr = (myRole === "cadre") ? "【👑 車隊幹部】" : "【🚖 一般司機】"; if(isDuty) { roleStr += " ⭐ 目前時段當值幹部"; document.getElementById("dutyCadreSection").style.display = "block"; } else { document.getElementById("dutyCadreSection").style.display = "none"; } document.getElementById("roleTag").innerText = roleStr; }',
        'function startReservationMission(orderId) { socket.emit("driver_trigger_reservation", { orderId, plateNumber: myPlate }); }',
        'function dutyAction(orderId, action) { socket.emit("duty_cadre_decision", { orderId, action, plateNumber: myPlate, lat: currentLat, lng: currentLng }); }',
        'function clickTakeOrder(orderId) { socket.emit("accept_order", { orderId, plateNumber: myPlate, lat: currentLat, lng: currentLng }); }',
        
        'socket.on("driver_update_lists", (data) => { ',
        '    if(isOnline) syncDutyUI(data.currentDutyPlate); ',
        '    clientListMemory = data.clientRegistry || []; const select = document.getElementById("clientSelect"); select.innerHTML = ""; clientListMemory.forEach(c => { let opt = document.createElement("option"); opt.value = c.name; opt.innerText = c.name; select.appendChild(opt); });',
        '    if(!isOnline) return;',
        '    if(myRole === "cadre") {',
        '        let weeklyOrders = (data.orders || []).filter(o => o.orderType === "預約單" && o.status === "等");',
        '        let wh = ""; weeklyOrders.forEach(o => { wh += `<div style="background:white; border:1px solid #6f42c1; padding:8px; margin-top:5px; border-radius:4px;">📅 <b>[${o.serviceType}]</b> ${o.targetAddress}<br><small>預約出車: ${o.bookingTime}</small><br><button class="btn-small btn-purple" onclick="clickTakeOrder(\'${o.orderId}\')">👑 幹部提早接下此預約</button></div>`; });',
        '        document.getElementById("cadreWeeklyList").innerHTML = wh || "本週暫無待承接的預約單";',
        '    }',
        '});',
        
        'socket.on("sync_orders_to_driver", (data) => { ',
        '    if(!isOnline) return; ',
        '    let isDuty = (data.currentDutyPlate === myPlate);',
        '    ',
        '    // 檢查目前執行的任務是否被管理者在後台取消了',
        '    if(currentActiveMission) {',
        '        let serverCheck = data.orders.find(o => o.orderId === currentActiveMission.orderId);',
        '        if(!serverCheck || serverCheck.status === "顧客已取消") {',
        '            alert("⚠️ 派單提示：此筆訂單已被管理者或客戶取消！服務終止。");',
        '            document.getElementById("currentMissionSection").style.display = "none";',
        '            currentActiveMission = null;',
        '            document.getElementById("status").innerText = "🟢 線上候客中...";',
        '            document.getElementById("status").style.color = "green";',
        '        }',
        '    }',
        '    if(isDuty) { let html = ""; data.orders.forEach(o => { if(o.status === "等" && o.orderType !== "預約單") { html += `<div style="border-bottom:1px dashed #ccc; padding:8px 0;">📍 <b>[${o.serviceType}]</b> ${o.targetAddress}<br><button class="btn-small btn-green" onclick="dutyAction(\'${o.orderId}\', \'接\')">🟢 我接了</button> <button class="btn-small btn-blue" onclick="dutyAction(\'${o.orderId}\', \'丟\')">🔵 丟給司機</button> <button class="btn-small btn-purple" onclick="dutyAction(\'${o.orderId}\', \'讓\')">🟣 全幹部優先</button></div>`; } }); document.getElementById("dutyOrderList").innerHTML = html || "暫無即時案件需處理"; }',
        '    const listDiv = document.getElementById("scheduleList"); let filterOrders = data.orders.filter(o => { if(["行程已完成", "前往迎客", "旅客已上車", "顧客已取消"].includes(o.status)) return false; if(o.status === "等" && o.orderType === "即時單") return false; if(o.status === "等" && o.orderType === "預約單") return false; if(myRole === "driver" && o.status === "讓") return false; return true; }); if(filterOrders.length === 0) { listDiv.innerHTML = "暫無開放搶單的項目"; } else { let h = ""; filterOrders.forEach(o => { let typeTag = o.orderType === "預約單" ? "<span style=\'color:brown;\'>[📅開放預約]</span>" : "<span style=\'color:green;\'>[⚡即時]</span>"; h += `<div style="background:#f1f3f5; padding:8px; border-left:4px solid #007bff; margin-top:5px;">${typeTag} <b>[${o.serviceType}]</b> ${o.targetAddress}<br><small style="color:gray;">時間: ${o.bookingTime}</small><br><button class="btn-small btn-green" onclick="clickTakeOrder(\'${o.orderId}\')">立刻搶單</button></div>`; }); listDiv.innerHTML = h; }',
        '    const resDiv = document.getElementById("myReservationsList"); let myResOrders = data.orders.filter(o => o.driverId === myPlate && o.orderType === "預約單"); if(myResOrders.length === 0) { resDiv.innerHTML = "暫無排定預約行程"; } else { let rh = ""; myResOrders.forEach(o => { let actionBtn = o.status === "已預約排定" ? `<button class="btn-small btn-blue" onclick="startReservationMission(\'${o.orderId}\')">🚀 時間到：現在出發迎客</button>` : `<span style="color:orange;font-weight:bold;">[狀態: ${o.status}]</span>`; rh += `<div style="background:#fff; border:1px solid brown; padding:8px; margin-top:5px; border-radius:4px;"><b>[${o.serviceType}]</b> ${o.targetAddress}<br><small>時間: ${o.bookingTime}</small><br>${actionBtn}</div>`; }); resDiv.innerHTML = rh; }',
        '});',
        
        'socket.on("new_order_request", (data) => { if(currentActiveMission) return; if(data.targetScope === "cadre_only" && myRole !== "cadre") return; document.getElementById("popServiceType").innerText = data.serviceType + " (" + data.orderType + ")"; document.getElementById("addrText").innerText = data.targetAddress; document.getElementById("popDriverNote").innerText = data.driverNote; document.getElementById("pop").style.display = "block"; document.getElementById("acceptBtn").onclick = function() { socket.emit("accept_order", { orderId: data.orderId, plateNumber: myPlate, lat: currentLat, lng: currentLng }); }; });',
        'socket.on("accept_result", (data) => { document.getElementById("pop").style.display = "none"; if(data.success) { if(data.order.orderType === "即時單" || data.isTriggeredReservation) { currentActiveMission = data.order; document.getElementById("status").innerText = "🚖 任務執行中..."; document.getElementById("status").style.color = "blue"; document.getElementById("missionServiceType").innerText = data.order.serviceType; document.getElementById("missionAddr").innerText = data.order.targetAddress; document.getElementById("missionEtaRow").innerText = "⏳ 預計 " + (data.eta || "?") + " 分鐘後抵達"; document.getElementById("missionNoteText").innerText = data.order.driverNote; document.getElementById("currentMissionSection").style.display = "block"; document.getElementById("step1_board").style.display = "block"; document.getElementById("step2_complete").style.display = "none"; window.open("https://www.google.com/maps/search/?api=1&query=" + data.order.targetLat + "," + data.order.targetLng, "_blank"); } else { alert("📅 預約單承接成功！已移入下方的【我的預約行程表】。"); } } else { alert(data.message); } socket.emit("get_available_orders"); });',
        'function reportHighway() { if(currentActiveMission) socket.emit("driver_live_report", { orderId: currentActiveMission.orderId, reportType: "highway" }); }',
        'function reportTooLong() { if(currentActiveMission) socket.emit("driver_live_report", { orderId: currentActiveMission.orderId, reportType: "waiting_too_long" }); }',
        'function cancelMyOrder() { if(!currentActiveMission) return; if(confirm("確定退單/取消此筆接單嗎？")) { socket.emit("driver_cancel_order", { orderId: currentActiveMission.orderId, plateNumber: myPlate }); document.getElementById("currentMissionSection").style.display = "none"; currentActiveMission = null; document.getElementById("status").innerText = "🟢 線上候客中..."; document.getElementById("status").style.color = "green"; } }',
        'function clickNav() { if(currentActiveMission) window.open("https://www.google.com/maps/search/?api=1&query=" + currentActiveMission.targetLat + "," + currentActiveMission.targetLng, "_blank"); }',
        'function reportBoarded() { socket.emit("driver_report_status", { orderId: currentActiveMission.orderId, status: "旅客已上車", plateNumber: myPlate }); document.getElementById("status").innerText = "🚖 運送服務中..."; document.getElementById("step1_board").style.display = "none"; document.getElementById("step2_complete").style.display = "block"; }',
        'function showCompleteModal() { document.getElementById("completeModal").style.display = "flex"; }',
        'function toggleClientSelect() { document.getElementById("clientSelectDiv").style.display = (document.getElementById("payMethod").value === "記帳") ? "block" : "none"; }',
        'function submitFinishOrder() { const amt = parseInt(document.getElementById("payAmount").value) || 0; const method = document.getElementById("payMethod").value; let chosenClient = (method === "記帳") ? document.getElementById("clientSelect").value : ""; if(method === "記帳" && !chosenClient) { alert("請選擇月結客戶"); return; } socket.emit("driver_finish_order", { orderId: currentActiveMission.orderId, plateNumber: myPlate, amount: amt, payMethod: method, clientName: chosenClient }); document.getElementById("completeModal").style.display = "none"; document.getElementById("currentMissionSection").style.display = "none"; currentActiveMission = null; document.getElementById("status").innerText = "🟢 線上候客中..."; document.getElementById("status").style.color = "green"; }',
        '</script></body></html>'
    ];
    res.send(htmlLines.join('\n'));
});

// ─── 📡 API 派單起點 ───
app.post('/api/dispatch', (req, res) => {
    const { targetAddress, targetLat, targetLng, orderType, bookingTime, serviceType } = req.body;
    let orderId = "order_" + Date.now();
    
    let note = "";
    if (serviceType === "代駕") {
        note = "代駕\n備註如下\n8內/600,每2//100";
    } else if (serviceType === "載人") {
        note = "60/20/無/2內100\n🔴接單，請資料一起丟\n🔴上高速請告知派單\n🔴5內抵達，取消無空趟\n🔴總等待5分，暫下無緩";
    } else if (serviceType === "代購") {
        note = "基本費+100\n60/20/無/2內100\n🔴接單，請資料一起丟\n🔴上高速請告知派單\n🔴5內抵達，取消無空趟\n🔴總等待5分，暫下無緩";
    }

    let bookingTimestamp = null;
    if(orderType === "預約單" && bookingTime && bookingTime !== "無 (即時單)") {
        bookingTimestamp = Date.parse(bookingTime);
    }

    let newOrder = { 
        orderId, targetAddress, targetLat, targetLng, orderType, bookingTime, serviceType, bookingTimestamp,
        driverNote: note,
        status: "等", 
        driverId: null, driverName: null, paymentReport: null, eta: null,
        reportedHighSpeed: false, reportedWaitingTooLong: false, autoReleasedToDrivers: false,
        createdAt: Date.now() 
    };
    
    globalOrders.push(newOrder);
    broadcastAdminData();
    broadcastToDrivers();
    res.json({ status: "processing", orderId });
});

// ─── 📡 Socket 中央通訊區 ───
io.on('connection', (socket) => {
    broadcastAdminData();
    socket.emit('driver_update_lists', { clientRegistry, currentDutyPlate: getCurrentDutyPlate(), orders: globalOrders });
    
    socket.on('get_available_orders', () => {
        socket.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate: getCurrentDutyPlate() });
    });

    socket.on('admin_update_slot_duty', (data) => {
        if(data.dateStr && data.slot && data.plate) {
            if(!dutySchedule30Days[data.dateStr]) dutySchedule30Days[data.dateStr] = {};
            dutySchedule30Days[data.dateStr][data.slot] = data.plate;
            broadcastAdminData(); broadcastToDrivers();
        }
    });

    // ❌ 追加：管理者端取消訂單功能
    socket.on('admin_cancel_order', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        if(ord) {
            ord.status = "顧客已取消";
            if(ord.driverId && activeDrivers[ord.driverId]) {
                activeDrivers[ord.driverId].isBusy = false;
            }
            broadcastAdminData(); broadcastToDrivers();
        }
    });

    socket.on('admin_add_driver', (data) => {
        driverRegistry[data.plate] = { name: data.name, phone: data.phone, role: data.role };
        broadcastAdminData(); broadcastToDrivers();
    });

    socket.on('admin_add_client', (data) => {
        clientRegistry.push({ id: 'client_' + Date.now(), name: data.name });
        broadcastAdminData(); broadcastToDrivers();
    });

    socket.on('driver_location_update', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const registeredDriver = driverRegistry[pNum];

        if (!registeredDriver || registeredDriver.phone !== data.phoneNumber) {
            socket.emit('login_failed', { message: "❌ 登入失敗：車牌或密碼不正確！" });
            return;
        }

        let wasBusy = activeDrivers[pNum] ? activeDrivers[pNum].isBusy : false;
        activeDrivers[pNum] = { id: pNum, name: registeredDriver.name, lat: data.lat, lng: data.lng, socketId: socket.id, isBusy: wasBusy };
        
        socket.emit('login_success', { role: registeredDriver.role, currentDutyPlate: getCurrentDutyPlate() });
        broadcastAdminData(); broadcastToDrivers();
    });

    socket.on('duty_cadre_decision', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        if(pNum !== getCurrentDutyPlate()) return; 
        
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        if(!ord || ord.status !== "等") return;

        if (data.action === '接') {
            const realDist = getDistance(ord.targetLat, ord.targetLng, data.lat, data.lng);
            const durationEta = calculateETA(realDist);
            
            if(ord.orderType === "預約單") {
                ord.status = "已預約排定";
                ord.driverId = pNum;
                ord.driverName = activeDrivers[pNum]?.name || "當值幹部";
                socket.emit('accept_result', { success: true, order: ord, isTriggeredReservation: false });
            } else {
                ord.status = "前往迎客";
                ord.driverId = pNum;
                ord.driverName = activeDrivers[pNum]?.name || "當值幹部";
                ord.eta = durationEta;
                if(activeDrivers[pNum]) activeDrivers[pNum].isBusy = true;
                socket.emit('accept_result', { success: true, order: ord, eta: durationEta, isTriggeredReservation: false });
            }
        } 
        else if (data.action === '丟') {
            ord.status = "丟";
            Object.values(activeDrivers).forEach(driver => {
                if (!driver.isBusy) {
                    io.to(driver.socketId).emit('new_order_request', { ...ord, targetScope: 'all' });
                }
            });
        } 
        else if (data.action === '讓') {
            ord.status = "讓";
            Object.values(activeDrivers).forEach(driver => {
                let regInfo = driverRegistry[driver.id];
                if (regInfo && regInfo.role === 'cadre' && !driver.isBusy) {
                    io.to(driver.socketId).emit('new_order_request', { ...ord, targetScope: 'cadre_only' });
                }
            });
        }

        broadcastAdminData(); broadcastToDrivers();
    });

    socket.on('accept_order', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const driverInfo = activeDrivers[pNum];
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        let isCadreTaker = (driverRegistry[pNum]?.role === 'cadre');
        let canTake = false;
        
        if (ord) {
            if (["丟", "讓"].includes(ord.status)) canTake = true;
            if (ord.orderType === "預約單" && ord.status === "等" && isCadreTaker) canTake = true;
        }

        if (ord && canTake) {
            let regInfo = driverRegistry[pNum];
            if(regInfo.role === 'driver' && ord.status === "讓") {
                socket.emit('accept_result', { success: false, message: "此單目前限制為【幹部優先讓單】。" });
                return;
            }

            const realDist = getDistance(ord.targetLat, ord.targetLng, data.lat, data.lng);
            const durationEta = calculateETA(realDist);

            if(ord.orderType === "預約單") {
                ord.status = "已預約排定";
                ord.driverId = pNum; 
                ord.driverName = driverInfo ? driverInfo.name : pNum;
                socket.emit('accept_result', { success: true, order: ord, isTriggeredReservation: false });
            } else {
                ord.status = "前往迎客";
                ord.driverId = pNum; 
                ord.driverName = driverInfo ? driverInfo.name : pNum; 
                ord.eta = durationEta;
                if(driverInfo) driverInfo.isBusy = true; 
                socket.emit('accept_result', { success: true, order: ord, eta: durationEta, isTriggeredReservation: false });
            }
            broadcastAdminData(); broadcastToDrivers();
        } else {
            socket.emit('accept_result', { success: false, message: "單已被搶走或取消。" });
        }
    });

    socket.on('driver_trigger_reservation', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const driverInfo = activeDrivers[pNum];
        const ord = globalOrders.find(o => o.orderId === data.orderId);

        if(ord && ord.driverId === pNum && ord.status === "已預約排定") {
            const realDist = getDistance(ord.targetLat, ord.targetLng, driverInfo?.lat, driverInfo?.lng);
            const durationEta = calculateETA(realDist);

            ord.status = "前往迎客";
            ord.eta = durationEta;
            if(driverInfo) driverInfo.isBusy = true;

            socket.emit('accept_result', { success: true, order: ord, eta: durationEta, isTriggeredReservation: true });
            broadcastAdminData(); broadcastToDrivers();
        }
    });

    socket.on('driver_live_report', (data) => {
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        if(ord) {
            if(data.reportType === 'highway') { ord.reportedHighSpeed = true; }
            if(data.reportType === 'waiting_too_long') { ord.reportedWaitingTooLong = true; }
            broadcastAdminData(); 
        }
    });

    socket.on('driver_cancel_order', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const ord = globalOrders.find(o => o.orderId === data.orderId);
        const driverInfo = activeDrivers[pNum];

        if(ord && ord.driverId === pNum) {
            if(driverInfo) driverInfo.isBusy = false;
            ord.status = "等";
            ord.driverId = null; ord.driverName = null; ord.eta = null;
            ord.reportedHighSpeed = false; ord.reportedWaitingTooLong = false; 
            broadcastAdminData(); broadcastToDrivers();
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
        broadcastAdminData(); broadcastToDrivers();
    });

    socket.on('driver_offline', (data) => {
        delete activeDrivers[data.plateNumber.toUpperCase()];
        broadcastAdminData(); broadcastToDrivers();
    });

    socket.on('disconnect', () => {
        setTimeout(() => {
            for (let pNum in activeDrivers) {
                if (activeDrivers[pNum].socketId === socket.id) { delete activeDrivers[pNum]; broadcastAdminData(); broadcastToDrivers(); }
            }
        }, 10000); 
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('\n🚀 豪車隊全新修復版系統已啟動！');
});
