import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm } from '../src/core/geo.js';

test('haversineKm : distance nulle entre un point et lui-meme', () => {
  assert.equal(haversineKm(48.8566, 2.3522, 48.8566, 2.3522), 0);
});

test('haversineKm : distance Paris-Lyon plausible (environ 390km, tolerance large)', () => {
  const d = haversineKm(48.8566, 2.3522, 45.7640, 4.8357);
  assert.ok(d > 350 && d < 420, `distance inattendue: ${d}`);
});

test('haversineKm : renvoie null si une coordonnee manque', () => {
  assert.equal(haversineKm(48.8566, 2.3522, null, 4.8357), null);
  assert.equal(haversineKm(undefined, 2.3522, 45.7640, 4.8357), null);
});
