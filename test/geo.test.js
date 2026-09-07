import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineDistanceKm, isGeolocationAvailable } from '../js/geo.js';

test('haversineDistanceKm is zero for the same point', () => {
  assert.equal(haversineDistanceKm(46.5197, 6.6323, 46.5197, 6.6323), 0);
});

test('haversineDistanceKm matches the known Paris-London great-circle distance (~344 km)', () => {
  const d = haversineDistanceKm(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(d > 340 && d < 350, `expected ~344 km, got ${d}`);
});

test('haversineDistanceKm matches the known Lausanne-Geneva distance (~52 km)', () => {
  const d = haversineDistanceKm(46.5197, 6.6323, 46.2044, 6.1432);
  assert.ok(d > 48 && d < 56, `expected ~52 km, got ${d}`);
});

test('haversineDistanceKm is symmetric', () => {
  const a = haversineDistanceKm(48.8566, 2.3522, 51.5074, -0.1278);
  const b = haversineDistanceKm(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('isGeolocationAvailable does not throw outside a browser (no navigator.geolocation in Node)', () => {
  assert.equal(typeof isGeolocationAvailable(), 'boolean');
});
