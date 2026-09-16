#!/usr/bin/env node

/*
 * Carga reproducible para el polling de la aplicación. Por defecto emula una
 * sesión activa: 30 ciclos de dos segundos y sin solapar ciclos de esa sesión.
 * Aumentar JUNTOSS_LOAD_CONCURRENCY simula sesiones independientes y permite
 * observar concurrencia real en Workers/Neon.
 *
 * Está pensado para staging con una cuenta y un espacio de prueba. No usa
 * dependencias externas para que pueda ejecutarse antes de un despliegue.
 */

const baseUrl = required("JUNTOSS_API_BASE_URL").replace(/\/$/, "");
const authorization = required("JUNTOSS_API_AUTHORIZATION");
const spaceIds = optionalList("JUNTOSS_SPACE_IDS");
const cycles = positiveInteger("JUNTOSS_LOAD_CYCLES", 30);
const intervalMs = positiveInteger("JUNTOSS_LOAD_INTERVAL_MS", 2_000);
const concurrency = positiveInteger("JUNTOSS_LOAD_CONCURRENCY", 1);
const includeSync = process.env.JUNTOSS_LOAD_INCLUDE_SYNC === "1";
const since = process.env.JUNTOSS_SYNC_SINCE ?? new Date(Date.now() - 60_000).toISOString();
const max429 = nonNegativeInteger("JUNTOSS_LOAD_MAX_429", 0);
const maxErrorRate = ratio("JUNTOSS_LOAD_MAX_ERROR_RATE", 0);
const maxP95Ms = optionalPositiveInteger("JUNTOSS_LOAD_MAX_P95_MS");

const samples = new Map();
const startedAt = performance.now();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalList(name) {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

function positiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function optionalPositiveInteger(name) {
  return process.env[name] === undefined ? null : positiveInteger(name, 1);
}

function ratio(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be a number from 0 to 1`);
  return parsed;
}

function record(name, durationMs, status) {
  const values = samples.get(name) ?? [];
  values.push({ durationMs, status });
  samples.set(name, values);
}

async function request(name, path, options = {}) {
  const requestStartedAt = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        authorization,
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    status = response.status;
    // Consumir el cuerpo mantiene el pool de conexiones sano y hace que la
    // medición incluya el coste de la respuesta que recibe la app.
    await response.arrayBuffer();
  } catch (error) {
    console.error(JSON.stringify({ metric: "sync_load_transport_error", endpoint: name, error: String(error) }));
  } finally {
    record(name, performance.now() - requestStartedAt, status);
  }
}

async function runSession(sessionIndex) {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const scheduledAt = startedAt + cycle * intervalMs;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    // Igual que el cliente: un ciclo no inicia el siguiente hasta terminar.
    await request("sync_changes", `/v1/sync/changes?since=${encodeURIComponent(since)}`);
    await request("account_me", "/v1/me");
    for (const spaceId of spaceIds) {
      await request("space_members", `/v1/spaces/${encodeURIComponent(spaceId)}/members`);
    }
    if (includeSync) {
      await request("space_sync", `/v1/spaces/${encodeURIComponent(spaceIds[0] ?? "missing-space")}/sync`, {
        method: "POST",
        body: JSON.stringify({
          installationId: `load-test-${sessionIndex}`,
          categories: [], moneyAccounts: [], recurringSeries: [], transactions: [],
        }),
      });
    }
  }
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => runSession(index + 1)));

const report = {};
const failures = [];
for (const [endpoint, values] of samples) {
  const latency = values.map((value) => value.durationMs).sort((a, b) => a - b);
  const statuses = Object.fromEntries([...new Set(values.map((value) => value.status))].sort().map((status) => [status, values.filter((value) => value.status === status).length]));
  const throttled429 = values.filter((value) => value.status === 429).length;
  const errorCount = values.filter((value) => value.status === 0 || value.status >= 400).length;
  const p95 = Math.round(percentile(latency, 0.95));
  report[endpoint] = {
    requests: values.length,
    transportErrors: values.filter((value) => value.status === 0).length,
    throttled429,
    statusCodes: statuses,
    latencyMs: {
      p50: Math.round(percentile(latency, 0.5)),
      p95,
      p99: Math.round(percentile(latency, 0.99)),
      max: Math.round(latency.at(-1) ?? 0),
    },
  };
  if (throttled429 > max429) failures.push(`${endpoint}: ${throttled429} responses 429 (maximum ${max429})`);
  if (errorCount / values.length > maxErrorRate) failures.push(`${endpoint}: ${(errorCount / values.length * 100).toFixed(2)}% errors (maximum ${maxErrorRate * 100}%)`);
  if (maxP95Ms !== null && p95 > maxP95Ms) failures.push(`${endpoint}: p95 ${p95}ms (maximum ${maxP95Ms}ms)`);
}

console.log(JSON.stringify({
  metric: "sync_load_summary",
  cycles,
  intervalMs,
  concurrency,
  spaceCount: spaceIds.length,
  includeSync,
  thresholds: { max429, maxErrorRate, maxP95Ms },
  elapsedMs: Math.round(performance.now() - startedAt),
  endpoints: report,
}, null, 2));

if (failures.length > 0) {
  console.error(JSON.stringify({ metric: "sync_load_threshold_failed", failures }));
  process.exitCode = 1;
}
