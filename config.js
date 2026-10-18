// ===== ตั้งค่าแอป =====
// วาง URL ของ Apps Script Web App ที่ได้ตอน Deploy (ลงท้ายด้วย /exec)
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/วาง_DEPLOYMENT_ID_ตรงนี้/exec',

  // ที่อยู่โมเดล AI จดจำใบหน้า (ไม่ต้องแก้)
  MODEL_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/',

  // จำนวนภาพตอนลงทะเบียนใบหน้า
  ENROLL_SAMPLES: 5,

  // เวลาที่ให้ทำ liveness (หันหน้า) ก่อนหมดเวลา (วินาที)
  LIVENESS_TIMEOUT_SEC: 15
};
