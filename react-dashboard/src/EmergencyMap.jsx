import { useEffect, useRef, useState } from 'react';

/* global L */  // Leaflet via CDN

const TYPE_META = {
  fire:      { color: '#ef4444', bg: '#450a0a', emoji: '🔥', vehicle: '🚒', label: 'Fire Brigade' },
  ambulance: { color: '#f59e0b', bg: '#451a03', emoji: '🏥', vehicle: '🚑', label: 'Ambulance' },
  police:    { color: '#3b82f6', bg: '#0c1a3a', emoji: '🛡️', vehicle: '🚔', label: 'Police' },
  rescue:    { color: '#8b5cf6', bg: '#1e0a3a', emoji: '🚁', vehicle: '🚁', label: 'Rescue Team' },
};

// Bearing in degrees between two coords
function bearing(lat1, lng1, lat2, lng2) {
  const toR = d => d * Math.PI / 180;
  const dL = toR(lng2 - lng1);
  const y = Math.sin(dL) * Math.cos(toR(lat2));
  const x = Math.cos(toR(lat1)) * Math.sin(toR(lat2)) - Math.sin(toR(lat1)) * Math.cos(toR(lat2)) * Math.cos(dL);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Total polyline length in km (sum of haversine segments)
function polylineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    const R = 6371, r = d => d * Math.PI / 180;
    const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
    total += R * 2 * Math.asin(Math.sqrt(Math.sin(dLat/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dLng/2)**2));
  }
  return total;
}

// Interpolate position along route at fraction t (0→1)
function interpolateRoute(coords, t) {
  if (t <= 0) return { lat: coords[0][1], lng: coords[0][0], bearing: 0 };
  if (t >= 1) {
    const last = coords[coords.length - 1];
    return { lat: last[1], lng: last[0], bearing: 0 };
  }
  const segments = [];
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1], [lng2, lat2] = coords[i];
    const R = 6371, r = d => d * Math.PI / 180;
    const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
    const d = R * 2 * Math.asin(Math.sqrt(Math.sin(dLat/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dLng/2)**2));
    segments.push({ lat1, lng1, lat2, lng2, d });
  }
  const totalLen = segments.reduce((s, seg) => s + seg.d, 0);
  let target = t * totalLen, cum = 0;
  for (const seg of segments) {
    if (cum + seg.d >= target) {
      const frac = (target - cum) / seg.d;
      const lat = seg.lat1 + (seg.lat2 - seg.lat1) * frac;
      const lng = seg.lng1 + (seg.lng2 - seg.lng1) * frac;
      return { lat, lng, bearing: bearing(seg.lat1, seg.lng1, seg.lat2, seg.lng2) };
    }
    cum += seg.d;
  }
  const last = coords[coords.length - 1];
  return { lat: last[1], lng: last[0], bearing: 0 };
}

// Fetch real road route from OSRM (free, no key)
async function fetchRoute(fromLng, fromLat, toLng, toLat) {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('OSRM failed');
  const route = data.routes[0];
  return {
    coords: route.geometry.coordinates, // [[lng,lat], ...]
    distanceKm: route.distance / 1000,
    durationSec: route.duration,
  };
}

function makeServiceIcon(type) {
  const m = TYPE_META[type] || TYPE_META.police;
  return L.divIcon({
    className: '',
    html: `<div style="width:38px;height:38px;background:${m.color};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 10px rgba(0,0,0,0.6);border:2px solid white">${m.emoji}</div>`,
    iconSize: [38, 38], iconAnchor: [19, 19],
  });
}

function makeUserIcon(pulse = false) {
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center">
      ${pulse ? `<div style="position:absolute;width:44px;height:44px;border-radius:50%;background:rgba(239,68,68,0.3);animation:mapPulse 1.5s infinite"></div>` : ''}
      <div style="width:28px;height:28px;background:#ef4444;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-size:13px;z-index:1">📍</div>
    </div>`,
    iconSize: [44, 44], iconAnchor: [22, 22],
  });
}

function makeVehicleIcon(type, deg) {
  const m = TYPE_META[type] || TYPE_META.police;
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;width:48px;height:48px;border-radius:50%;background:${m.color}33;animation:mapPulse 1s infinite"></div>
      <div style="transform:rotate(${deg}deg);font-size:28px;z-index:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.8))">${m.vehicle}</div>
    </div>`,
    iconSize: [48, 48], iconAnchor: [24, 24],
  });
}

