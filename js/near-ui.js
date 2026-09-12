// near-ui.js — not its own discovery mechanism: Near aggregates whatever
// peers have already been discovered elsewhere (across every other active
// namespace) and filters them by real distance from your own opt-in
// location. It never joins a P2P room of its own and never requires an
// identity — location is a device-level fact, not something one identity
// "owns".

import * as db from './db.js';
import { state, NAMESPACES, NS_CONFIG } from './state.js';
import { toast } from './ui-kit.js';
import { haversineDistanceKm, requestGeolocation, isGeolocationAvailable } from './geo.js';

async function hydrateNearPrefs() {
  const [enabled, coords, radius] = await Promise.all([
    db.get('cache', 'nearLocationEnabled'),
    db.get('cache', 'nearCoords'),
    db.get('cache', 'nearRadiusKm'),
  ]);
  state.nearLocationEnabled = !!enabled?.value;
  state.nearCoords = coords?.value ?? null;
  state.nearRadiusKm = radius?.value ?? 25;
}

function collectNearbyPeers() {
  if (!state.nearCoords) return [];
  const out = [];
  for (const ns of NAMESPACES) {
    if (NS_CONFIG[ns].kind === 'near' || NS_CONFIG[ns].kind === 'agent' || NS_CONFIG[ns].kind === 'messages') continue;
    const discovered = state.discovered[ns];
    if (!discovered) continue;
    for (const p of discovered.values()) {
      if (p.lat == null || p.lon == null) continue;
      const distanceKm = haversineDistanceKm(state.nearCoords.lat, state.nearCoords.lon, p.lat, p.lon);
      if (distanceKm <= state.nearRadiusKm) out.push({ ...p, ns, distanceKm });
    }
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

export async function renderNearWorkspace() {
  await hydrateNearPrefs();
  const nearby = collectNearbyPeers();
  const anySearching = NAMESPACES.some((ns) => NS_CONFIG[ns].kind !== 'near' && NS_CONFIG[ns].kind !== 'agent' && NS_CONFIG[ns].kind !== 'messages' && state.searchLive[ns]?.size > 0);

  const listHtml = !isGeolocationAvailable()
    ? `<div class="empty-state">Geolocation isn't available in this browser.</div>`
    : !state.nearLocationEnabled
      ? `<div class="empty-state">Enable location sharing above to see who's nearby.</div>`
      : !state.nearCoords
        ? `<div class="empty-state">Waiting for your location…</div>`
        : !anySearching
          ? `<div class="empty-state">Near only aggregates people already discovered elsewhere — start "Search" in another mode first.</div>`
          : nearby.length === 0
            ? `<div class="empty-state">Nobody with location sharing on has been found within ${state.nearRadiusKm} km yet.</div>`
            : `<div class="results">${nearby.map((p) => `
                <div class="card">
                  <div class="top">
                    <span class="avatar" style="background:${NS_CONFIG[p.ns].color}">📍</span>
                    <div class="info">
                      <div class="name">${NS_CONFIG[p.ns].label} — ${p.sender.slice(0, 10)}…</div>
                      <div class="role">${p.category || 'No category declared'}</div>
                      <div class="meta"><span class="chip">${p.distanceKm.toFixed(1)} km away</span></div>
                    </div>
                  </div>
                </div>`).join('')}</div>`;

  return `
    <div class="panel">
      <div class="switchctl" style="display:inline-flex">Share my location <button class="switch ${state.nearLocationEnabled ? 'on' : ''}" id="nearLocToggle"></button></div>
      <div style="margin-top:12px">
        <label style="font-size:11px;color:var(--low)">Radius: <b id="radiusVal">${state.nearRadiusKm}</b> km</label>
        <input type="range" id="nearRadius" min="1" max="200" value="${state.nearRadiusKm}" style="width:100%">
      </div>
      <p style="font-size:11px;color:var(--low);margin-top:10px">
        When on, your real coordinates piggyback on whichever namespace discovery broadcasts you're already sending — nothing new is transmitted just because Near is open.
      </p>
    </div>
    ${listHtml}
  `;
}

export function bindNearEvents() {
  const ws = document.getElementById('workspace');

  ws.querySelector('#nearLocToggle')?.addEventListener('click', async () => {
    if (!state.nearLocationEnabled) {
      toast('Requesting your location…');
      try {
        const coords = await requestGeolocation();
        state.nearCoords = coords;
        state.nearLocationEnabled = true;
        await db.put('cache', { key: 'nearCoords', value: coords });
        await db.put('cache', { key: 'nearLocationEnabled', value: true });
        await rebroadcastToActiveNamespaces();
        toast('Location enabled.');
      } catch (e) {
        toast('Could not get your location: ' + e.message);
        return;
      }
    } else {
      state.nearLocationEnabled = false;
      state.nearCoords = null;
      await db.put('cache', { key: 'nearLocationEnabled', value: false });
      await rebroadcastToActiveNamespaces();
    }
    state.render.workspace();
    state.render.all();
  });

  const radiusInput = ws.querySelector('#nearRadius');
  radiusInput?.addEventListener('input', (e) => {
    const label = document.getElementById('radiusVal');
    if (label) label.textContent = e.target.value;
  });
  radiusInput?.addEventListener('change', async (e) => {
    state.nearRadiusKm = parseInt(e.target.value, 10);
    await db.put('cache', { key: 'nearRadiusKm', value: state.nearRadiusKm });
    state.render.workspace();
  });
}

// Coordinates are carried on the *next* discovery broadcast normally, but
// anyone already connected won't see a location change until they
// reconnect unless we push it now — same reasoning as the AI-enrichment
// rebroadcast in discovery-ui.js.
async function rebroadcastToActiveNamespaces() {
  for (const ns of NAMESPACES) {
    if (NS_CONFIG[ns].kind === 'near' || NS_CONFIG[ns].kind === 'agent' || NS_CONFIG[ns].kind === 'messages') continue;
    if (!state.handlers.rebroadcastDiscovery) continue;
    if (!(state.searchLive[ns] instanceof Set)) continue; // Research's searchLive is a plain bool — not part of this model
    for (const identityId of state.searchLive[ns]) {
      await state.handlers.rebroadcastDiscovery(ns, identityId);
    }
  }
}
