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

// 🗓️ 未來 30 天排班表資料庫 (Key格式: YYYY-MM-DD_時段)
// 時段劃分：1(00-06), 2(06-12), 3(12-18), 4(18-00)
let dutySchedule6Hours = {};

function init6HoursSchedule() {
    const today = new Date();
    for (let i = 0; i < 30; i++) {
        const nextDate = new Date(today);
        nextDate.setDate(today.getDate() + i);
        const yyyy = nextDate.getFullYear();
        const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
        const dd = String(nextDate.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        
        for (let slot = 1; slot <= 4; slot++) {
            const key = `${dateStr}_slot${slot}`;
            if (!dutySchedule6Hours[key]) {
                dutySchedule6Hours[key] = 'ABC-1234'; // 預設指派
            }
        }
    }
}
init6HoursSchedule();

// 💡 依據「當前精確時間」取得這 6 小時值班的幹部車牌
function getCurrentDutyPlate() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    
    const hour = now.getHours();
    let slot = 1;
    if (hour >= 6 && hour < 12) slot = 2;
    else if (hour >= 12 && hour < 18) slot = 3;
    else if (hour >= 18 && hour < 24) slot = 4;
    
    const key = `${dateStr}_slot${slot}`;
    return dutySchedule6Hours[key] || 'ABC-1234';
}

let activeDrivers = {};      // 線上司機狀態
let globalOrders = [];       // 中央訂單總表
let creditLedger = [];       // 月結記帳總帳本

// ─── 🧮 導航計算 ───
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
    return Math.max(3, Math.round((distanceInKm / 30) * 60 + (distanceInKm * 1.5)));
}

function broadcastAdminData() {
    io.emit('admin_update_data', {
        orders: globalOrders,
        drivers: Object.values(activeDrivers),
        ledger: creditLedger,
        driverRegistry: driverRegistry,
        clientRegistry: clientRegistry,
        dutySchedule6Hours: dutySchedule6Hours,
        currentDutyPlate: getCurrentDutyPlate()
    });
}

function broadcastToDrivers() {
    const currentDuty = getCurrentDutyPlate();
    io.emit('driver_update_lists', { clientRegistry, currentDutyPlate: currentDuty });
    io.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate: currentDuty });
}

