/* ระบบเช็คชื่อพนักงาน — แอปหน้าบ้าน
 * กล้องหน้า (บังคับ) + GPS (บังคับ) + Face recognition (face-api, ทำงานบนมือถือ)
 * แอปส่งเฉพาะ "ลายใบหน้า" 128 ตัวเลข + รูป + พิกัด ให้เซิร์ฟเวอร์ตัดสินว่าเป็นใคร
 */
(() => {
  'use strict';
  const C = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    cfg: null,
    pos: null,          // {lat, lng, acc, t}
    posErr: null,       // GeolocationPositionError.code
    ready: false,
    busy: false,
    offsetMs: 0,        // เวลาเซิร์ฟเวอร์ - เวลาเครื่อง
    pin: null,
    wakeLock: null
  };

  class UserErr extends Error {
    constructor(title, body) { super(title); this.title = title; this.body = body || ''; }
  }

  // ---------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------
  const hint = (t) => { $('hint').textContent = t; };
  const guide = (cls) => { $('guide').className = cls || ''; };
  const arrow = (on) => $('arrow').classList.toggle('show', !!on);

  function setChip(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
  }

  function setLoading(title, body, pct) {
    $('loading').classList.add('show');
    $('loadSpin').style.display = '';
    $('loadRetry').style.display = 'none';
    if (title) $('loadTitle').textContent = title;
    if (body !== undefined) $('loadBody').textContent = body;
    if (pct !== undefined) $('loadBar').style.width = pct + '%';
  }

  /** หน้าจอบล็อก: ใช้งานต่อไม่ได้จนกว่าจะแก้ (เช่น ไม่ให้สิทธิ์กล้อง/GPS) */
  function block(title, body, retry) {
    $('loading').classList.add('show');
    $('loadSpin').style.display = 'none';
    $('loadTitle').textContent = '⚠️ ' + title;
    $('loadBody').textContent = body;
    $('loadBar').parentElement.style.display = 'none';
    const btn = $('loadRetry');
    btn.style.display = '';
    btn.onclick = retry || (() => location.reload());
  }

  function unblock() {
    $('loading').classList.remove('show');
    $('loadBar').parentElement.style.display = '';
  }

  function setButtons() {
    const ok = state.ready && !state.busy && gpsFresh();
    $('btnIn').disabled = !ok;
    $('btnOut').disabled = !ok;
  }

  let resultTimer = null;
  function showResult({ kind, icon, name, type, time, meta }) {
    const el = $('result');
    el.className = 'overlay show ' + kind;
    $('resIcon').textContent = icon;
    $('resName').textContent = name || '';
    $('resType').textContent = type || '';
    $('resTime').textContent = time || '';
    $('resMeta').textContent = meta || '';
    clearTimeout(resultTimer);
    resultTimer = setTimeout(closeResult, kind === 'err' ? 7000 : 5000);
    try { navigator.vibrate && navigator.vibrate(kind === 'err' ? [80, 60, 80] : 200); } catch (e) {}
  }
  function closeResult() { $('result').classList.remove('show'); clearTimeout(resultTimer); }
  $('resClose').onclick = closeResult;

  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'th-TH';
      u.rate = 1.05;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---------------------------------------------------------------
  // Clock (ใช้เวลาเซิร์ฟเวอร์เป็นหลัก)
  // ---------------------------------------------------------------
  function tick() {
    const now = new Date(Date.now() + state.offsetMs);
    $('clock').textContent = now.toLocaleTimeString('th-TH', { hour12: false, timeZone: 'Asia/Bangkok' });
    $('date').textContent = now.toLocaleDateString('th-TH', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok'
    });
  }
  setInterval(tick, 1000);
  tick();

  // ---------------------------------------------------------------
  // API
  // ---------------------------------------------------------------
  async function api(payload, timeoutMs = 30000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // ไม่ใส่ Content-Type เพื่อให้เป็น simple request (Apps Script ไม่รองรับ CORS preflight)
      const r = await fetch(C.API_URL, { method: 'POST', body: JSON.stringify(payload), signal: ctl.signal, redirect: 'follow' });
      const txt = await r.text();
      try { return JSON.parse(txt); }
      catch (e) { throw new UserErr('เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ', 'ตรวจว่า Deploy Web app แบบ "Anyone" และ URL ใน config.js ถูกต้อง'); }
    } catch (e) {
      if (e instanceof UserErr) throw e;
      if (e.name === 'AbortError') throw new UserErr('หมดเวลาเชื่อมต่อ', 'อินเทอร์เน็ตช้าหรือหลุด ลองใหม่อีกครั้ง');
      throw new UserErr('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'ตรวจสอบอินเทอร์เน็ต แล้วลองใหม่');
    } finally {
      clearTimeout(t);
    }
  }

  function deviceInfo() {
    let id = null;
    try {
      id = localStorage.getItem('deviceId');
      if (!id) { id = 'D-' + Math.random().toString(36).slice(2, 8).toUpperCase(); localStorage.setItem('deviceId', id); }
    } catch (e) { id = 'D-NOSTORE'; }
    const m = navigator.userAgent.match(/\(([^)]+)\)/);
    return id + ' | ' + (m ? m[1] : navigator.userAgent).slice(0, 120);
  }

  // ---------------------------------------------------------------
  // Camera (บังคับกล้องหน้า)
  // ---------------------------------------------------------------
  async function startCamera() {
    if (!window.isSecureContext) {
      throw new UserErr('ต้องเปิดผ่าน https', 'กล้องและ GPS ใช้ได้เฉพาะเว็บที่เป็น https เท่านั้น');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new UserErr('เบราว์เซอร์ไม่รองรับกล้อง', 'กรุณาเปิดด้วย Google Chrome เวอร์ชันล่าสุด');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      });
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        throw new UserErr('ไม่ได้อนุญาตให้ใช้กล้อง',
          'แตะไอคอน 🔒 ข้างช่อง URL (หรือ ตั้งค่าแอป > สิทธิ์) แล้วเปิด "กล้อง" เป็นอนุญาต จากนั้นกด ลองใหม่');
      }
      throw new UserErr('เปิดกล้องไม่ได้', 'ปิดแอปอื่นที่ใช้กล้องอยู่ แล้วกด ลองใหม่\n(' + e.name + ')');
    }
    const track = stream.getVideoTracks()[0];
    const fm = track.getSettings && track.getSettings().facingMode;
    if (fm === 'environment') {
      stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: 'user' } } });
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (video.readyState < 2) await new Promise((r) => (video.onloadeddata = r));
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      state.ready = false; setButtons();
      block('กล้องถูกปิด', 'กล้องหยุดทำงาน กด ลองใหม่ เพื่อเปิดอีกครั้ง');
    });
  }

  // ---------------------------------------------------------------
  // GPS (บังคับเปิด)
  // ---------------------------------------------------------------
  let gpsWatchId = null;
  function startGps() {
    if (!('geolocation' in navigator)) {
      block('อุปกรณ์ไม่รองรับ GPS', 'ไม่สามารถใช้ระบบเช็คชื่อบนเครื่องนี้ได้');
      return;
    }
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = navigator.geolocation.watchPosition(
      (p) => {
        state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
        state.posErr = null;
        renderGps();
      },
      (err) => {
        state.posErr = err.code;
        if (err.code === 1 || err.code === 2) state.pos = null; // ปิด GPS / ถอนสิทธิ์
        renderGps();
        if (err.code === 1) gpsDeniedBlock();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  function gpsDeniedBlock() {
    block('ไม่ได้อนุญาตให้ใช้ตำแหน่ง (GPS)',
      'ระบบต้องใช้ตำแหน่งเพื่อยืนยันว่าอยู่ที่ร้าน\nแตะไอคอน 🔒 ข้างช่อง URL > สิทธิ์ > ตำแหน่ง > อนุญาต แล้วกด ลองใหม่');
  }

  // watchPosition อาจไม่ส่งค่าใหม่ถ้าเครื่องวางนิ่ง → เริ่มติดตามใหม่ทุก 30 วิ เพื่อได้พิกัดสดเสมอ
  // ปุ่มกดได้เฉพาะเมื่อมีพิกัดที่ได้มาไม่เกิน 90 วินาที
  const gpsFresh = () => !!state.pos && Date.now() - state.pos.t < 90000;
  setInterval(() => { if (gpsWatchId !== null && state.posErr !== 1 && !state.busy) startGps(); }, 30000);

  /** สาขาที่ใกล้ที่สุดจากตำแหน่งปัจจุบัน (เซิร์ฟเวอร์ตรวจซ้ำอีกรอบ) */
  function nearestBranch() {
    if (!state.pos || !state.cfg || !state.cfg.branches || !state.cfg.branches.length) return null;
    const R = 6371000, rad = (x) => (x * Math.PI) / 180;
    let best = null;
    state.cfg.branches.forEach((b) => {
      const dLat = rad(b.lat - state.pos.lat), dLng = rad(b.lng - state.pos.lng);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(state.pos.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
      const d = 2 * R * Math.asin(Math.sqrt(a));
      if (!best || d < best.distance) best = Object.assign({}, b, { distance: d });
    });
    return best;
  }

  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' กม.' : Math.round(m) + ' ม.');

  function renderGps() {
    let here = null;
    if (state.posErr === 2 && !gpsFresh()) setChip('gpsChip', '📍 GPS ปิดอยู่ — เปิด Location', 'bad');
    else if (state.posErr === 1) setChip('gpsChip', '📍 ไม่ได้อนุญาต GPS', 'bad');
    else if (!gpsFresh()) setChip('gpsChip', '📍 กำลังหาตำแหน่ง…');
    else {
      const nb = nearestBranch();
      const acc = Math.round(state.pos.acc);
      if (!nb) setChip('gpsChip', '📍 ±' + acc + ' ม.', '');
      else if (nb.distance <= nb.radiusM) {
        here = nb;
        setChip('gpsChip', '📍 ' + nb.name + ' (' + fmtDist(nb.distance) + ' ±' + acc + ')', 'ok');
      } else setChip('gpsChip', '📍 นอกสาขา · ใกล้สุด ' + nb.name + ' ' + fmtDist(nb.distance), 'bad');
    }
    if (state.cfg) $('shopName').textContent = here ? state.cfg.shopName + ' · ' + here.name : state.cfg.shopName;
    setButtons();
  }
  setInterval(renderGps, 5000);

  // ---------------------------------------------------------------
  // Face AI
  // ---------------------------------------------------------------
  const detOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

  async function loadModels() {
    if (!window.faceapi) throw new UserErr('โหลดระบบจดจำใบหน้าไม่สำเร็จ', 'ตรวจสอบอินเทอร์เน็ต แล้วกด ลองใหม่');
    // เลือกตัวประมวลผล: GPU (webgl) เร็วสุด → wasm → cpu (มือถือรุ่นเก่า)
    const tf = faceapi.tf;
    let backend = null;
    try { if (await tf.setBackend('webgl')) backend = 'webgl'; } catch (e) {}
    if (!backend) {
      try {
        tf.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@' + tf.version['tfjs-core'] + '/dist/');
        if (await tf.setBackend('wasm')) backend = 'wasm';
      } catch (e) {}
    }
    if (!backend) await tf.setBackend('cpu');
    await tf.ready();
    console.log('tf backend:', tf.getBackend());
    setLoading('กำลังโหลดโมเดล', 'ตรวจจับใบหน้า (1/3)', 35);
    await faceapi.nets.tinyFaceDetector.loadFromUri(C.MODEL_URL);
    setLoading(null, 'จุดสำคัญบนใบหน้า (2/3)', 50);
    await faceapi.nets.faceLandmark68Net.loadFromUri(C.MODEL_URL);
    setLoading(null, 'จดจำใบหน้า (3/3)', 65);
    await faceapi.nets.faceRecognitionNet.loadFromUri(C.MODEL_URL);
  }

  /** มุมหันซ้าย-ขวา: ปลายจมูกเลื่อนไปตามแนวเส้นตาเท่าไร / ระยะห่างตา (หน้าตรง ≈ 0)
   *  วัดตามแนวเส้นตา จึงไม่หลอกเมื่อเอียงคอหรือเอียงรูป */
  function yawOf(lm) {
    const p = lm.positions;
    const avg = (a, b) => {
      let x = 0, y = 0;
      for (let i = a; i <= b; i++) { x += p[i].x; y += p[i].y; }
      const n = b - a + 1;
      return { x: x / n, y: y / n };
    };
    const L = avg(36, 41), R = avg(42, 47), nose = p[30];
    const ex = R.x - L.x, ey = R.y - L.y;
    const eyeDist = Math.hypot(ex, ey) || 1;
    const mx = (L.x + R.x) / 2, my = (L.y + R.y) / 2;
    return ((nose.x - mx) * ex + (nose.y - my) * ey) / (eyeDist * eyeDist);
  }

  const faceRatio = (det) => det.detection.box.width / (video.videoWidth || 1);

  function euclid(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }

  function snapshot() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const W = 360, H = 480;
    let sw = vw, sh = (vw * 4) / 3;
    if (sh > vh) { sh = vh; sw = (vh * 3) / 4; }
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.translate(W, 0); g.scale(-1, 1);
    g.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const stamp = new Date(Date.now() + state.offsetMs).toLocaleString('th-TH', { hour12: false, timeZone: 'Asia/Bangkok' });
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, H - 26, W, 26);
    g.fillStyle = '#fff'; g.font = '14px monospace'; g.fillText(stamp, 8, H - 8);
    return c.toDataURL('image/jpeg', 0.72);
  }

  /** เก็บ descriptor จากหลายเฟรมที่หน้าตรง แล้วเฉลี่ย */
  async function captureDescriptor(n = 3, maxTries = 15) {
    const list = [];
    let photo = null;
    for (let i = 0; i < maxTries && list.length < n; i++) {
      const r = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks().withFaceDescriptor();
      if (r && Math.abs(yawOf(r.landmarks)) < 0.18 && faceRatio(r) >= 0.16) {
        list.push(Array.from(r.descriptor));
        if (!photo) photo = snapshot();
      } else if (r && faceRatio(r) < 0.16) {
        hint('ขยับหน้าเข้าใกล้กล้องอีกนิด');
      }
      await sleep(40);
    }
    if (list.length < Math.min(2, n)) return null;
    const mean = new Array(128).fill(0);
    list.forEach((d) => d.forEach((x, i) => (mean[i] += x / list.length)));
    return { descriptor: mean.map((x) => Math.round(x * 10000) / 10000), photo };
  }

  /** Liveness: ต้องหันหน้าไปด้านข้าง แล้วกลับมาตรง (รูปถ่าย/รูปในจอ ทำไม่ได้) */
  async function runLiveness() {
    const deadline = Date.now() + C.LIVENESS_TIMEOUT_SEC * 1000;
    let phase = 0;
    let turnDesc = null;
    guide('live');
    hint('มองกล้องตรง ๆ');
    while (Date.now() < deadline) {
      const r = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks();
      if (!r) { hint('ไม่เห็นใบหน้า — ขยับหน้าเข้ากรอบ'); await sleep(50); continue; }
      const yaw = Math.abs(yawOf(r.landmarks));
      if (phase === 0 && yaw < 0.15) {
        phase = 1; arrow(true);
        hint('หันหน้าไปด้านข้างช้า ๆ (ซ้ายหรือขวาก็ได้)');
      } else if (phase === 1 && yaw > 0.28) {
        // เก็บลายหน้าตอนหันไว้ เพื่อเทียบว่าเป็นคนเดียวกับตอนหันกลับ
        const d = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks().withFaceDescriptor();
        if (d && Math.abs(yawOf(d.landmarks)) > 0.2) {
          turnDesc = Array.from(d.descriptor);
          phase = 2; arrow(false);
          hint('ดีมาก! หันกลับมามองกล้อง');
        }
      } else if (phase === 2 && yaw < 0.15) {
        arrow(false);
        return { ok: true, turnDesc };
      }
      await sleep(20);
    }
    arrow(false);
    return { ok: false };
  }

  // ---------------------------------------------------------------
  // Preview loop: บอกว่าเห็นหน้าหรือยัง
  // ---------------------------------------------------------------
  async function previewLoop() {
    while (true) {
      if (state.ready && !state.busy && !document.hidden && video.readyState >= 2) {
        try {
          const r = await faceapi.detectSingleFace(video, detOpts());
          if (state.busy) { await sleep(300); continue; }
          if (r) {
            guide('face');
            setChip('faceChip', '🙂 พบใบหน้า', 'ok');
            hint(gpsFresh() ? 'มองกล้องในกรอบ แล้วกด เข้างาน / ออกงาน' : 'รอตำแหน่ง GPS… (เปิด Location ของเครื่อง)');
          } else {
            guide('');
            setChip('faceChip', '🙂 ไม่พบใบหน้า', '');
            hint('ให้ใบหน้าอยู่ในกรอบวงรี');
          }
        } catch (e) { /* ignore */ }
      }
      await sleep(350);
    }
  }

  // ---------------------------------------------------------------
  // Check-in / out
  // ---------------------------------------------------------------
  async function doCheck(type) {
    if (state.busy) return;
    if (!gpsFresh()) {
      showResult({ kind: 'err', icon: '📍', name: 'ยังไม่ได้ตำแหน่ง GPS', meta: 'เปิด Location ของเครื่อง (ดึงแถบด้านบนลง > ตำแหน่ง) แล้วรอสักครู่' });
      return;
    }
    state.busy = true; setButtons();
    try {
      let live = false;
      let turnDesc = null;
      if (state.cfg.requireLiveness) {
        const lv = await runLiveness();
        if (!lv.ok) throw new UserErr('ไม่ผ่านการตรวจหันหน้า', 'มองกล้อง → หันหน้าไปด้านข้างช้า ๆ → หันกลับมามองกล้อง');
        live = true; turnDesc = lv.turnDesc;
      }
      guide('good');
      hint('ถือนิ่ง ๆ มองกล้อง…');
      const cap = await captureDescriptor(3);
      if (!cap) throw new UserErr('จับใบหน้าไม่ได้', 'ให้ใบหน้าอยู่ในกรอบ หน้าตรง แสงสว่างพอ แล้วลองใหม่');
      if (turnDesc && euclid(turnDesc, cap.descriptor) > 0.75) {
        throw new UserErr('ใบหน้าเปลี่ยนระหว่างตรวจ', 'กรุณาทำใหม่โดยคนเดียวกันตลอดการสแกน');
      }

      if (!gpsFresh()) throw new UserErr('ไม่ได้ตำแหน่ง GPS', 'เปิด Location ของเครื่อง แล้วรอสักครู่');
      const p = state.pos;
      hint('กำลังส่งข้อมูล…');
      const res = await api({
        action: 'checkin', type,
        descriptor: cap.descriptor, liveness: live,
        lat: p.lat, lng: p.lng, accuracy: p.acc,
        photo: cap.photo, device: deviceInfo(),
        clientTime: new Date().toISOString()
      });

      if (res.ok) {
        const isIn = res.type === 'IN';
        showResult({
          kind: isIn ? 'in' : 'out', icon: isIn ? '✅' : '👋',
          name: res.name, type: isIn ? 'เข้างาน' : 'ออกงาน', time: res.time.slice(0, 5),
          meta: res.branchName + ' · ความเหมือน ' + res.similarity + '% · ห่าง ' + res.distanceM + ' ม.'
        });
        speak((isIn ? 'สวัสดี ' : 'ขอบคุณ ') + res.name);
      } else {
        showResult({ kind: 'err', icon: res.duplicate ? '⏱' : '❌', name: res.duplicate ? 'สแกนซ้ำ' : 'ไม่สำเร็จ', type: '', meta: res.message });
      }
    } catch (e) {
      const t = e instanceof UserErr ? e.title : 'เกิดข้อผิดพลาด';
      const b = e instanceof UserErr ? e.body : String(e.message || e);
      showResult({ kind: 'err', icon: '⚠️', name: t, meta: b });
    } finally {
      state.busy = false; guide(''); arrow(false); setButtons();
    }
  }

  $('btnIn').onclick = () => doCheck('IN');
  $('btnOut').onclick = () => doCheck('OUT');

  // ---------------------------------------------------------------
  // Admin: ลงทะเบียนใบหน้า
  // ---------------------------------------------------------------
  const adminEl = $('admin');
  function openAdmin() {
    if (state.busy || !state.ready) return;
    adminEl.classList.add('show');
    if (state.pin) showEnrollStep();
    else { $('pinStep').style.display = ''; $('enrollStep').style.display = 'none'; $('pin').value = ''; setTimeout(() => $('pin').focus(), 50); }
  }
  function closeAdmin() { adminEl.classList.remove('show'); }
  $('adminBtn').onclick = openAdmin;
  adminEl.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeAdmin));

  $('pinOk').onclick = async () => {
    const pin = $('pin').value.trim();
    if (!pin) return;
    $('pinOk').disabled = true;
    try {
      const r = await api({ action: 'verifyPin', pin });
      if (!r.ok) { $('pin').value = ''; $('pin').placeholder = 'PIN ไม่ถูกต้อง'; return; }
      state.pin = pin;
      showEnrollStep();
    } catch (e) {
      $('pin').placeholder = e.title || 'เชื่อมต่อไม่ได้';
    } finally { $('pinOk').disabled = false; }
  };

  async function showEnrollStep() {
    $('pinStep').style.display = 'none';
    $('enrollStep').style.display = '';
    $('empList').textContent = 'กำลังโหลดรายชื่อ…';
    try {
      const r = await api({ action: 'employees', pin: state.pin });
      if (!r.ok) { $('empList').textContent = r.message; return; }
      $('empList').textContent = r.employees.length
        ? 'ลงทะเบียนแล้ว ' + r.employees.length + ' คน: ' + r.employees.map((e) => e.empId + ' ' + e.name).join(', ')
        : 'ยังไม่มีพนักงานลงทะเบียน';
    } catch (e) { $('empList').textContent = ''; }
  }

  $('enrollStart').onclick = async () => {
    const empId = $('empId').value.trim();
    const name = $('empName').value.trim();
    if (!empId || !name) { (empId ? $('empName') : $('empId')).focus(); return; }
    closeAdmin();
    await enroll(empId, name);
  };

  async function enroll(empId, name) {
    state.busy = true; setButtons();
    const banner = $('enrollBanner');
    banner.textContent = 'ลงทะเบียน: ' + name + ' (' + empId + ')';
    banner.classList.add('show');
    const prompts = ['มองกล้องตรง ๆ', 'หันซ้ายเล็กน้อย', 'หันขวาเล็กน้อย', 'เงยหน้าเล็กน้อย', 'ก้มหน้าเล็กน้อย', 'มองตรงอีกครั้ง', 'ยิ้มเล็กน้อย'];
    const total = Math.max(3, C.ENROLL_SAMPLES || 5);
    const descs = [];
    let photo = null;
    try {
      for (let i = 0; i < total; i++) {
        const prompt = i === total - 1 ? 'มองกล้องตรง ๆ' : prompts[i % prompts.length];
        guide('live');
        hint('(' + (i + 1) + '/' + total + ') ' + prompt);
        await sleep(1300);
        let got = null;
        for (let k = 0; k < 20 && !got; k++) {
          const r = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks().withFaceDescriptor();
          if (r && r.detection.score > 0.6 && faceRatio(r) >= 0.16) got = r;
          else await sleep(80);
        }
        if (!got) throw new UserErr('จับใบหน้าไม่ได้', 'ให้ใบหน้าอยู่ในกรอบ แสงสว่างพอ แล้วลงทะเบียนใหม่');
        descs.push(Array.from(got.descriptor).map((x) => Math.round(x * 10000) / 10000));
        if (!photo && Math.abs(yawOf(got.landmarks)) < 0.15) photo = snapshot();
        guide('good');
        try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
        await sleep(250);
      }
      if (!photo) photo = snapshot();
      hint('กำลังบันทึก…');
      const r = await api({ action: 'enroll', pin: state.pin, empId, name, descriptors: descs, photo });
      showResult({ kind: r.ok ? 'in' : 'err', icon: r.ok ? '🧑‍🍳' : '❌', name: r.ok ? name : 'ลงทะเบียนไม่สำเร็จ', type: r.ok ? 'ลงทะเบียนแล้ว' : '', meta: r.message });
      if (r.ok) { $('empId').value = ''; $('empName').value = ''; }
    } catch (e) {
      showResult({ kind: 'err', icon: '⚠️', name: e.title || 'ผิดพลาด', meta: e.body || String(e.message || e) });
    } finally {
      banner.classList.remove('show');
      state.busy = false; guide(''); setButtons();
    }
  }

  // ---------------------------------------------------------------
  // Wake lock (กันจอดับ ถ้าใช้เป็นเครื่องประจำร้าน)
  // ---------------------------------------------------------------
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !document.hidden) state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { keepAwake(); if (video.paused) video.play().catch(() => {}); }
  });

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function boot() {
    try {
      if (!C || !C.API_URL || C.API_URL.includes('วาง_')) {
        throw new UserErr('ยังไม่ได้ตั้งค่า', 'ใส่ URL ของ Apps Script ในไฟล์ config.js ก่อนใช้งาน');
      }
      setLoading('กำลังเปิดกล้อง', 'กรุณากด "อนุญาต" เมื่อมีหน้าต่างถามสิทธิ์', 10);
      await startCamera();
      setChip('faceChip', '🙂 กล้องพร้อม', '');

      setLoading('กำลังเปิด GPS', 'กรุณากด "อนุญาต" ให้ใช้ตำแหน่ง', 20);
      startGps();

      await loadModels();

      setLoading('กำลังเชื่อมต่อเซิร์ฟเวอร์', 'ดึงการตั้งค่าร้าน', 80);
      const cfg = await api({ action: 'config' });
      if (!cfg.ok) throw new UserErr('โหลดการตั้งค่าไม่สำเร็จ', cfg.message || '');
      state.cfg = cfg;
      state.offsetMs = new Date(cfg.serverTime).getTime() - Date.now();
      $('shopName').textContent = cfg.shopName;

      setLoading('กำลังอุ่นเครื่อง AI', 'ครั้งแรกอาจช้าเล็กน้อย', 92);
      try { await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks().withFaceDescriptor(); } catch (e) {}

      $('loadBar').style.width = '100%';
      state.ready = true;
      unblock();
      if (state.posErr === 1) gpsDeniedBlock();
      renderGps();
      keepAwake();
      previewLoop();
    } catch (e) {
      console.error(e);
      if (e instanceof UserErr) block(e.title, e.body);
      else block('เริ่มระบบไม่สำเร็จ', String(e.message || e));
    }
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  boot();
})();