export default function EmergencyMap({ dispatch, userLocation, onEtaUpdate }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const vehicleRef = useRef(null);
  const routeLineRef = useRef(null);        // full grey route
  const progressLineRef = useRef(null);     // colored progress so far
  const serviceMarkerRef = useRef(null);
  const userMarkerRef = useRef(null);
  const routeDataRef = useRef(null);        // { coords, distanceKm, durationSec }
  const animRef = useRef(null);
  const startTimeRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | loading | en_route | arrived
  const [routeInfo, setRouteInfo] = useState(null);
  const [progressPct, setProgressPct] = useState(0);

  // Inject pulse keyframe once
  useEffect(() => {
    if (!document.getElementById('map-pulse-style')) {
      const s = document.createElement('style');
      s.id = 'map-pulse-style';
      s.textContent = `@keyframes mapPulse{0%,100%{transform:scale(1);opacity:0.7}50%{transform:scale(1.6);opacity:0}}`;
      document.head.appendChild(s);
    }
  }, []);

  // Init map
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView(userLocation, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;

    // User marker
    userMarkerRef.current = L.marker(userLocation, { icon: makeUserIcon(false) })
      .addTo(map).bindPopup('<b>📍 Caller Location</b>');

    // Show all service types passively
    const PASSIVE = {
      fire: [[12.9862,77.5996],[12.9250,77.5938],[12.9900,77.5520]],
      ambulance: [[12.9591,77.5790],[12.9767,77.6064]],
      police: [[12.9776,77.5993],[12.9882,77.5860]],
    };
    Object.entries(PASSIVE).forEach(([type, locs]) => {
      locs.forEach(([lat,lng]) => {
        L.marker([lat,lng], {
          icon: L.divIcon({
            className:'',
            html:`<div style="width:24px;height:24px;background:${TYPE_META[type].color}55;border:1px solid ${TYPE_META[type].color}88;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px">${TYPE_META[type].emoji}</div>`,
            iconSize:[24,24], iconAnchor:[12,12],
          }),
          opacity: 0.6,
        }).addTo(map).bindPopup(`${TYPE_META[type].label}`);
      });
    });
  }, []);

  // ── React to userLocation prop changes (spoken location geocoded in real-time) ──
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    // Update user marker position smoothly
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng(userLocation);
      userMarkerRef.current.setIcon(makeUserIcon(!!dispatch)); // pulse if dispatch active
    }
    // Pan/zoom to new location if not mid-dispatch (dispatch has its own fitBounds)
    if (!dispatch) {
      map.flyTo(userLocation, 14, { animate: true, duration: 1.5 });
    }
  }, [userLocation[0], userLocation[1]]);

  // Handle dispatch change — fetch real route + animate
  useEffect(() => {
    if (!dispatch || !mapRef.current) return;
    const map = mapRef.current;
    const meta = TYPE_META[dispatch.type] || TYPE_META.police;
    const { service, userLat, userLng } = dispatch;

    // Cancel any running animation
    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (routeLineRef.current) map.removeLayer(routeLineRef.current);
    if (progressLineRef.current) map.removeLayer(progressLineRef.current);
    if (serviceMarkerRef.current) map.removeLayer(serviceMarkerRef.current);
    if (vehicleRef.current) map.removeLayer(vehicleRef.current);

    setStatus('loading');
    setProgressPct(0);

    // Service origin marker
    serviceMarkerRef.current = L.marker([service.lat, service.lng], { icon: makeServiceIcon(dispatch.type) })
      .addTo(map)
      .bindPopup(`<b>${meta.emoji} ${service.name}</b><br/>🚨 Dispatched!`)
      .openPopup();

    // Pulsing user marker
    if (userMarkerRef.current) map.removeLayer(userMarkerRef.current);
    userMarkerRef.current = L.marker([userLat, userLng], { icon: makeUserIcon(true) })
      .addTo(map).bindPopup('<b>📍 Caller Location</b>');

    // Fit bounds immediately with straight-line placeholder
    map.fitBounds([[service.lat, service.lng], [userLat, userLng]], { padding: [80, 80] });

    // Draw straight placeholder route while OSRM loads
    routeLineRef.current = L.polyline([[service.lat, service.lng], [userLat, userLng]], {
      color: '#334155', weight: 4, dashArray: '8,8', opacity: 0.5,
    }).addTo(map);

    // Vehicle starts at service
    vehicleRef.current = L.marker([service.lat, service.lng], { icon: makeVehicleIcon(dispatch.type, 0), zIndexOffset: 1000 })
      .addTo(map).bindPopup(`${meta.vehicle} ${meta.label} en route…`);

    // Fetch OSRM route
    fetchRoute(service.lng, service.lat, userLng, userLat)
      .then(route => {
        routeDataRef.current = route;
        setRouteInfo({ distKm: route.distanceKm, durSec: route.durationSec });
        if (onEtaUpdate) onEtaUpdate(Math.round(route.durationSec));

        // Replace placeholder with real road route
        map.removeLayer(routeLineRef.current);
        routeLineRef.current = L.polyline(route.coords.map(([lng,lat]) => [lat,lng]), {
          color: '#475569', weight: 5, opacity: 0.6,
        }).addTo(map);

        progressLineRef.current = L.polyline([], {
          color: meta.color, weight: 5, opacity: 0.9,
        }).addTo(map);

        map.fitBounds(L.polyline(route.coords.map(([lng,lat]) => [lat,lng])).getBounds(), { padding: [80, 80] });

        setStatus('en_route');
        startTimeRef.current = performance.now();

        // Smooth animation loop
        function animate(now) {
          if (!routeDataRef.current) return;
          const elapsed = (now - startTimeRef.current) / 1000;
          const t = Math.min(1, elapsed / route.durationSec);
          const { lat, lng, bearing: deg } = interpolateRoute(route.coords, t);

          // Move vehicle
          vehicleRef.current?.setLatLng([lat, lng]);
          vehicleRef.current?.setIcon(makeVehicleIcon(dispatch.type, deg));

          // Update progress line (passed portion of route)
          const passedIdx = Math.floor(t * (route.coords.length - 1));
          const passed = route.coords.slice(0, passedIdx + 1).map(([clng, clat]) => [clat, clng]);
          passed.push([lat, lng]);
          progressLineRef.current?.setLatLngs(passed);

          setProgressPct(Math.round(t * 100));
          if (onEtaUpdate) onEtaUpdate(Math.max(0, Math.round(route.durationSec * (1 - t))));

          if (t < 1) {
            animRef.current = requestAnimationFrame(animate);
          } else {
            setStatus('arrived');
            vehicleRef.current?.setIcon(L.divIcon({
              className: '',
              html: `<div style="font-size:36px;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8))">✅</div>`,
              iconSize: [44, 44], iconAnchor: [22, 22],
            }));
            vehicleRef.current?.bindPopup(`✅ ${meta.label} ARRIVED`).openPopup();
          }
        }
        animRef.current = requestAnimationFrame(animate);
      })
      .catch(err => {
        // OSRM failed — fall back to straight-line animation with raw ETA
        console.warn('OSRM unavailable, using straight-line fallback:', err);
        const straightCoords = [[service.lng, service.lat], [userLng, userLat]];
        routeDataRef.current = { coords: straightCoords, distanceKm: service.distKm || 3, durationSec: dispatch.etaSeconds || 120 };
        setRouteInfo({ distKm: service.distKm, durSec: dispatch.etaSeconds });
        setStatus('en_route');
        startTimeRef.current = performance.now();

        function animateFallback(now) {
          const elapsed = (now - startTimeRef.current) / 1000;
          const t = Math.min(1, elapsed / (dispatch.etaSeconds || 120));
          const { lat, lng, bearing: deg } = interpolateRoute(straightCoords, t);
          vehicleRef.current?.setLatLng([lat, lng]);
          vehicleRef.current?.setIcon(makeVehicleIcon(dispatch.type, deg));
          setProgressPct(Math.round(t * 100));
          if (onEtaUpdate) onEtaUpdate(Math.max(0, Math.round((dispatch.etaSeconds || 120) * (1 - t))));
          if (t < 1) { animRef.current = requestAnimationFrame(animateFallback); }
          else { setStatus('arrived'); }
        }
        animRef.current = requestAnimationFrame(animateFallback);
      });

    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [dispatch?.dispatchId]);

  const meta = dispatch ? (TYPE_META[dispatch.type] || TYPE_META.police) : null;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', borderRadius: 12 }} />

      {/* Status overlay */}
      {dispatch && (
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 500, background: 'rgba(15,23,42,0.92)', backdropFilter: 'blur(8px)', border: `1px solid ${meta.color}44`, borderRadius: 12, padding: '12px 16px', minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 22 }}>{meta.vehicle}</span>
            <div>
              <div style={{ color: meta.color, fontWeight: 700, fontSize: 13 }}>{meta.label}</div>
              <div style={{ color: '#64748b', fontSize: 11 }}>{dispatch.service?.name}</div>
            </div>
          </div>

          {status === 'loading' && <div style={{ color: '#94a3b8', fontSize: 12 }}>⏳ Calculating route…</div>}
          {status === 'en_route' && routeInfo && (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>
              📏 {routeInfo.distKm?.toFixed(2)} km via road
            </div>
          )}
          {status === 'arrived' && <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 13 }}>✅ ARRIVED ON SCENE</div>}

          {status === 'en_route' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progressPct}%`, background: meta.color, borderRadius: 2, transition: 'width 0.5s ease' }} />
              </div>
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>{progressPct}% of route completed</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