// ─── 🚨 管理者網頁後台 (首頁與設定分頁二合一) ───
app.get('/admin', (req, res) => {
    const htmlLines = [
        '<!DOCTYPE html><html><head><title>管理者調度後台</title>',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<style>body{font-family:sans-serif; background:#f4f6f9; padding:15px; margin:0;} .card{background:white; padding:20px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.06); margin-bottom:20px;} h2,h3,h4{margin-top:0; color:#333; border-bottom:2px solid #007bff; padding-bottom:6px;} table{width:100%; border-collapse:collapse; margin-top:10px; font-size:14px;} th,td{border:1px solid #ddd; padding:10px; text-align:left;} th{background:#e9ecef;} .badge{padding:4px 8px; border-radius:4px; font-size:12px; font-weight:bold; color:white;} .bg-gray{background:#6c757d;} .bg-blue{background:#007bff;} .bg-orange{background:#fd7e14;} .bg-green{background:#28a745;} .bg-purple{background:#6f42c1;} .bg-red{background:#dc3545;} .inp{width:100%; padding:8px; box-sizing:border-box; margin-top:4px;} .nav-btn{padding:10px 20px; font-size:15px; font-weight:bold; border:none; border-radius:5px; cursor:pointer; margin-right:10px; margin-bottom:15px;} .btn-active{background:#007bff; color:white;} .btn-inactive{background:#6c757d; color:white;} .schedule-grid{display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:12px; margin-top:10px;} .slot-box{background:#fff; border:1px solid #e0e0e0; padding:10px; border-radius:6px; box-shadow:0 1px 3px rgba(0,0,0,0.05);}</style></head><body>',
        
        '',
        '<div style="text-align:left;">',
        '  <button id="tabMainBtn" class="nav-btn btn-active" onclick="switchTab(\'main\')">📊 即時發單/監控主頁</button>',
        '  <button id="tabSettingsBtn" class="nav-btn btn-inactive" onclick="switchTab(\'settings\')">⚙️ 進入系統進階設定</button>',
        '</div>',

        '',
        '<div id="pageMain">',
        '  <div class="card"><h2>🚨 管理者發送新派單 (選擇服務類型)</h2>',
        '  <div style="margin-bottom:12px;"><label><b>1. 服務類型:</b></label><select id="serviceType" class="inp"><option value="載人">🚗 載人服務</option><option value="代購">🛍️ 代購服務</option><option value="代駕">🍷 代駕服務</option></select></div>',
        '  <div style="margin-bottom:12px;"><label><b>2. 訂單時效:</b></label><select id="orderType" class="inp" onchange="toggleTimeInput()"><option value="即時單">⚡ 即時派單</option><option value="預約單">📅 預約派單</option></select></div>',
        '  <div id="bookingTimeDiv" style="display:none; margin-bottom:12px; background:#e9ecef; padding:10px; border-radius:5px;"><label>預約時間:</label><input type="datetime-local" id="bookingTime" class="inp"></div>',
        '  <div style="margin-bottom:12px;"><label><b>3. 上車/服務地址：</b></label><input type="text" id="addr" value="桃園市桃園區中正路1號" class="inp"></div>',
        '  <div style="display:flex; gap:10px; margin-bottom:12px;"><div style="flex:1;"><label>緯度：</label><input type="number" id="lat" value="24.9936" step="0.0001" class="inp"></div><div style="flex:1;"><label>經度：</label><input type="number" id="lng" value="121.3130" step="0.0001" class="inp"></div></div>',
        '  <button onclick="sendOrder()" style="width:100%; padding:12px; background:blue; color:white; border:none; font-size:16px; font-weight:bold; border-radius:5px; cursor:pointer;">建立新訂單</button></div>',
        '  <div class="card"><h3>🚖 線上司機即時動態</h3><p style="font-size:14px; color:#666;">當前時段值班幹部：<span id="currentDutyDisplay" style="color:red; font-weight:bold;">載入中...</span></p><div id="driverStatusDiv">等待資料載入...</div></div>',
        '  <div class="card"><h3>📋 歷史與當前派單總表</h3><div style="overflow-x:auto;"><table><thead><tr><th>類型/時間</th><th>乘客上車點</th><th>擔當司機</th><th>當前狀態/系統備註</th><th>結帳回報</th></tr></thead><tbody id="orderTableBody"></tbody></table></div></div>',
        '  <div class="card"><h3>💵 月結記帳總對帳單</h3><div style="font-size:16px; margin-bottom:10px; color:purple; font-weight:bold;">本月累計記帳總額: <span id="ledgerTotal">0</span> 元</div><div style="overflow-x:auto;"><table><thead><tr><th>結帳時間</th><th>車牌/司機</th><th>客戶名稱</th><th>金額</th></tr></thead><tbody id="ledgerTableBody"></tbody></table></div></div>',
        '</div>',

        '',
        '<div id="pageSettings" style="display:none;">',
        '  ',
        '  <div class="card" style="border: 2px solid #28a745;">',
        '     <h2 style="color:#28a745; border-bottom:2px solid #28a745;">🗓️ 未來 30 天值班幹部排班大盤 (每6小時一班)</h2>',
        '     <p style="font-size:13px; color:#555;">班次劃分說明：時段1 (00-06點) | 時段2 (06-12點) | 時段3 (12-18點) | 時段4 (18-24點)</p>',
        '     <div class="schedule-grid" id="schedule6HBoard"></div>',
        '  </div>',
        '  <div class="card" style="border: 2px solid #6c757d;"><h3>⚙️ 車隊與客戶名單設定</h3>',
        '     <div style="display:flex; gap:20px; flex-wrap: wrap;">',
        '        <div style="flex:1; min-width:240px; background:#f8f9fa; padding:12px; border-radius:6px;"><h4>➕ 新增司機/幹部帳號</h4><input type="text" id="newPlate" placeholder="車牌號碼" style="width:100%; padding:6px; margin-bottom:6px;"><br><input type="text" id="newName" placeholder="姓名" style="width:100%; padding:6px; margin-bottom:6px;"><br><input type="text" id="newPhone" placeholder="手機號碼(即為登入密碼)" style="width:100%; padding:6px; margin-bottom:6px;"><br><select id="newRole" style="width:100%; padding:6px; margin-bottom:10px;"><option value="driver">一般司機</option><option value="cadre">車隊幹部</option></select><br><button onclick="addDriver()" style="background:green; color:white; border:none; padding:8px 12px; cursor:pointer; font-weight:bold; border-radius:4px;">確認新增</button><div style="margin-top:12px; font-size:13px; color:#333; line-height:1.5;" id="registryDriversList"></div></div>',
        '        <div style="flex:1; min-width:240px; background:#f8f9fa; padding:12px; border-radius:6px;"><h4>➕ 新增月結客戶</h4><input type="text" id="newClientName" placeholder="客戶公司名稱" style="width:100%; padding:6px; margin-bottom:10px;"><br><button onclick="addClient()" style="background:purple; color:white; border:none; padding:8px 12px; cursor:pointer; font-weight:bold; border-radius:4px;">確認新增</button><div style="margin-top:12px; font-size:13px; color:#333; line-height:1.5;" id="registryClientsList"></div></div>',
        '     </div>',
        '  </div>',
        '</div>',
        
        '<script src="/socket.io/socket.io.js"></script><script>',
        'const socket = io({ transports: ["polling", "websocket"] });',
        'let memoryDriverRegistry = {};',
        'function switchTab(tab) {',
        '  if(tab === "main") { document.getElementById("pageMain").style.display="block"; document.getElementById("pageSettings").style.display="none"; document.getElementById("tabMainBtn").className="nav-btn btn-active"; document.getElementById("tabSettingsBtn").className="nav-btn btn-inactive"; }',
        '  else { document.getElementById("pageMain").style.display="none"; document.getElementById("pageSettings").style.display="block"; document.getElementById("tabMainBtn").className="nav-btn btn-inactive"; document.getElementById("tabSettingsBtn").className="nav-btn btn-active"; }',
        '}',
        'function toggleTimeInput() { const type = document.getElementById("orderType").value; document.getElementById("bookingTimeDiv").style.display = (type === "預約單") ? "block" : "none"; }',
        'function sendOrder() { fetch("/api/dispatch", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ targetAddress: document.getElementById("addr").value, targetLat: parseFloat(document.getElementById("lat").value), targetLng: parseFloat(document.getElementById("lng").value), orderType: document.getElementById("orderType").value, bookingTime: document.getElementById("orderType").value==="預約單"?document.getElementById("bookingTime").value.replace("T"," "):"無 (即時單)", serviceType: document.getElementById("serviceType").value }) }); }',
        'function update6HDuty(slotKey, selectElem) { socket.emit("admin_update_6h_duty", { slotKey, plate: selectElem.value }); }',
        'function addDriver() { const plate = document.getElementById("newPlate").value.trim().toUpperCase(); const name = document.getElementById("newName").value.trim(); const phone = document.getElementById("newPhone").value.trim(); const role = document.getElementById("newRole").value; if(!plate || !name || !phone) { alert("請填齊欄位！"); return; } socket.emit("admin_add_driver", { plate, name, phone, role }); document.getElementById("newPlate").value=""; document.getElementById("newName").value=""; document.getElementById("newPhone").value=""; }',
        'function addClient() { const name = document.getElementById("newClientName").value.trim(); if(!name) return; socket.emit("admin_add_client", { name }); document.getElementById("newClientName").value = ""; }',
        
        'socket.on("admin_update_data", (data) => {',
        '    memoryDriverRegistry = data.driverRegistry;',
        '    document.getElementById("currentDutyDisplay").innerText = data.currentDutyPlate + " (" + (data.driverRegistry[data.currentDutyPlate]?.name || "未知") + ")";',
        '    ',
        '    // 渲染 6 小時排班模組',
        '    const board = document.getElementById("schedule6HBoard"); board.innerHTML = "";',
        '    // 整理日期排序',
        '    let keysByDate = {};',
        '    Object.keys(data.dutySchedule6Hours).forEach(k => {',
        '       let parts = k.split("_"); let dStr = parts[0]; if(!keysByDate[dStr]) keysByDate[dStr] = []; keysByDate[dStr].push(k);',
        '    });',
        '    Object.keys(keysByDate).sort().forEach(dStr => {',
        '       let card = document.createElement("div"); card.className = "slot-box";',
        '       card.innerHTML = `<div><b style="color:#155724;">📅 ${dStr}</b></div>`;',
        '       keysByDate[dStr].sort().forEach(k => {',
        '          let slotNum = k.split("_slot")[1];',
        '          let label = "夜間 (00-06)"; if(slotNum=="2") label="上午 (06-12)"; if(slotNum=="3") label="下午 (12-18)"; if(slotNum=="4") label="晚上 (18-00)";',
        '          let row = document.createElement("div"); row.style="margin-top:6px; font-size:12px; display:flex; align-items:center; justify-content:space-between;";',
        '          row.innerHTML = `<span>${label}: </span>`;',
        '          let sel = document.createElement("select"); sel.style="padding:3px; font-size:11px;"; sel.onchange = function() { update6HDuty(k, this); };',
        '          for(let dPlate in data.driverRegistry) {',
        '             if(data.driverRegistry[dPlate].role === "cadre") {',
        '                let opt = document.createElement("option"); opt.value = dPlate; opt.innerText = `${data.driverRegistry[dPlate].name}(${dPlate})`;',
        '                if(dPlate === data.dutySchedule6Hours[k]) opt.selected = true;',
        '                sel.appendChild(opt);',
        '             }',
        '          }',
        '          row.appendChild(sel); card.appendChild(row);',
        '       });',
        '       board.appendChild(card);',
        '    });',
        '    ',
        '    const drDiv = document.getElementById("driverStatusDiv"); if(data.drivers.length === 0) { drDiv.innerHTML = "<span style=\'color:gray;\'>目前沒有司機上線</span>"; } else { let drHtml = ""; data.drivers.forEach(d => { let isCadre = data.driverRegistry[d.id]?.role === "cadre"; let roleTag = isCadre ? "<b style=\'color:purple;\'>[車隊幹部]</b>" : "[一般司機]"; let dutyTag = (data.currentDutyPlate === d.id) ? " <span style=\'background:green; color:white; padding:2px 6px; border-radius:3px; font-size:12px;\'>[🟢 正在值班]</span>" : ""; let statusBadge = d.isBusy ? "<span style=\'color:red;\'>[🔴 任務中]</span>" : "<span style=\'color:green;\'>[🟢 空車]</span>"; drHtml += "<div style=\'padding:6px 0; border-bottom:1px dashed #eee;\'>🚗 <b>" + d.name + " (" + d.id + ")</b> " + roleTag + " - " + statusBadge + dutyTag + "</div>"; }); drDiv.innerHTML = drHtml; }',
        '    const oBody = document.getElementById("orderTableBody"); if(data.orders.length === 0) { oBody.innerHTML = "<tr><td colspan=\'5\' style=\'text-align:center; color:gray;\'>暫無派單紀錄</td></tr>"; } else { let oHtml = ""; data.orders.slice().reverse().forEach(o => { let statusStr = `<span class="badge bg-gray">${o.status}</span>`; if(o.status === "等") statusStr = "<span class=\'badge bg-purple\'>⏳ 當值幹部抉擇中(等)</span>"; if(o.status === "讓") statusStr = "<span class=\'badge bg-purple\'>👑 全體幹部優先(讓)</span>"; if(o.status === "丟") statusStr = "<span class=\'badge bg-blue\'>👥 一般司機搶單中(丟)</span>"; if(o.status === "前往迎客") statusStr = `<span class="badge bg-blue">前往迎客 (${o.eta || "?"}分)</span>`; if(o.status === "旅客已上車") statusStr = "<span class=\'badge bg-orange\'>旅客已上車</span>"; if(o.status === "行程已完成") statusStr = "<span class=\'badge bg-green\'>行程已完成</span>"; ',
        '                    let rTags = ""; if(o.reportedHighSpeed) rTags += " <span style=\'background:red; color:white; font-size:11px; padding:2px 4px; border-radius:3px;\'>⚠️ 已上高速</span>"; if(o.reportedWaitingTooLong) rTags += " <span style=\'background:darkorange; color:white; font-size:11px; padding:2px 4px; border-radius:3px;\'>⚠️ 等客人太久</span>";',
        '                    let timeLabel = o.orderType === "預約單" ? `<b style="color:brown;">[預約]</b><br>${o.bookingTime}` : `<b style="color:green;">[即時]</b><br>${o.bookingTime}`;',
        '                    oHtml += "<tr><td><b>[" + o.serviceType + "]</b><br>" + timeLabel + "</td><td>" + o.targetAddress + "</td><td>" + (o.driverName ? o.driverName : "-") + "</td><td>" + statusStr + rTags + "<br><small style=\'color:gray; white-space:pre-wrap;\'>範本備註：<br>" + o.systemNote + "</small></td><td>" + (o.paymentReport || "-") + "</td></tr>"; }); oBody.innerHTML = oHtml; }',
        '    let totalSum = 0; let lHtml = ""; data.ledger.forEach(l => { totalSum += l.amount; lHtml += `<tr><td>${l.time}</td><td>${l.driverId}</td><td><b>${l.clientName}</b></td><td>$${l.amount}</td></tr>`; }); document.getElementById("ledgerTableBody").innerHTML = lHtml || "<tr><td colspan=\'4\' style=\'text-align:center;\'>暫無紀錄</td></tr>"; document.getElementById("ledgerTotal").innerText = totalSum;',
        '    let dList = "<b>👥 註冊司機總清單：</b><br>"; for(let k in data.driverRegistry) { dList += `• ${k} (${data.driverRegistry[k].name}) [${data.driverRegistry[k].role === "cadre"?"車隊幹部":"一般司機"}]<br>`; } document.getElementById("registryDriversList").innerHTML = dList;',
        '    let cList = "<b>🏢 月結記帳客戶名單：</b><br>"; data.clientRegistry.forEach(c => { cList += `• ${c.name}<br>`; }); document.getElementById("registryClientsList").innerHTML = cList;',
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
        '<h2>🚖 車隊工作台系統</h2>',
        '<div id="loginSection" class="box"><h3 style="margin-top:0; text-align:center;">🔐 身分驗證上線</h3><label><b>車牌號碼:</b></label><input type="text" id="plateNum" placeholder="例: ABC-1234" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;"><br><label><b>手機號碼 (密碼):</b></label><input type="password" id="phoneNum" placeholder="請輸入註冊的手機號碼" style="width:100%; padding:10px; box-sizing:border-box; margin: 5px 0 12px 0; font-size:16px;"><button id="toggleBtn" onclick="toggleStatus()" class="btn btn-green">驗證並開啟上班</button></div>',
        '<div id="status" style="font-size:18px; color:gray; margin:15px; font-weight:bold;">🔴 目前下班中 (未定位)</div><div id="roleTag" style="font-size:14px; color:purple; margin-bottom:10px; font-weight:bold;"></div>',
        
        '',
        '<div id="dutyCadreSection" class="box" style="display:none; border:2px solid red; background:#fff5f5;">',
        '    <h3 style="margin-top:0; color:red;">👑 只有您是今日【當值幹部】(決策台)</h3>',
        '    <div id="dutyOrderList">暫無新進案件等待決策</div>',
        '</div>',
        
        '<div id="pop" style="display:none; background:#fff3cd; border:2px solid #ffecb5; padding:20px; border-radius:10px; margin-bottom:15px; text-align:left;"><h3 style="color:#856404; margin-top:0; text-align:center;">🚨 收到任務搶單廣播！</h3><p><b>服務類型：</b><span id="popServiceType" style="color:red; font-weight:bold;"></span></p><p><b>乘客上車點：</b><span id="addrText" style="font-weight:bold;"></span></p><p><small id="popSystemNote" style="color:gray; white-space:pre-wrap;"></small></p><button id="acceptBtn" class="btn btn-green" style="font-size:18px;">立刻按此接單 (搶)</button></div>',
        
        '',
        '<div id="currentMissionSection" class="box" style="display:none; border:2px solid #007bff; background:#f8f9fa;"><h3 style="margin-top:0; color:#007bff; text-align:center;">📍 當前執行中任務</h3><p><b>服務類型：</b><span id="missionServiceType" style="color:red; font-weight:bold;"></span></p><p><b>上車點：</b><span id="missionAddr" style="font-weight:bold;"></span></p><p id="missionEtaRow" style="color:red; font-weight:bold;"></p><p><small id="missionNoteText" style="color:gray; white-space:pre-wrap;"></small></p>',
        '    <div style="background:#e9ecef; padding:10px; border-radius:5px; margin-bottom:10px;">',
        '        <label>📢 <b>即時路況回報給管理員：</b></label><br>',
        '        <button onclick="reportHighway()" class="btn-small btn-purple">🔴 我上高速了</button>',
        '        <button onclick="reportTooLong()" class="btn-small btn-purple">⏳ 等客人太久了</button>',
        '    </div>',
        '    <button onclick="clickNav()" class="btn btn-blue">🧭 開啟 Google Map 導航</button><div id="step1_board" style="margin-top:10px;"><button onclick="reportBoarded()" class="btn btn-orange" style="margin-bottom:8px;">🙋‍♂️ 客人已上車</button><button onclick="cancelMyOrder()" class="btn btn-red" style="padding:8px; font-size:14px;">🚨 我有急事/取消接單(退單)</button></div><div id="step2_complete" style="margin-top:10px; display:none;"><button onclick="showCompleteModal()" class="btn btn-red">🏁 客人已下車 (結帳)</button></div></div>',
        
        '',
        '<div id="myReservationsSection" class="box" style="display:none; border: 2px solid brown; background:#fffdfa;">',
        '    <h3 style="margin-top:0; color:brown;">📅 我的預約行程表 (已承接)</h3>',
        '    <div id="myReservationsList" style="font-size:14px; color:#333;">暫無已排定預約行程</div>',
        '</div>',

        '<div id="scheduleSection" class="box" style="display:none;"><h3 style="margin-top:0; color:#333; border-bottom:2px solid #6f42c1;">📅 全區開放承接清單</h3><div id="scheduleList" style="font-size:14px; color:#555;">暫無可接訂單</div></div>',
        '<div id="completeModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:999; justify-content:center; align-items:center;"><div style="background:white; padding:20px; border-radius:10px; width:90%; max-width:360px; text-align:left;"><h3 style="margin-top:0; text-align:center;">💵 填寫本趟帳單明細</h3><label><b>金額：</b></label><input type="number" id="payAmount" value="150" style="width:100%; padding:10px; margin:5px 0 12px 0;"><br><label><b>付款方式：</b></label><select id="payMethod" style="width:100%; padding:10px; margin:5px 0 12px 0;" onchange="toggleClientSelect()"><option value="現金">💵 現金交易</option><option value="記帳">📝 簽帳 / 公司記帳</option></select><div id="clientSelectDiv" style="display:none; background:#f1f3f5; padding:10px; border-radius:5px; margin-bottom:12px;"><label><b>選擇月結客戶：</b></label><select id="clientSelect" style="width:100%; padding:8px; margin-top:5px;"></select></div><button onclick="submitFinishOrder()" class="btn btn-green">確認並送出明細</button></div></div>',
        
        '<script src="/socket.io/socket.io.js"></script><script>',
        'const socket = io({ transports: ["polling", "websocket"], autoConnect: true }); let isOnline = false; let watchId = null; let currentLat = 0; let currentLng = 0; let currentActiveMission = null; let clientListMemory = []; myRole = "driver"; myPlate = "";',
        'socket.on("login_failed", (data) => { alert(data.message); resetToOfflineInfo(); });',
        'socket.on("login_success", (data) => { isOnline = true; myRole = data.role; myPlate = document.getElementById("plateNum").value.trim().toUpperCase(); document.getElementById("toggleBtn").innerText = "關閉下班 (停止定位)"; document.getElementById("toggleBtn").className = "btn btn-red"; document.getElementById("status").innerText = "🟢 線上空車候客中..."; document.getElementById("status").style.color = "green"; document.getElementById("plateNum").disabled = true; document.getElementById("phoneNum").disabled = true; syncDutyUI(data.currentDutyPlate); document.getElementById("scheduleSection").style.display = "block"; document.getElementById("myReservationsSection").style.display = "block"; socket.emit("get_available_orders"); });',
        'function syncDutyUI(dutyPlate) { let isDuty = (dutyPlate === myPlate); let roleStr = (myRole === "cadre") ? "【👑 車隊幹部】" : "【🚖 一般司機】"; if(isDuty) { roleStr += " ⭐ 今日當值幹部"; document.getElementById("dutyCadreSection").style.display = "block"; } else { document.getElementById("dutyCadreSection").style.display = "none"; } document.getElementById("roleTag").innerText = roleStr; }',
        'function sendLocationUpdate() { const pNum = document.getElementById("plateNum").value.trim().toUpperCase(); const pwd = document.getElementById("phoneNum").value.trim(); if (pNum && pwd && currentLat && currentLng) { socket.emit("driver_location_update", { plateNumber: pNum, phoneNumber: pwd, lat: currentLat, lng: currentLng }); } }',
        'function toggleStatus() { if (!isOnline) { if (navigator.geolocation) { navigator.geolocation.getCurrentPosition((position) => { currentLat = position.coords.latitude; currentLng = position.coords.longitude; sendLocationUpdate(); watchId = navigator.geolocation.watchPosition((pos) => { currentLat = pos.coords.latitude; currentLng = pos.coords.longitude; sendLocationUpdate(); }, null, { enableHighAccuracy: true }); }, () => { alert("請開啟GPS定位權限！"); }, { enableHighAccuracy: true }); } } else { socket.emit("driver_offline", { plateNumber: document.getElementById("plateNum").value.trim() }); resetToOfflineInfo(); } }',
        'function resetToOfflineInfo() { isOnline = false; document.getElementById("toggleBtn").innerText = "驗證並開啟上班"; document.getElementById("toggleBtn").className = "btn btn-green"; document.getElementById("status").innerText = "🔴 目前下班中 (未定位)"; document.getElementById("roleTag").innerText = ""; document.getElementById("dutyCadreSection").style.display = "none"; document.getElementById("scheduleSection").style.display = "none"; document.getElementById("myReservationsSection").style.display = "none"; document.getElementById("currentMissionSection").style.display = "none"; if (watchId) navigator.geolocation.clearWatch(watchId); }',
        'function startReservationMission(orderId) { socket.emit("driver_trigger_reservation", { orderId, plateNumber: myPlate }); }',
        'socket.on("driver_update_lists", (data) => { if(isOnline) syncDutyUI(data.currentDutyPlate); clientListMemory = data.clientRegistry || []; const select = document.getElementById("clientSelect"); select.innerHTML = ""; clientListMemory.forEach(c => { let opt = document.createElement("option"); opt.value = c.name; opt.innerText = c.name; select.appendChild(opt); }); });',
        
        'socket.on("sync_orders_to_driver", (data) => { if(!isOnline) return; let isDuty = (data.currentDutyPlate === myPlate);',
        '    if(isDuty) { let html = ""; data.orders.forEach(o => { if(o.status === "等") { html += `<div style="border-bottom:1px dashed #ccc; padding:8px 0;">📍 <b>[${o.serviceType}-${o.orderType}]</b> ${o.targetAddress}<br><button class="btn-small btn-green" onclick="dutyAction(\'${o.orderId}\', \'接\')">🟢 我要接單</button> <button class="btn-small btn-blue" onclick="dutyAction(\'${o.orderId}\', \'丟\')">🔵 丟 (直接派司機)</button> <button class="btn-small btn-purple" onclick="dutyAction(\'${o.orderId}\', \'讓\')">🟣 讓 (全幹部優先)</button></div>`; } }); document.getElementById("dutyOrderList").innerHTML = html || "暫無需要您作主(等/丟/讓)的訂單"; }',
        '    const listDiv = document.getElementById("scheduleList"); let filterOrders = data.orders.filter(o => { if(["行程已完成", "前往迎客", "旅客已上車"].includes(o.status)) return false; if(o.status === "等") return false; if(myRole === "driver" && o.status === "讓") return false; return true; }); if(filterOrders.length === 0) { listDiv.innerHTML = "暫無開放承接的訂單"; } else { let h = ""; filterOrders.forEach(o => { let typeTag = o.orderType === "預約單" ? "<span style=\'color:brown;\'>[📅預約]</span>" : "<span style=\'color:green;\'>[⚡即時]</span>"; h += `<div style="background:#f1f3f5; padding:8px; border-left:4px solid #007bff; margin-top:5px;">${typeTag} <b>[${o.serviceType}]</b> ${o.targetAddress}<br><small style="color:gray;">時間: ${o.bookingTime}</small><br><button class="btn-small btn-green" onclick="clickTakeOrder(\'${o.orderId}\')">立刻承接此單</button></div>`; }); listDiv.innerHTML = h; }',
        '    const resDiv = document.getElementById("myReservationsList"); let myResOrders = data.orders.filter(o => o.driverId === myPlate && o.orderType === "預約單"); if(myResOrders.length === 0) { resDiv.innerHTML = "暫無已排定預約行程"; } else { let rh = ""; myResOrders.forEach(o => { let actionBtn = o.status === "已預約排定" ? `<button class="btn-small btn-blue" onclick="startReservationMission(\'${o.orderId}\')">🚀 時間到：現在出發迎客</button>` : `<span style="color:orange;font-weight:bold;">[狀態: ${o.status}]</span>`; rh += `<div style="background:#fff; border:1px solid brown; padding:8px; margin-top:5px; border-radius:4px;"><b>[${o.serviceType}]</b> ${o.targetAddress}<br><small>預約開車時間: ${o.bookingTime}</small><br>${actionBtn}</div>`; }); resDiv.innerHTML = rh; }',
        '});',
        
        'function dutyAction(orderId, action) { socket.emit("duty_cadre_decision", { orderId, action, plateNumber: myPlate, lat: currentLat, lng: currentLng }); }',
        'function clickTakeOrder(orderId) { socket.emit("accept_order", { orderId, plateNumber: myPlate, lat: currentLat, lng: currentLng }); }',
        'function reportHighway() { if(currentActiveMission) { socket.emit("driver_live_report", { orderId: currentActiveMission.orderId, reportType: "highway" }); } }',
        'function reportTooLong() { if(currentActiveMission) { socket.emit("driver_live_report", { orderId: currentActiveMission.orderId, reportType: "waiting_too_long" }); } }',
        
        'socket.on("new_order_request", (data) => { if(currentActiveMission) return; if(data.targetScope === "cadre_only" && myRole !== "cadre") return; document.getElementById("popServiceType").innerText = data.serviceType + " (" + data.orderType + ")"; document.getElementById("addrText").innerText = data.targetAddress; document.getElementById("popSystemNote").innerText = "內建備註規範：\n" + data.systemNote; document.getElementById("pop").style.display = "block"; document.getElementById("acceptBtn").onclick = function() { socket.emit("accept_order", { orderId: data.orderId, plateNumber: myPlate, lat: currentLat, lng: currentLng }); }; });',
        
        'socket.on("accept_result", (data) => { document.getElementById("pop").style.display = "none"; if(data.success) { ',
        '        if(data.order.orderType === "即時單" || data.isTriggeredReservation) { currentActiveMission = data.order; document.getElementById("status").innerText = "🚖 任務執行中..."; document.getElementById("status").style.color = "blue"; document.getElementById("missionServiceType").innerText = data.order.serviceType; document.getElementById("missionAddr").innerText = data.order.targetAddress; document.getElementById("missionEtaRow").innerText = "⏳ 預計 " + (data.eta || "?") + " 分鐘後抵達"; document.getElementById("missionNoteText").innerText = "規範條款：\n" + data.order.systemNote; document.getElementById("currentMissionSection").style.display = "block"; document.getElementById("step1_board").style.display = "block"; document.getElementById("step2_complete").style.display = "none";',
        '            window.location.href = "https://www.google.com/maps/search/?api=1&query=" + data.order.targetLat + "," + data.order.targetLng;',
        '        } else { alert("📅 預約單承接成功！已妥善放入下方的【我的預約行程表】，時間到記得點擊出發。"); }',
        '    } else { alert(data.message); } socket.emit("get_available_orders"); });',
        
        'function cancelMyOrder() { if(!currentActiveMission) return; if(confirm("確定要取消這筆接單任務嗎？(此單會重新釋回調度池)")) { socket.emit("driver_cancel_order", { orderId: currentActiveMission.orderId, plateNumber: myPlate }); document.getElementById("currentMissionSection").style.display = "none"; currentActiveMission = null; document.getElementById("status").innerText = "🟢 線上空車候客中..."; document.getElementById("status").style.color = "green"; } }',
        'function clickNav() { if(currentActiveMission) window.open("https://www.google.com/maps/search/?api=1&query=" + currentActiveMission.targetLat + "," + currentActiveMission.targetLng, "_blank"); }',
        'function reportBoarded() { socket.emit("driver_report_status", { orderId: currentActiveMission.orderId, status: "旅客已上車", plateNumber: myPlate }); document.getElementById("status").innerText = "🚖 運送服務中..."; document.getElementById("step1_board").style.display = "none"; document.getElementById("step2_complete").style.display = "block"; }',
        'function showCompleteModal() { document.getElementById("completeModal").style.display = "flex"; }',
        'function toggleClientSelect() { document.getElementById("clientSelectDiv").style.display = (document.getElementById("payMethod").value === "記帳") ? "block" : "none"; }',
        'function submitFinishOrder() { const amt = parseInt(document.getElementById("payAmount").value) || 0; const method = document.getElementById("payMethod").value; let chosenClient = (method === "記帳") ? document.getElementById("clientSelect").value : ""; if(method === "記帳" && !chosenClient) { alert("請選擇月結客戶"); return; } socket.emit("driver_finish_order", { orderId: currentActiveMission.orderId, plateNumber: myPlate, amount: amt, payMethod: method, clientName: chosenClient }); document.getElementById("completeModal").style.display = "none"; document.getElementById("currentMissionSection").style.display = "none"; currentActiveMission = null; document.getElementById("status").innerText = "🟢 線上空車候客中..."; document.getElementById("status").style.color = "green"; }',
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

    let newOrder = { 
        orderId, targetAddress, targetLat, targetLng, orderType, bookingTime, serviceType,
        systemNote: note,
        status: "等", 
        driverId: null, driverName: null, paymentReport: null, eta: null,
        reportedHighSpeed: false, reportedWaitingTooLong: false, 
        createdAt: Date.now() 
    };
    
    globalOrders.push(newOrder);
    broadcastAdminData();
    broadcastToDrivers();
    res.json({ status: "processing", orderId });
});

// ─── 📡 Socket 中央動態通訊 ───
io.on('connection', (socket) => {
    broadcastAdminData();
    socket.emit('driver_update_lists', { clientRegistry, currentDutyPlate: getCurrentDutyPlate() });
    
    socket.on('get_available_orders', () => {
        socket.emit('sync_orders_to_driver', { orders: globalOrders, currentDutyPlate: getCurrentDutyPlate() });
    });

    // 管理者修改 6 小時排班
    socket.on('admin_update_6h_duty', (data) => {
        if(data.slotKey && data.plate) {
            dutySchedule6Hours[data.slotKey] = data.plate;
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

    // 司機上線上傳定位 & 登入驗證（已修正：比對正確密碼與欄位）
    socket.on('driver_location_update', (data) => {
        const pNum = data.plateNumber.toUpperCase();
        const registeredDriver = driverRegistry[pNum];

        // 核心修復：如果名單查無此人，或是密碼（phone）不吻合
        if (!registeredDriver || registeredDriver.phone !== data.phoneNumber) {
            socket.emit('login_failed', { message: "❌ 登入失敗：車牌號碼或手機密碼不正確！" });
            return;
        }

        let wasBusy = activeDrivers[pNum] ? activeDrivers[pNum].isBusy : false;
        activeDrivers[pNum] = { id: pNum, name: registeredDriver.name, lat: data.lat, lng: data.lng, socketId: socket.id, isBusy: wasBusy };
        
        socket.emit('login_success', { role: registeredDriver.role, currentDutyPlate: getCurrentDutyPlate() });
        broadcastAdminData();
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

        if (ord && ["丟", "讓"].includes(ord.status)) {
            let regInfo = driverRegistry[pNum];
            if(regInfo.role === 'driver' && ord.status === "讓") {
                socket.emit('accept_result', { success: false, message: "此單目前由值班幹部設為【幹部優先讓單】，一般司機暫無法承接。" });
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
            socket.emit('accept_result', { success: false, message: "單已被處理、取消或不存在。" });
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
    console.log('\n🚀 系統已完全優化！主頁瘦身、設定分頁獨立、6小時排班、登入完全修復！');
});
