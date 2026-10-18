#!/usr/bin/env node
/**
 * Track curve sanity check (run after changing the harmonics in Track.ts).
 *
 * Rebuilds the control-point ring exactly like the game does and verifies:
 *   1. the closed XZ polyline does not self-intersect (segment-segment
 *      distance for non-adjacent segments stays above a clearance margin),
 *   2. the minimum horizontal corner radius stays drivable,
 *   3. grades (dy/ds) stay within a sane arcade range.
 *
 * Usage: node tools/validate-track.mjs
 */

import * as THREE from 'three';

const ELEVATION = 11; // keep in sync with CONFIG.track.elevation

function controlPoints(segments) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const radius = 236 + Math.sin(a * 3) * 52 + Math.cos(a * 2 + 1.15) * 38 + Math.sin(a * 5 + 0.8) * 16;
    const y =
      Math.sin(a * 2 + 0.4) * ELEVATION + Math.cos(a * 3) * ELEVATION * 0.45 + Math.sin(a * 4 + 1.3) * ELEVATION * 0.3;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
  }
  return pts;
}

const curve = new THREE.CatmullRomCurve3(controlPoints(26), true, 'catmullrom', 0.5);
const N = 1600; // keep in sync with CONFIG.track.samples
const pts = curve.getSpacedPoints(N); // N + 1 points, last == first

// --- 1. self-intersection: min distance between non-adjacent XZ segments ---
function segSegDist2D(p1, p2, p3, p4) {
  // Conservative sampling: 8 points per segment pair is plenty for a
  // go/no-go check on a ~1.5 km ring.
  let best = Infinity;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const ax = p1.x + (p2.x - p1.x) * t;
    const az = p1.z + (p2.z - p1.z) * t;
    for (let j = 0; j <= 8; j++) {
      const u = j / 8;
      const bx = p3.x + (p4.x - p3.x) * u;
      const bz = p3.z + (p4.z - p3.z) * u;
      const dx = ax - bx;
      const dz = az - bz;
      best = Math.min(best, dx * dx + dz * dz);
    }
  }
  return Math.sqrt(best);
}

const halfWidth = 13; // CONFIG.track.halfWidth
const clearance = halfWidth * 2 + 2; // two road widths + margin
const skirtDepth = 9; // CONFIG.track.skirtDepth
// Pairs closer than this along the loop are the same stretch of road bending
// through a hairpin — near-approach there is curvature, not a crossing.
const arcExclude = 50; // samples (~1 m each with samples=1600)
const ringGap = (i, j, n) => Math.min(Math.abs(i - j), n - Math.abs(i - j)); // separation along the loop
let minGap = Infinity;
let minGapPair = [0, 0];
let minGapDy = 0;
const crossings = [];
const segCount = N;
for (let i = 0; i < segCount; i++) {
  const a1 = pts[i];
  const a2 = pts[(i + 1) % N];
  for (let j = i + arcExclude; j < segCount; j++) {
    if (ringGap(i, j, segCount) < arcExclude) continue;
    const b1 = pts[j];
    const b2 = pts[(j + 1) % N];
    const d = segSegDist2D(a1, a2, b1, b2);
    if (d < minGap) {
      minGap = d;
      minGapPair = [i, j];
      minGapDy = Math.abs(pts[i].y - pts[j].y);
    }
    // A genuine close approach: only acceptable when the two legs stack with
    // enough vertical clearance (self-crossing elevated interchange look).
    if (d < clearance && Math.abs(pts[i].y - pts[j].y) < skirtDepth + 3) crossings.push({ i, j, d, dy: Math.abs(pts[i].y - pts[j].y) });
  }
}

// --- 2. minimum horizontal corner radius ---
let minRadius = Infinity;
let minRadiusAt = 0;
let total = 0;
for (let i = 0; i < N; i++) {
  const prev = pts[(i - 1 + N) % N];
  const cur = pts[i];
  const next = pts[(i + 1) % N];
  const t1 = { x: cur.x - prev.x, z: cur.z - prev.z };
  const t2 = { x: next.x - cur.x, z: next.z - cur.z };
  const ds = (Math.hypot(t1.x, t1.z) + Math.hypot(t2.x, t2.z)) / 2;
  const cross = t1.x * t2.z - t1.z * t2.x;
  const dot = t1.x * t2.x + t1.z * t2.z;
  const dTheta = Math.abs(Math.atan2(cross, dot));
  if (dTheta > 1e-6) {
    const r = ds / dTheta;
    if (r < minRadius) {
      minRadius = r;
      minRadiusAt = i;
    }
  }
  total += Math.hypot(t2.x, t2.z);
}

// --- 3. max grade ---
let maxGrade = 0;
for (let i = 0; i < N; i++) {
  const cur = pts[i];
  const next = pts[(i + 1) % N];
  const ds = Math.hypot(next.x - cur.x, next.z - cur.z);
  const grade = Math.abs((next.y - cur.y) / Math.max(ds, 1e-6));
  maxGrade = Math.max(maxGrade, grade);
}

console.log(`ring length        : ${total.toFixed(0)} m`);
console.log(`min far-along gap  : ${minGap.toFixed(1)} m (dy ${minGapDy.toFixed(1)} m) at samples ${minGapPair}`);
console.log(`flat close passes  : ${crossings.length} (must be 0; stacked crossings need dy > ${skirtDepth + 3} m)`);
console.log(`min corner radius  : ${minRadius.toFixed(1)} m (want > ~24 m for the AI line) at sample ${minRadiusAt}`);
console.log(`max grade          : ${(maxGrade * 100).toFixed(1)} % / ${(Math.atan(maxGrade) * 57.296).toFixed(1)} deg`);

const okCross = crossings.length === 0;
const okRadius = minRadius > 24;
const okGrade = maxGrade < 0.28;
console.log(okCross && okRadius && okGrade ? '\nTRACK OK' : '\nTRACK NEEDS TUNING');
process.exit(okCross && okRadius && okGrade ? 0 : 1);
