"""
Голосовой навигатор для слабовидящих — backend.
Эндпоинты:
  GET  /api/geocode?q=...   -> поиск места в Москве (Nominatim / OSM)
  POST /api/route           -> пешеходный маршрут (Valhalla / OSM) с русскими подсказками
  GET  /api/health
Адреса внешних сервисов задаются переменными окружения, чтобы потом
заменить на свои (например, свой Valhalla в Docker на этом же VPS).
"""
import os
import threading
import time

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

NOMINATIM_URL = os.getenv("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")
VALHALLA_URL = os.getenv("VALHALLA_URL", "https://valhalla1.openstreetmap.de/route")
USER_AGENT = os.getenv("USER_AGENT", "luxcode-navi/1.0 (contact: admin@luxcode.ru)")

# Москва с Новой Москвой и Зеленоградом: lon_left, lat_top, lon_right, lat_bottom
VIEWBOX = (36.80, 56.00, 38.00, 55.14)
LON_MIN, LAT_MAX, LON_MAX, LAT_MIN = VIEWBOX

# ---------- простой кэш + лимиты ----------
_cache = {}
_cache_lock = threading.Lock()
CACHE_TTL = 6 * 3600

_hits = {}
_hits_lock = threading.Lock()
RATE_LIMIT = 40  # запросов в минуту с одного IP

_nom_lock = threading.Lock()
_nom_last = 0.0  # у публичного Nominatim лимит 1 запрос/сек


def cache_get(key):
    with _cache_lock:
        item = _cache.get(key)
        if item and item[0] > time.time():
            return item[1]
        _cache.pop(key, None)
    return None


def cache_set(key, value):
    with _cache_lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[key] = (time.time() + CACHE_TTL, value)


def too_many_requests():
    ip = request.headers.get("X-Real-IP") or request.remote_addr or "?"
    now = time.time()
    with _hits_lock:
        arr = [t for t in _hits.get(ip, []) if now - t < 60]
        arr.append(now)
        _hits[ip] = arr
        if len(_hits) > 5000:
            _hits.clear()
    return len(arr) > RATE_LIMIT


def in_moscow(lat, lon):
    return LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX


MAX_WALK_KM = float(os.getenv("MAX_WALK_KM", "15"))


def straight_km(lat1, lon1, lat2, lon2):
    from math import asin, cos, radians, sin, sqrt
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    x = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(x))


@app.before_request
def limiter():
    if request.path.startswith("/api/") and request.path != "/api/health":
        if too_many_requests():
            return jsonify(error="rate_limited"), 429


# ---------- геокодинг ----------
def short_title(item):
    a = item.get("address", {})
    road = a.get("road") or a.get("pedestrian") or a.get("footway")
    house = a.get("house_number")
    name = item.get("name") or ""
    if road and house:
        base = f"{road}, {house}"
        return f"{name}, {base}" if name and name != road else base
    if name:
        extra = a.get("suburb") or a.get("city_district") or road
        return f"{name}, {extra}" if extra and extra != name else name
    return (item.get("display_name") or "").split(",")[0]


@app.get("/api/geocode")
def geocode():
    global _nom_last
    q = (request.args.get("q") or "").strip()
    if len(q) < 2 or len(q) > 200:
        return jsonify(error="bad_query"), 400

    key = "g:" + q.lower()
    cached = cache_get(key)
    if cached is not None:
        return jsonify(results=cached)

    query = q if "москв" in q.lower() else f"{q}, Москва"
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": 5,
        "addressdetails": 1,
        "accept-language": "ru",
        "countrycodes": "ru",
        "viewbox": "{},{},{},{}".format(*VIEWBOX),
        "bounded": 1,
    }
    with _nom_lock:
        wait = 1.1 - (time.time() - _nom_last)
        if wait > 0:
            time.sleep(wait)
        try:
            r = requests.get(NOMINATIM_URL, params=params,
                             headers={"User-Agent": USER_AGENT}, timeout=10)
            r.raise_for_status()
            data = r.json()
        except Exception:
            return jsonify(error="geocoder_unavailable"), 502
        finally:
            _nom_last = time.time()

    results, seen = [], set()
    for it in data:
        title = short_title(it)
        if title in seen:
            continue
        seen.add(title)
        results.append({"title": title, "lat": float(it["lat"]), "lon": float(it["lon"])})
    cache_set(key, results)
    return jsonify(results=results)


# ---------- маршрут ----------
def decode_polyline6(s):
    coords, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if k == 0:
                lat += delta
            else:
                lon += delta
        coords.append([lat / 1e6, lon / 1e6])
    return coords


