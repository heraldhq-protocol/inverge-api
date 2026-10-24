#!/usr/bin/env node
/**
 * Closed-loop load probe for the public read routes.
 *
 * This is a smoke-level baseline, not a capacity test: one API process, one
 * database, no cache, no rate limiter, no TLS and no auth. It exists so the
 * numbers in docs/api/query-performance.md can be reproduced.
 *
 * Usage:
 *   node scripts/load-public-reads.mjs \
 *     --base http://127.0.0.1:3100 \
 *     --duration 10 \
 *     --concurrency 20
 */

import http from 'node:http';
import { URL } from 'node:url';

const options = parseArgs(process.argv.slice(2));
const base = options.base ?? 'http://127.0.0.1:3100';
const durationSeconds = Number(options.duration ?? 10);
const concurrency = Number(options.concurrency ?? 20);
const warmup = Number(options.warmup ?? 20);

const endpoints = [
  { name: 'ideas list', path: '/api/v1/ideas?limit=21' },
  { name: 'campaigns newest', path: '/api/v1/campaigns?limit=21&sort=newest' },
  {
    name: 'campaigns closing soon',
    path: '/api/v1/campaigns?limit=21&sort=closing-soon',
  },
  {
    name: 'campaigns most backed',
    path: '/api/v1/campaigns?limit=21&sort=most-backed',
  },
  { name: 'idea detail', path: '/api/v1/ideas/idea-0' },
  { name: 'escrow projection', path: '/api/v1/platform/escrow' },
];

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });

function request(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(url, { agent, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

async function measure(endpoint) {
  for (let i = 0; i < warmup; i += 1) {
    try {
      await request(endpoint.path);
    } catch {
      // A warm-up failure is reported by the measured run.
    }
  }

  const latencies = [];
  const statuses = new Map();
  const deadline = Date.now() + durationSeconds * 1000;
  let errors = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const start = process.hrtime.bigint();
      try {
        const response = await request(endpoint.path);
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        latencies.push(ms);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (response.status !== 200) errors += 1;
      } catch {
        errors += 1;
      }
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const sorted = latencies.slice().sort((a, b) => a - b);

  return {
    name: endpoint.name,
    requests: latencies.length,
    rps: latencies.length / elapsedSeconds,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    errors,
    statuses: Object.fromEntries(statuses),
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      parsed[key] = value;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function pad(value, width) {
  return String(value).padStart(width);
}

console.log(
  `base=${base} duration=${durationSeconds}s concurrency=${concurrency} warmup=${warmup}`,
);
console.log(
  `${'endpoint'.padEnd(26)} ${pad('reqs', 7)} ${pad('rps', 8)} ${pad('p50', 9)} ${pad('p95', 9)} ${pad('p99', 9)} ${pad('errors', 7)}`,
);

for (const endpoint of endpoints) {
  const result = await measure(endpoint);
  console.log(
    `${result.name.padEnd(26)} ${pad(result.requests, 7)} ${pad(result.rps.toFixed(1), 8)} ${pad(`${result.p50.toFixed(2)}ms`, 9)} ${pad(`${result.p95.toFixed(2)}ms`, 9)} ${pad(`${result.p99.toFixed(2)}ms`, 9)} ${pad(result.errors, 7)}`,
  );
  if (result.errors > 0) {
    console.log(`  statuses: ${JSON.stringify(result.statuses)}`);
  }
}

agent.destroy();
