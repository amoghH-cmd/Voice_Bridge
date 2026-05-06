// ── Karnataka Emergency Services (real Bangalore locations) ──────────────────
export const EMERGENCY_SERVICES = {
  fire: [
    { id: 'fs1', name: 'Shivajinagar Fire Station', lat: 12.9862, lng: 77.5996 },
    { id: 'fs2', name: 'Jayanagar Fire Station',    lat: 12.9250, lng: 77.5938 },
    { id: 'fs3', name: 'Rajajinagar Fire Station',  lat: 12.9900, lng: 77.5520 },
    { id: 'fs4', name: 'Koramangala Fire Station',  lat: 12.9352, lng: 77.6245 },
    { id: 'fs5', name: 'Banashankari Fire Station', lat: 12.9250, lng: 77.5490 },
  ],
  ambulance: [
    { id: 'amb1', name: 'Victoria Hospital',            lat: 12.9591, lng: 77.5790 },
    { id: 'amb2', name: 'Bowring Hospital Ambulance',   lat: 12.9767, lng: 77.6064 },
    { id: 'amb3', name: 'MS Ramaiah Hospital',          lat: 13.0099, lng: 77.5536 },
    { id: 'amb4', name: "St. Martha's Hospital",        lat: 12.9770, lng: 77.5937 },
    { id: 'amb5', name: 'Manipal Hospital (HAL)',       lat: 12.9432, lng: 77.6991 },
  ],
  police: [
    { id: 'pol1', name: 'Cubbon Park Police Station',   lat: 12.9776, lng: 77.5993 },
    { id: 'pol2', name: 'High Grounds Police Station',  lat: 12.9882, lng: 77.5860 },
    { id: 'pol3', name: 'Koramangala Police Station',   lat: 12.9279, lng: 77.6271 },
    { id: 'pol4', name: 'Indiranagar Police Station',   lat: 12.9784, lng: 77.6408 },
    { id: 'pol5', name: 'Jayanagar Police Station',     lat: 12.9262, lng: 77.5804 },
  ],
  rescue: [
    { id: 'res1', name: 'SDRF Karnataka HQ',       lat: 12.9716, lng: 77.5236 },
    { id: 'res2', name: 'Civil Defence Bangalore',  lat: 12.9640, lng: 77.5810 },
  ],
};

// Map LLM intent → dispatch type
export function getDispatchType(intentCategory, summary = '') {
  const s = (summary + ' ' + intentCategory).toLowerCase();
  if (s.includes('fire') || s.includes('burn') || s.includes('blast')) return 'fire';
  if (s.includes('medical') || s.includes('injur') || s.includes('accident') || s.includes('heart')) return 'ambulance';
  if (s.includes('mental') || s.includes('suicide') || s.includes('overdose')) return 'ambulance';
  const map = { medical: 'ambulance', mental_health: 'ambulance' };
  return map[intentCategory] || 'police';
}

// Haversine distance in km
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Get nearest N services of a given type
export function findNearest(userLat, userLng, type, n = 3) {
  const list = EMERGENCY_SERVICES[type] || EMERGENCY_SERVICES.police;
  return list
    .map(s => ({ ...s, distKm: haversineKm(userLat, userLng, s.lat, s.lng) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

// ETA in seconds assuming 30 km/h average urban speed
export function etaSeconds(distKm) {
  return Math.round((distKm / 30) * 3600);
}

// ── TTS: ElevenLabs → Web Speech API fallback ────────────────────────────────
export async function playTTS(text, language = 'en', apiBase = 'http://localhost:8000') {
  // Attempt 1: ElevenLabs proxy
  try {
    const audio = new Audio(`${apiBase}/api/tts?text=${encodeURIComponent(text)}`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(reject, 9000);
      audio.onended = () => { clearTimeout(t); resolve(); };
      audio.onerror = reject;
      audio.play().catch(reject);
    });
    return;
  } catch {
    console.warn('ElevenLabs TTS failed — using Web Speech API');
  }

  // Attempt 2: Browser Web Speech API
  if (!window.speechSynthesis) return;
  const langMap = { kn: 'kn-IN', hi: 'hi-IN', en: 'en-IN', kanglish: 'kn-IN', hinglish: 'hi-IN', unknown: 'en-IN' };
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = langMap[language] || 'en-IN';
  utt.rate = 0.9; utt.pitch = 1.05;
  await new Promise(resolve => { utt.onend = resolve; utt.onerror = resolve; window.speechSynthesis.speak(utt); });
}

// ── Geocoding: spoken location text → [lat, lng] using Nominatim (free) ──────
// Nominatim Usage Policy: add a descriptive User-Agent, max 1 req/sec.
export async function geocodeLocation(locationText) {
  if (!locationText || locationText.trim().length < 3) return null;
  // Append Karnataka/India context to improve accuracy
  const suffixed = locationText.toLowerCase().includes('karnatak') || locationText.toLowerCase().includes('bangalor')
    ? locationText
    : `${locationText}, Karnataka, India`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(suffixed)}&format=json&limit=1&countrycodes=in`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'VoiceBridge1092/1.0' }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        display: data[0].display_name,
      };
    }
  } catch (e) {
    console.warn('Nominatim geocoding failed:', e);
  }
  return null;
}