@app.post("/api/route")
def route():
    d = request.get_json(silent=True) or {}
    try:
        a_lat, a_lon = float(d["from"]["lat"]), float(d["from"]["lon"])
        b_lat, b_lon = float(d["to"]["lat"]), float(d["to"]["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify(error="bad_request"), 400

    if not (in_moscow(a_lat, a_lon) and in_moscow(b_lat, b_lon)):
        return jsonify(error="outside_moscow"), 422

    if straight_km(a_lat, a_lon, b_lat, b_lon) > MAX_WALK_KM:
        return jsonify(error="too_far"), 422

    payload = {
        "locations": [
            {"lat": a_lat, "lon": a_lon, "type": "break"},
            {"lat": b_lat, "lon": b_lon, "type": "break"},
        ],
        "costing": "pedestrian",
        "directions_options": {"language": "ru-RU", "units": "kilometers"},
    }
    for attempt in range(2):
        r = None
        try:
            r = requests.post(VALHALLA_URL, json=payload,
                              headers={"User-Agent": USER_AGENT}, timeout=(4, 9))
            if r.status_code == 400:
                app.logger.warning("valhalla 400 from=%s,%s to=%s,%s: %s",
                                   a_lat, a_lon, b_lat, b_lon, r.text[:300])
                return jsonify(error="no_route"), 404
            r.raise_for_status()
            trip = r.json()["trip"]
            leg = trip["legs"][0]
            break
        except Exception as e:
            app.logger.error("valhalla fail attempt=%s from=%s,%s to=%s,%s err=%r status=%s body=%s",
                             attempt + 1, a_lat, a_lon, b_lat, b_lon, e,
                             getattr(r, "status_code", None),
                             (r.text[:300] if r is not None else ""))
            time.sleep(0.5)
    else:
        return jsonify(error="router_unavailable"), 502

    shape = decode_polyline6(leg["shape"])
    maneuvers = [{
        "text": m.get("instruction", ""),
        "type": m.get("type"),
        "length_m": round(m.get("length", 0) * 1000),
        "time_s": round(m.get("time", 0)),
        "idx": m.get("begin_shape_index", 0),
        "heading": m.get("begin_heading"),
    } for m in leg["maneuvers"]]

    return jsonify(
        shape=shape,
        maneuvers=maneuvers,
        length_m=round(trip["summary"]["length"] * 1000),
        time_s=round(trip["summary"]["time"]),
    )


# ---------- «где я?»: ближайший адрес и перекрёсток ----------
NOMINATIM_REVERSE_URL = os.getenv("NOMINATIM_REVERSE_URL", "https://nominatim.openstreetmap.org/reverse")
OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter")


def bearing_deg(lat1, lon1, lat2, lon2):
    from math import atan2, cos, degrees, radians, sin
    p1, p2, dl = radians(lat1), radians(lat2), radians(lon2 - lon1)
    x = sin(dl) * cos(p2)
    y = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
    return (degrees(atan2(x, y)) + 360) % 360


def reverse_address(lat, lon):
    global _nom_last
    params = {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18,
              "addressdetails": 1, "accept-language": "ru"}
    with _nom_lock:
        wait = 1.1 - (time.time() - _nom_last)
        if wait > 0:
            time.sleep(wait)
        try:
            r = requests.get(NOMINATIM_REVERSE_URL, params=params,
                             headers={"User-Agent": USER_AGENT}, timeout=10)
            r.raise_for_status()
            data = r.json()
        finally:
            _nom_last = time.time()
    a = data.get("address", {})
    road = a.get("road") or a.get("pedestrian") or a.get("footway")
    return road, a.get("house_number")


def find_intersection(lat, lon):
    """Ближайшая точка, где сходятся улицы с РАЗНЫМИ названиями (Overpass / OSM)."""
    q = ('[out:json][timeout:10];'
         f'way(around:150,{lat},{lon})["highway"]["name"];out body;>;out skel qt;')
    r = requests.post(OVERPASS_URL, data={"data": q},
                      headers={"User-Agent": USER_AGENT}, timeout=(4, 12))
    r.raise_for_status()
    els = r.json().get("elements", [])
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in els if e.get("type") == "node"}
    names_at = {}
    for w in els:
        if w.get("type") != "way":
            continue
        name = w.get("tags", {}).get("name")
        if not name:
            continue
        for nid in w.get("nodes", []):
            names_at.setdefault(nid, set()).add(name)
    best = None
    for nid, names in names_at.items():
        if len(names) < 2 or nid not in nodes:
            continue
        nlat, nlon = nodes[nid]
        d = straight_km(lat, lon, nlat, nlon) * 1000
        if best is None or d < best[0]:
            best = (d, nlat, nlon, sorted(names))
    if not best:
        return None
    return {"names": best[3][:3], "dist_m": round(best[0]),
            "bearing": round(bearing_deg(lat, lon, best[1], best[2]))}


@app.get("/api/whereami")
def whereami():
    try:
        lat, lon = float(request.args["lat"]), float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify(error="bad_request"), 400
    if not in_moscow(lat, lon):
        return jsonify(error="outside_moscow"), 422

    key = f"w:{lat:.4f},{lon:.4f}"
    cached = cache_get(key)
    if cached is not None:
        return jsonify(cached)

    road = house = inter = None
    try:
        road, house = reverse_address(lat, lon)
    except Exception as e:
        app.logger.error("reverse fail: %r", e)
    try:
        inter = find_intersection(lat, lon)
    except Exception as e:
        app.logger.error("overpass fail: %r", e)
    if not road and not inter:
        return jsonify(error="geocoder_unavailable"), 502

    res = {"road": road, "house": house, "intersection": inter}
    cache_set(key, res)
    return jsonify(res)


@app.get("/api/health")
def health():
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
