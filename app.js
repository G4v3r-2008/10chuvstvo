(() => {
  "use strict";

  /* Тестовые параметры в адресе:
     ?from=55.7539,37.6208  — подменить стартовую точку (для проверки не в Москве)
     ?sim=1                 — имитировать ходьбу по маршруту без GPS */
  const qs = new URLSearchParams(location.search);
  const SIM = qs.has("sim");
  const FROM = qs.get("from");
  const OFF_ROUTE_M = 45;
  const $ = (id) => document.getElementById(id);

  /* ---------- Озвучка ---------- */
  const synth = window.speechSynthesis;
  let ruVoice = null;
  function pickVoice() {
    if (!synth) return;
    ruVoice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith("ru")) || null;
  }
  if (synth) { synth.onvoiceschanged = pickVoice; pickVoice(); }

  let lastSpoken = "";
  function say(text, { interrupt = true, remember = true } = {}) {
    if (remember) lastSpoken = text;
    $("status").textContent = text;
    return new Promise((resolve) => {
      if (!synth) return resolve();
      if (interrupt) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ru-RU";
      if (ruVoice) u.voice = ruVoice;
      u.rate = 0.95;
      u.onend = u.onerror = () => resolve();
      synth.speak(u);
    });
  }

  let audioCtx;
  function beep(freq = 880, ms = 120) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = 0.15;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); setTimeout(() => o.stop(), ms);
    } catch (_) { /* без звука — не страшно */ }
  }
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };

  /* ---------- Компас ---------- */
  // Направление телефона относительно севера (0..360) по датчикам, плюс курс по GPS при ходьбе.
  function tiltCompensated(alpha, beta, gamma) {
    const r = Math.PI / 180;
    const ca = Math.cos(alpha * r), sa = Math.sin(alpha * r);
    const cb = Math.cos(beta * r), sb = Math.sin(beta * r);
    const cg = Math.cos(gamma * r), sg = Math.sin(gamma * r);
    let e, n;
    if (Math.abs(cb * cg) > 0.7) {       // телефон лежит: куда смотрит верхний край
      e = -sa * cb; n = ca * cb;
    } else {                             // телефон держат вертикально: куда смотрит задняя сторона
      e = -(ca * sg + sa * sb * cg);
      n = -(sa * sg - ca * sb * cg);
    }
    return (Math.atan2(e, n) * 180 / Math.PI + 360) % 360;
  }
  const Heading = {
    compass: null, compassT: 0, gps: null, gpsT: 0,
    async enable() {
      try {
        if (typeof DeviceOrientationEvent !== "undefined" &&
            typeof DeviceOrientationEvent.requestPermission === "function") {
          const r = await DeviceOrientationEvent.requestPermission(); // iPhone: нужно разрешение
          if (r !== "granted") return false;
        }
      } catch (_) { return false; }
      window.addEventListener("deviceorientationabsolute", Heading.onEvent, true);
      window.addEventListener("deviceorientation", Heading.onEvent, true);
      return true;
    },
    onEvent(e) {
      let h = null;
      if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if (e.absolute && e.alpha !== null && e.beta !== null && e.gamma !== null) h = tiltCompensated(e.alpha, e.beta, e.gamma);
      if (h === null || isNaN(h)) return;
      const now = Date.now();
      if (Heading.compass === null || now - Heading.compassT > 2500) Heading.compass = h;
      else Heading.compass = (Heading.compass + 0.25 * (((h - Heading.compass + 540) % 360) - 180) + 360) % 360;
      Heading.compassT = now;
    },
    setGps(h) { Heading.gps = h; Heading.gpsT = Date.now(); },
    get() {
      const now = Date.now();
      if (Heading.gps !== null && now - Heading.gpsT < 4000) return Heading.gps;       // идёт — курс по GPS надёжнее
      if (Heading.compass !== null && now - Heading.compassT < 2500) return Heading.compass;
      return null;
    }
  };
  let headingAsked = false;
  function ensureHeading() { if (headingAsked) return; headingAsked = true; Heading.enable(); }
  const angDiff = (a, b) => ((b - a + 540) % 360) - 180;

  /* ---------- Распознавание речи ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen() {
    return new Promise((resolve, reject) => {
      if (!SR) return reject(new Error("no_sr"));
      const r = new SR();
      r.lang = "ru-RU"; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
      let got = false;
      r.onresult = (e) => { got = true; resolve(e.results[0][0].transcript.trim()); };
      r.onerror = (e) => reject(new Error(e.error || "sr_error"));
      r.onend = () => { if (!got) reject(new Error("no_speech")); };
      $("talk").classList.add("listening");
      beep(880);
      r.start();
    }).finally(() => $("talk").classList.remove("listening"));
  }

  async function listenWithRetry() {
    for (let i = 0; i < 2; i++) {
      try { return await listen(); }
      catch (e) {
        if (e.message !== "no_speech" && e.message !== "aborted") throw e;
        await say(i === 0 ? "Я вас не расслышал. Повторите, пожалуйста." : "Всё ещё не слышу. Попробуйте позже или введите адрес в поле ниже.", { remember: false });
      }
    }
    throw new Error("gave_up");
  }

  /* ---------- Форматирование ---------- */
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function fmtDist(m) {
    if (m < 1000) {
      const r = m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
      return `${r} ${plural(r, "метр", "метра", "метров")}`;
    }
    const km = Math.round(m / 100) / 10;
    if (Number.isInteger(km)) return `${km} ${plural(km, "километр", "километра", "километров")}`;
    return `${String(km).replace(".", ",")} километра`;
  }
  function fmtTime(sec) {
    const min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return `${min} ${plural(min, "минуту", "минуты", "минут")}`;
    const h = Math.floor(min / 60), mm = min % 60;
    return `${h} ${plural(h, "час", "часа", "часов")}` +
      (mm ? ` ${mm} ${plural(mm, "минуту", "минуты", "минут")}` : "");
  }
  const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

  /* ---------- Геометрия ---------- */
  const rad = (d) => (d * Math.PI) / 180;
  function hav(a, b) {
    const R = 6371000;
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  /* ---------- Карта ---------- */
  // attributionControl:false + prefix:false — убирает «флаг + Leaflet» в углу карты;
  // подпись OpenStreetMap оставляем: этого требует лицензия данных
  const map = L.map("map", { attributionControl: false }).setView([55.7558, 37.6173], 11);
  L.control.attribution({ prefix: false }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap"
  }).addTo(map);
  let routeLine = null, destMarker = null, userMarker = null;

  const destIcon = L.divIcon({ className: "pin-dest", iconSize: [30, 30], iconAnchor: [15, 15] });
  const meIcon = L.divIcon({ className: "pin-me", iconSize: [24, 24], iconAnchor: [12, 12] });

  function drawRoute(shape, dest) {
    if (routeLine) map.removeLayer(routeLine);
    if (destMarker) map.removeLayer(destMarker);
    const casing = L.polyline(shape, { color: "#2C466E", weight: 12, lineCap: "round", lineJoin: "round" });
    const line = L.polyline(shape, { color: "#ED7568", weight: 6, lineCap: "round", lineJoin: "round" });
    routeLine = L.featureGroup([casing, line]).addTo(map);
    destMarker = L.marker([dest.lat, dest.lon], { icon: destIcon, keyboard: false }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
  function updateUser(lat, lon) {
    if (!userMarker) {
      userMarker = L.marker([lat, lon], { icon: meIcon, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    } else userMarker.setLatLng([lat, lon]);
  }
  // карта должна пересчитать размер при повороте телефона и смене раскладки
  window.addEventListener("resize", () => map.invalidateSize());
  window.addEventListener("orientationchange", () => setTimeout(() => map.invalidateSize(), 300));

  /* ---------- API ---------- */
  async function api(path, opts) {
    const r = await fetch("/api" + path, opts);
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      if (!data.error && (r.status === 502 || r.status === 503 || r.status === 504)) {
        throw new Error("router_unavailable");
      }
      throw new Error(data.error || "http_" + r.status);
    }
    return data;
  }
  const geocode = (q) => api("/geocode?q=" + encodeURIComponent(q)).then((d) => d.results);
  const fetchRoute = (from, to) => api("/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to })
  });

  function getPosition() {
    if (FROM) {
      const [lat, lon] = FROM.split(",").map(Number);
      return Promise.resolve({ lat, lon });
    }
    // ждём точный сигнал: до 15 секунд, потом берём лучшее, если оно не хуже 300 м
    const GOOD_ACC_M = 100, MAX_ACC_M = 300;
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("no_geo"));
      let best = null, warned = false, finished = false, timer = null, id = null;
      const done = (fn, v) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (id !== null) navigator.geolocation.clearWatch(id);
        fn(v);
      };
      id = navigator.geolocation.watchPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
          if (!best || c.acc < best.acc) best = c;
          if (c.acc <= GOOD_ACC_M) return done(resolve, c);
          if (!warned) {
            warned = true;
            say(`Геопозиция пока неточная, около ${fmtDist(Math.round(c.acc))}. Подождите несколько секунд.`);
          }
        },
        (e) => done(reject, new Error(e.code === 1 ? "geo_denied" : "geo_failed")),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
      timer = setTimeout(() => {
        if (best && best.acc <= MAX_ACC_M) done(resolve, best);
        else done(reject, new Error("geo_inaccurate"));
      }, 15000);
    });
  }

  /* ---------- Навигация ---------- */
  let nav = null, watchId = null, simTimer = null, wakeLock = null, lastPos = null;
  const isDest = (m) => m && (m.type === 4 || m.type === 5 || m.type === 6);

  function projectOnRoute(lat, lon, lo = -Infinity, hi = Infinity) {
    const s = nav.shape, cum = nav.cum, k = Math.cos(rad(lat));
    let best = { dist: Infinity, along: 0 };
    for (let i = 0; i < s.length - 1; i++) {
      if (cum[i + 1] < lo || cum[i] > hi) continue;
      const ax = (s[i][1] - lon) * 111320 * k, ay = (s[i][0] - lat) * 110540;
      const bx = (s[i + 1][1] - lon) * 111320 * k, by = (s[i + 1][0] - lat) * 110540;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.dist) best = { dist: d, along: cum[i] + t * (cum[i + 1] - cum[i]) };
    }
    return best;
  }
  function pointAt(dist) {
    const { shape, cum } = nav;
    if (dist <= 0) return shape[0];
    for (let i = 0; i < shape.length - 1; i++) {
      if (dist <= cum[i + 1]) {
        const t = (dist - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
        return [shape[i][0] + t * (shape[i + 1][0] - shape[i][0]), shape[i][1] + t * (shape[i + 1][1] - shape[i][1])];
      }
    }
    return shape[shape.length - 1];
  }

  /* --- склейка коротких шагов: «Поверните направо и сразу перейдите дорогу» --- */
  const SHORT_STEP_M = 25;
  const clean = (s) => s.replace(/\.$/, "");
  function chainFrom(i) {
    const parts = [clean(nav.man[i].text)];
    let j = i;
    while (parts.length < 3 && nav.man[j].length_m < SHORT_STEP_M &&
           nav.man[j + 1] && !isDest(nav.man[j + 1])) {
      j++;
      parts.push(lowerFirst(clean(nav.man[j].text)));
    }
    return { parts, last: j };
  }
  const joinParts = (p, sep = " и сразу ") =>
    p.length === 1 ? p[0] : p[0] + sep + p[1] + (p[2] ? ", затем " + p[2] : "");

  function approachText(t, th) {
    if (isDest(t)) return `Через ${fmtDist(th)} цель маршрута.`;
    const { parts } = chainFrom(nav.man.indexOf(t));
    return `Через ${fmtDist(th)} ${lowerFirst(joinParts(parts))}.`;
  }

  /* --- первый шаг по компасу: «Повернитесь налево и идите» --- */
  function turnPhrase(rel) {                  // rel: на сколько градусов по часовой повернуть до нужного курса
    const a = rel > 180 ? 360 - rel : rel;
    const side = rel > 180 ? "налево" : "направо";
    if (a <= 20) return "Идите прямо";
    if (a <= 60) return `Повернитесь немного ${side} и идите`;
    if (a <= 135) return `Повернитесь ${side} и идите`;
    if (a <= 165) return `Повернитесь ${side}, почти назад, и идите`;
    return "Развернитесь и идите";
  }
  function stopOrient() {
    if (nav && nav.orientTimer) { clearInterval(nav.orientTimer); nav.orientTimer = null; }
  }
  function watchOrientation(target) {
    stopOrient();
    const t0 = Date.now();
    let since = null;
    nav.orientTimer = setInterval(() => {
      if (Date.now() - t0 > 25000) return stopOrient();
      const h = Heading.get();
      if (h === null) return;
      if (Math.abs(angDiff(h, target)) <= 25) {
        if (since === null) since = Date.now();
        else if (Date.now() - since >= 1000) { stopOrient(); say("Верно. Идите вперёд."); vibrate(120); }
      } else since = null;
    }, 400);
  }

  function enterStep(i) {
    const m = nav.man[i];
    if (isDest(m) || !nav.man[i + 1]) { nav.cur = i; nav.said = new Set(); return arrive(); }
    const { parts, last } = chainFrom(i);
    let sep = " и сразу ", orient = null;
    if (i === 0 && typeof m.heading === "number") {
      const h = Heading.get();
      if (h !== null) {                       // компас есть — говорим «налево/направо», а не «на север»
        const rel = (m.heading - h + 360) % 360;
        parts[0] = turnPhrase(rel);
        sep = ", затем ";
        if (rel > 20 && rel < 340) orient = m.heading;
      }
    }
    nav.cur = last;
    nav.said = new Set();
    const t = nav.man[last + 1];
    if (!t) return arrive();
    const d = Math.max(0, nav.cum[t.idx] - nav.along);
    [100, 30].forEach((th) => { if (d <= th + 15) nav.said.add(th); });
    say(`${joinParts(parts, sep)}. Далее ${fmtDist(d)}${isDest(t) ? " до цели" : ""}.`);
    vibrate(150);
    if (orient !== null) watchOrientation(orient);
  }

  function arrive() {
    nav.done = true;
    stopTracking();
    vibrate([300, 150, 300]);
    say(`Вы пришли. ${nav.dest.title}.`);
  }

  function onPosition(lat, lon, acc, gpsHeading, speed) {
    if (!nav || nav.done) return;
    if (acc && acc > 60) return; // слишком неточный сигнал
    lastPos = { lat, lon, acc, t: Date.now() };
    if (typeof gpsHeading === "number" && !isNaN(gpsHeading) && speed > 1) Heading.setGps(gpsHeading);
    updateUser(lat, lon);
    map.panTo([lat, lon], { animate: true });

    let p = projectOnRoute(lat, lon, nav.along - 40, nav.along + 400);
    if (p.dist > OFF_ROUTE_M) {
      const g = projectOnRoute(lat, lon);
      if (g.dist < p.dist) p = g;
    }
    if (p.dist > OFF_ROUTE_M) {
      if (++nav.off >= 3) reroute(lat, lon);
      return;
    }
    nav.off = 0;
    nav.along = p.along;

    const t = nav.man[nav.cur + 1];
    if (!t) return;
    const d = nav.cum[t.idx] - nav.along;
    if (d <= (isDest(t) ? 15 : 12)) return enterStep(nav.cur + 1);

    for (const th of [30, 100]) {
      if (d <= th && !nav.said.has(th)) {
        [30, 100].filter((x) => x >= th).forEach((x) => nav.said.add(x));
        say(approachText(t, th));
        if (th === 30) vibrate([100, 80, 100]);
        break;
      }
    }
  }

  async function reroute(lat, lon) {
    const now = Date.now();
    if (now - nav.lastReroute < 20000) return;
    nav.lastReroute = now; nav.off = 0;
    const dest = nav.dest;
    await say("Вы отклонились от маршрута. Перестраиваю.");
    try {
      const route = await fetchRoute({ lat, lon }, dest);
      startNavigation(route, dest, { lat, lon });
    } catch (e) { say(errorText(e)); }
  }

  function startTracking() {
    stopTracking();
    if (SIM) {
      let dist = 0;
      simTimer = setInterval(() => {
        dist += 14; // ~14 м/с — быстрая имитация для проверки
        if (dist > nav.cum[nav.cum.length - 1]) dist = nav.cum[nav.cum.length - 1];
        const p = pointAt(dist);
        onPosition(p[0], p[1], 5);
      }, 1000);
    } else if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (p) => onPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy, p.coords.heading, p.coords.speed),
        () => say("Потерян сигнал GPS."),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
      );
    }
  }
  function stopTracking() {
    stopOrient();
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  async function requestWake() {
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
  }

  function startNavigation(route, dest, startPos) {
    stopTracking();
    const shape = route.shape, cum = [0];
    for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + hav(shape[i - 1], shape[i]));
    nav = { route, dest, shape, cum, man: route.maneuvers, cur: 0, along: 0, said: new Set(), off: 0, lastReroute: nav ? nav.lastReroute : 0, done: false };
    drawRoute(shape, dest);
    if (startPos) updateUser(startPos.lat, startPos.lon);
    enterStep(0);
    startTracking();
    requestWake();
  }

  function stopNavigation(speak = true) {
    stopTracking();
    nav = null;
    if (speak) say("Маршрут остановлен.");
  }

  /* ---------- Диалог ---------- */
  const YES = /(^|\s)(да|верно|правильно|давай|угу|ага|строй|поехали|конечно)(\s|$)/i;
  const NO = /(^|\s)(нет|неверно|неправильно|не то|другое|дальше)(\s|$)/i;

  function cleanQuery(t) {
    return t
      .replace(/^(мне\s+)?(нужно|надо|хочу)?\s*(попасть|пройти|дойти|идти)?\s*/i, "")
      .replace(/^(до|в|на|к)\s+/i, "")
      .trim();
  }

  function errorText(e) {
    const m = e && e.message;
    const map = {
      no_sr: "Этот браузер не умеет распознавать речь. Введите адрес в поле ниже или откройте сайт в Хроме.",
      "not-allowed": "Нет доступа к микрофону. Разрешите его в настройках браузера.",
      "service-not-allowed": "Нет доступа к микрофону. Разрешите его в настройках браузера.",
      "audio-capture": "Микрофон не найден.",
      network: "Нет связи с сервисом распознавания речи.",
      gave_up: "Не получилось распознать речь.",
      geo_denied: "Нет доступа к геопозиции. Разрешите её в настройках браузера.",
      geo_failed: "Не удалось определить, где вы находитесь. Выйдите на открытое место и повторите.",
      geo_inaccurate: "Не могу точно определить, где вы находитесь: погрешность больше трёхсот метров. Выйдите на открытое место, включите геолокацию на телефоне и попробуйте ещё раз.",
      no_geo: "Этот браузер не умеет определять геопозицию.",
      outside_moscow: "Сейчас я умею строить маршруты только по Москве. Похоже, вы или цель за её пределами.",
      too_far: "Это слишком далеко для пешего маршрута. Я строю маршруты до пятнадцати километров. Назовите место поближе.",
      no_route: "Не получилось найти пешеходный маршрут до этого места.",
      router_unavailable: "Сервис маршрутов сейчас недоступен. Попробуйте чуть позже.",
      geocoder_unavailable: "Поиск мест сейчас недоступен. Попробуйте чуть позже.",
      rate_limited: "Слишком много запросов. Подождите минуту."
    };
    return map[m] || "Что-то пошло не так. Попробуйте ещё раз.";
  }

  let busy = false;
  async function runExclusive(fn) {
    ensureHeading();
    if (busy) return;
    busy = true;
    try { await fn(); }
    catch (e) { await say(errorText(e)); }
    finally { busy = false; }
  }

  /* ---------- Сохранённые места (хранятся в браузере, на этом устройстве) ---------- */
  const PLACES_KEY = "navi.places.v1";
  const MAX_PLACES = 50;
  const MSK = { latMin: 55.14, latMax: 56.0, lonMin: 36.8, lonMax: 38.0 };
  const inMoscow = (lat, lon) => lat >= MSK.latMin && lat <= MSK.latMax && lon >= MSK.lonMin && lon <= MSK.lonMax;
  const norm = (s) => String(s).toLowerCase().replace(/ё/g, "е").trim();
  const tokens = (s) => norm(s).replace(/[^a-zа-я0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const STOP = new Set(["проложи", "проложить", "маршрут", "путь", "дорогу", "до", "в", "во", "на", "к", "ко",
    "хочу", "попасть", "мне", "нужно", "надо", "идти", "пойти", "пройти", "поехали", "пошли", "веди", "отведи",
    "меня", "пожалуйста", "иди", "идем", "идём", "пойдем", "пойдём", "поедем", "едем", "давай", "проведи",
    "доведи", "отвези", "двигай", "сейчас", "теперь", "снова"]);

  function loadPlaces() {
    try {
      const a = JSON.parse(localStorage.getItem(PLACES_KEY) || "[]");
      return Array.isArray(a)
        ? a.filter((p) => p && typeof p.name === "string" && isFinite(p.lat) && isFinite(p.lon))
        : [];
    } catch (_) { return []; }
  }
  let places = loadPlaces();
  function persistPlaces() {
    try { localStorage.setItem(PLACES_KEY, JSON.stringify(places)); return true; }
    catch (_) { return false; }
  }

  // Слова считаем одинаковыми, если у них общее начало и разные только окончания: дом/домой, работа/работу, мама/маме
  function sameWord(a, b) {
    if (a === b) return true;
    const n = Math.min(a.length, b.length);
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    return k >= 3 && a.length - k <= 3 && b.length - k <= 3;
  }
  function findSaved(text) {
    const q = tokens(text).filter((t) => !STOP.has(t));
    if (!q.length) return null;
    let best = null;
    for (const p of places) {
      const n = tokens(p.name);
      if (!n.length) continue;
      const nAll = n.every((nt) => q.some((qt) => sameWord(nt, qt)));
      const qAll = q.every((qt) => n.some((nt) => sameWord(nt, qt)));   // «дом культуры» не должно стать «Дом»
      if (nAll && qAll && (!best || n.length > best.n)) best = { p, n: n.length };
    }
    return best ? best.p : null;
  }

  function savePlace(name, lat, lon, title) {
    const key = norm(name);
    const i = places.findIndex((p) => norm(p.name) === key);
    if (i < 0 && places.length >= MAX_PLACES) return "limit";
    const rec = {
      id: i >= 0 ? places[i].id : Date.now().toString(36),
      name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), title: title || "", created: Date.now()
    };
    if (i >= 0) places[i] = rec; else places.push(rec);
    if (!persistPlaces()) return "storage";
    renderPlaces();
    return i >= 0 ? "updated" : "created";
  }
  function removePlace(id) {
    places = places.filter((p) => p.id !== id);
    persistPlaces();
    renderPlaces();
  }

  function cleanName(s) {
    const t = String(s || "").replace(/[«»"“”„]/g, "")
      .replace(/^(?:как|назови|назвать|называется|под названием)\s+/i, "")
      .replace(/[.,!?]+$/g, "").trim().slice(0, 40);
    return t ? cap(t) : "";
  }

  // «запомни это место как дом», «сохрани Красную площадь как экскурсия», «запомни дом»
  const SAVE_RE = /^(?:запомнить|запомни|сохранить|сохрани|запиши|добавь)\s*(.*)$/i;
  const HERE_RE = /^(?:это место|эту точку|это|место|точку|здесь|тут|мо[её] местоположение|мою позицию|текущее место|текущую позицию)$/i;
  const HERE_ANSWER = /(^|\s)(здесь|тут|мо[её] местоположение|где я)(\s|$)/i;
  function parseSave(text) {
    const m = text.trim().match(SAVE_RE);
    if (!m) return null;
    const rest = m[1].trim();
    const kak = rest.match(/^(.*?)(?:^|\s)(?:как|под именем|под названием)\s+(.+)$/i);
    if (kak) {
      const where = kak[1].trim();
      return { name: cleanName(kak[2]) || null, addr: !where || HERE_RE.test(where) ? "" : where };
    }
    if (!rest || HERE_RE.test(rest)) return { name: null, addr: "" };
    return { name: cleanName(rest) || null, addr: "" };
  }

  const placesCountEl = () => $("placesCount");
  function renderPlaces() {
    const ul = $("placeList");
    ul.textContent = "";
    placesCountEl().textContent = places.length ? ` (${places.length})` : "";
    if (!places.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Пока нет сохранённых мест. Скажите: «запомни это место как дом».";
      ul.appendChild(li);
      return;
    }
    for (const p of places) {
      const li = document.createElement("li");
      const go = document.createElement("button");
      go.type = "button";
      go.className = "place-go";
      go.textContent = p.name;
      go.setAttribute("aria-label", `Маршрут до места ${p.name}`);
      go.addEventListener("click", () => runExclusive(async () => {
        stopNavigation(false);
        await say(`Маршрут до места «${p.name}».`);
        await routeToChosen({ title: p.name, lat: p.lat, lon: p.lon });
      }));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "place-del";
      del.textContent = "Удалить";
      del.setAttribute("aria-label", `Удалить место ${p.name}`);
      let armed = null;
      del.addEventListener("click", () => {
        if (armed) { clearTimeout(armed); removePlace(p.id); say(`Место «${p.name}» удалено.`); return; }
        del.textContent = "Точно?";
        del.classList.add("confirm");
        armed = setTimeout(() => { armed = null; del.textContent = "Удалить"; del.classList.remove("confirm"); }, 3500);
      });
      li.append(go, del);
      ul.appendChild(li);
    }
  }

  /* ---------- Выбор места голосом и маршрут ---------- */
  async function confirmCandidate(results, question) {
    for (const cand of results.slice(0, 3)) {
      if (!SR) { await say(`Нашёл: ${cand.title}.`); return cand; }   // без микрофона подтверждать нечем — берём первый
      await say(`Нашёл: ${cand.title}. ${question} Скажите да или нет.`);
      const answer = await listenWithRetry();
      if (YES.test(answer)) return cand;
      if (!NO.test(answer)) { await say("Не понял ответ. Коснитесь экрана и попробуйте заново."); return null; }
    }
    await say("Больше вариантов нет. Коснитесь экрана и назовите место точнее.");
    return null;
  }

  async function routeToChosen(chosen) {
    await say("Определяю, где вы находитесь.");
    const pos = await getPosition();
    await say("Строю маршрут.");
    const route = await fetchRoute(pos, chosen);
    await say(`Маршрут готов. Пешком примерно ${fmtTime(route.time_s)}, ${fmtDist(route.length_m)}. Будьте внимательны на переходах.`);
    startNavigation(route, chosen, pos);
  }

  async function chooseAndRoute(text) {
    if (nav) stopNavigation(false);
    const saved = findSaved(text);
    if (saved) {
      await say(`Маршрут до места «${saved.name}».`);
      return routeToChosen({ title: saved.name, lat: saved.lat, lon: saved.lon });
    }
    const q = cleanQuery(text);
    if (/^(домой|дом|на работу|работу|работа)$/i.test(q)) {
      const nm = /дом/i.test(q) ? "дом" : "работа";
      await say(`У вас пока нет сохранённого места «${nm}». Когда окажетесь там, скажите: запомни это место как ${nm}.`);
      return;
    }
    await say(`Ищу: ${q}.`);
    const results = await geocode(q);
    if (!results.length) {
      await say("Не нашёл такое место в Москве. Коснитесь экрана и назовите его ещё раз.");
      return;
    }
    const chosen = await confirmCandidate(results, "Построить маршрут?");
    if (chosen) await routeToChosen(chosen);
  }

  /* ---------- Сохранение места ---------- */
  async function saveCurrentOrAddress(name, addr, typed = false) {
    let pos, title = "";
    if (!addr) {
      await say("Определяю, где вы находитесь.");
      pos = lastPos && Date.now() - lastPos.t < 10000 ? lastPos : await getPosition();
    } else {
      await say(`Ищу: ${addr}.`);
      const results = await geocode(cleanQuery(addr));
      if (!results.length) { await say("Не нашёл такое место в Москве."); return; }
      const cand = typed ? results[0] : await confirmCandidate(results, "Сохранить это место?");
      if (!cand) return;
      pos = cand; title = cand.title;
    }
    if (!inMoscow(pos.lat, pos.lon)) { await say("Это место за пределами Москвы, сохранить его не могу."); return; }
    const r = savePlace(name, pos.lat, pos.lon, title);
    const acc = pos.acc && pos.acc > 50 ? ` Точность определения около ${fmtDist(Math.round(pos.acc))}, при необходимости сохраните ещё раз.` : "";
    const msg = {
      created: `Готово. Место «${name}» сохранено${title ? ": " + title : ""}. Скажите «${name.toLowerCase()}», чтобы построить маршрут.${acc}`,
      updated: `Обновил место «${name}».${acc}`,
      limit: "Достигнут предел в пятьдесят мест. Удалите ненужные: скажите «удали место» и название.",
      storage: "Не удалось сохранить: браузер не разрешает хранить данные на этом устройстве."
    }[r];
    await say(msg);
  }

  async function savePlaceDialog({ name, addr }) {
    if (!name) {
      await say("Как назвать место?");
      name = cleanName(await listenWithRetry());
      if (!name) { await say("Не расслышал название. Попробуйте ещё раз."); return; }
    }
    if (addr === null) {
      await say(`Место «${name}». Где оно? Скажите «здесь», чтобы сохранить ваше местоположение, или назовите адрес.`);
      const a = await listenWithRetry();
      addr = HERE_ANSWER.test(a) ? "" : a;
    }
    await saveCurrentOrAddress(name, addr);
  }

  async function sayPlaces() {
    if (!places.length) {
      await say("У вас пока нет сохранённых мест. Скажите: запомни это место как дом.");
      return;
    }
    await say(`Сохранённые места: ${places.map((p) => p.name).join(", ")}. Назовите любое из них, чтобы построить маршрут.`);
  }

  async function deletePlaceByVoice(namePart) {
    const p = findSaved(namePart);
    if (!p) { await say(`Не нашёл сохранённое место «${namePart}».`); return; }
    await say(`Удалить место «${p.name}»? Скажите да или нет.`);
    const a = await listenWithRetry();
    if (YES.test(a)) { removePlace(p.id); await say(`Место «${p.name}» удалено.`); }
    else await say("Хорошо, оставляю.");
  }

  const REPEAT_RE = /^\s*(повтор\S*|ещ[её] раз)/i;
  const LIST_RE = /(мои места|сохран[её]нные места|какие места|список мест|мои точки)/i;
  const DEL_RE = /^(?:удали|удалить|забудь|убери)\s+(?:место\s+|точку\s+)?(.+)$/i;

  // единая точка входа для голосовых и текстовых команд
  async function handleSpoken(text) {
    if (REPEAT_RE.test(text)) { if (lastSpoken) await say(lastSpoken); return; }
    const sv = parseSave(text);
    if (sv) return savePlaceDialog({ name: sv.name, addr: sv.addr });
    if (WHERE.test(text)) return whereAmI();
    if (LIST_RE.test(text)) return sayPlaces();
    const del = text.trim().match(DEL_RE);
    if (del) return deletePlaceByVoice(del[1]);
    return chooseAndRoute(text);
  }

  /* ---------- «Где я?» ---------- */
  const WHERE = /(где я|где мы|где нахожусь|местоположение|что рядом)/i;
  const CARD = ["на севере", "на северо-востоке", "на востоке", "на юго-востоке",
                "на юге", "на юго-западе", "на западе", "на северо-западе"];
  function dirText(bearing) {
    const h = Heading.get();
    if (h === null) return CARD[Math.round(bearing / 45) % 8];
    const rel = (bearing - h + 360) % 360;
    if (rel <= 30 || rel >= 330) return "впереди";
    if (rel < 75) return "впереди справа";
    if (rel <= 105) return "справа";
    if (rel < 150) return "сзади справа";
    if (rel <= 210) return "сзади";
    if (rel < 255) return "сзади слева";
    if (rel <= 285) return "слева";
    return "впереди слева";
  }
  const joinNames = (a) => a.length < 2 ? (a[0] || "") : a.slice(0, -1).join(", ") + " и " + a[a.length - 1];

  async function whereAmI() {
    let pos = lastPos && Date.now() - lastPos.t < 10000 ? lastPos : null;
    if (!pos) { await say("Определяю, где вы находитесь."); pos = await getPosition(); }
    const d = await api(`/whereami?lat=${pos.lat}&lon=${pos.lon}`);
    const out = [];
    if (d.road) out.push(`Ближайший адрес: ${d.road}${d.house ? ", дом " + d.house : ""}.`);
    const x = d.intersection;
    if (x) {
      out.push(x.dist_m < 15
        ? `Вы на перекрёстке: ${joinNames(x.names)}.`
        : `Ближайший перекрёсток: ${joinNames(x.names)}, ${fmtDist(x.dist_m)} ${dirText(x.bearing)}.`);
    }
    if (pos.acc && pos.acc > 50) out.push(`Точность определения около ${fmtDist(Math.round(pos.acc))}.`);
    if (!out.length) out.push("Не удалось определить адрес рядом с вами.");
    await say(out.join(" "));
  }

  // Приветствие при заходе. Многие браузеры (Chrome, Safari) запрещают озвучку без касания:
  // тогда introHeard останется false, и инструкция прозвучит при первом касании экрана.
  const INTRO = "Добро пожаловать в голосовой навигатор. Коснитесь экрана в любом месте и назовите, куда хотите дойти. " +
                "Чтобы узнать, где вы находитесь, коснитесь экрана и скажите: где я.";
  const INTRO_TAP = "Добро пожаловать. Чтобы говорить, касайтесь экрана в любом месте. Назовите, куда хотите дойти, или скажите: где я.";
  let introHeard = false;
  function speakIntro() {
    if (!synth || introHeard || document.hidden) return;
    const u = new SpeechSynthesisUtterance(INTRO);
    u.lang = "ru-RU";
    if (ruVoice) u.voice = ruVoice;
    u.rate = 0.95;
    u.onstart = () => { introHeard = true; };
    synth.speak(u);
  }

  async function onTalk() {
    ensureHeading();            // на iPhone разрешение на компас можно запросить только по нажатию
    if (busy) return;
    busy = true;
    const first = !introHeard;   // приветствие ещё не звучало (озвучку при загрузке заблокировал браузер)
    introHeard = true;
    try {
      if (nav && !nav.done) {
        await say("Слушаю. Скажите: повтори, где я, стоп или новый адрес.", { remember: false });
        const cmd = await listenWithRetry();
        if (/(стоп|останов|хватит|отмена)/i.test(cmd)) { stopNavigation(); return; }
        await handleSpoken(cmd);   // «повтори» и «где я» разбираются там
      } else {
        await say(first ? INTRO_TAP : places.length
          ? "Назовите, куда хотите попасть: адрес или сохранённое место."
          : "Назовите, куда хотите попасть, или спросите: где я.", { remember: false });
        await handleSpoken(await listenWithRetry());
      }
    } catch (e) {
      await say(errorText(e));
    } finally {
      busy = false;
    }
  }

  // касание в любом месте экрана = «Говорить»
  // исключения: ручные формы (для зрячего помощника), кнопки зума, ссылки
  document.addEventListener("click", (e) => {
    if (e.target.closest(".places, .alt, .leaflet-control, a")) return;
    onTalk();
  });
  $("textForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("textInput").value.trim();
    if (v) runExclusive(() => handleSpoken(v));
  });
  $("placeAdd").addEventListener("click", () => runExclusive(() => savePlaceDialog({ name: null, addr: null })));
  $("placeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = cleanName($("placeName").value);
    const addr = $("placeAddr").value.trim();
    if (!name) { say("Введите название места."); return; }
    runExclusive(async () => {
      await saveCurrentOrAddress(name, addr, true);
      $("placeName").value = ""; $("placeAddr").value = "";
    });
  });
  // пробел вне полей ввода — то же, что касание экрана
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) { e.preventDefault(); onTalk(); }
  });
  renderPlaces();
  setTimeout(speakIntro, 500);   // даём загрузиться списку голосов
})();
