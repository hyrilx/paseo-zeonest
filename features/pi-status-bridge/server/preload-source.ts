// Standalone Node preload embedded in the server bundle; no runtime source/dependency lookup.
export const preloadSource = String.raw`import { request } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { isMainThread } from 'node:worker_threads';

const endpoint = process.env.ZEONEST_PI_STATUS_URL;
const token = process.env.ZEONEST_PI_STATUS_TOKEN;
const ownsEnvironment = process.env.ZEONEST_PI_STATUS_PRELOAD === import.meta.url;
// Restore only our own addition. Children retain the user's Node options, never this channel.
if (ownsEnvironment) {
  try {
    const base = JSON.parse(process.env.ZEONEST_PI_STATUS_BASE_NODE_OPTIONS);
    if (base === null) delete process.env.NODE_OPTIONS;
    else if (typeof base === 'string') process.env.NODE_OPTIONS = base;
  } catch { /* A malformed launch marker must not prevent Pi from starting. */ }
  for (const name of ['ZEONEST_PI_STATUS_URL', 'ZEONEST_PI_STATUS_TOKEN', 'ZEONEST_PI_STATUS_PRELOAD', 'ZEONEST_PI_STATUS_BASE_NODE_OPTIONS']) delete process.env[name];
}
const args = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');
const rpc = ['rpc', 'rpc-ui'].includes(modeIndex < 0 ? (args.find(arg => arg.startsWith('--mode=')) || '').slice(7) : args[modeIndex + 1]);
const marker = Symbol.for('zeonest.pi-status-bridge.observer');
if (ownsEnvironment && isMainThread && rpc && endpoint && token && /^http:\/\/127\.0\.0\.1:\d+\/snapshot$/.test(endpoint) && !globalThis[marker]) {
  globalThis[marker] = true;
  try { install(); } catch { /* Observability must not change launch success. */ }
}
function install() {
  const statuses = new Map();
  let active = true, dirty = true, diagnosed = false, sessionReady = false;
  let failuresSince = 0, failures = 0, retryAt = 0, generation = 0, sequence = 0;
  let warning = null, warningKey = null, inflight = null, timer;
  function diagnose(message) {
    if (diagnosed) return;
    diagnosed = true;
    try { process.stderr.write('[Zeonest Pi status] ' + message + '\n'); } catch {}
  }
  function problem(message, key = null) { warning = message; warningKey = key; dirty = true; diagnose(message); }
  function recovered(key) {
    if (warning !== null && warningKey === key) { warning = null; warningKey = null; dirty = true; }
  }
  function stopTransport() {
    active = false;
    clearInterval(timer);
    statuses.clear();
    pending = '';
    inflight?.destroy(); inflight = null;
  }
  function failedTransport() {
    if (!active) return;
    dirty = true;
    failuresSince ||= Date.now();
    retryAt = Date.now() + Math.min(2000, 200 * 2 ** Math.min(++failures, 4));
    if (Date.now() - failuresSince >= 16000) stopTransport();
  }
  function publish(force = false) {
    if (!active || !sessionReady || inflight || Date.now() < retryAt || (!dirty && !force)) return;
    const body = JSON.stringify({ version: 1, sequence: sequence++, statuses: [...statuses].map(([key, text]) => ({ key, text })), warning });
    dirty = false;
    const req = request(endpoint, {
      method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    }, res => {
      res.resume();
      res.on('error', () => {
        if (inflight !== req) return;
        inflight = null;
        failedTransport();
        diagnose('bridge response interrupted; Pi RPC continues normally');
      });
      res.on('end', () => {
        if (inflight !== req) return;
        inflight = null;
        if (res.statusCode !== 204) {
          if (res.statusCode === 403 || res.statusCode === 410) stopTransport();
          else failedTransport();
          diagnose('bridge rejected snapshot (' + res.statusCode + ')');
        } else { failuresSince = 0; failures = 0; retryAt = 0; }
      });
    });
    inflight = req;
    req.on('socket', socket => socket.unref());
    req.setTimeout(2000, () => req.destroy(new Error('bridge timeout')));
    req.on('error', () => {
      if (inflight === req) inflight = null;
      failedTransport();
      diagnose('bridge unavailable; Pi RPC continues normally');
    });
    req.end(body);
  }
  function observe(line, oversized = false) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    // Paseo 0.15.4 can launch a separate MCP capability probe with the same env.
    // That probe only asks for commands. Buffer startup statuses, but publish only
    // once the real agent's initial get_state handshake succeeds.
    if (event?.type === 'response' && event.command === 'get_state' && event.success === true) { sessionReady = true; return; }
    if (event?.type !== 'extension_ui_request' || event.method !== 'setStatus') return;
    const { statusKey: key, statusText: text } = event;
    // A truncated header cannot tell an absent key from one after the payload.
    if (oversized && !Object.hasOwn(event, 'statusKey')) return;
    if (typeof key !== 'string' || !key.length || key.length > 256) { problem('Invalid or oversized status key was skipped'); return; }
    if (oversized) { statuses.delete(key); problem('Status RPC line exceeds 1048576 characters; status hidden', key); return; }
    if (text === undefined || text === null) { statuses.delete(key); recovered(key); dirty = true; return; }
    if (typeof text !== 'string') { problem('Non-text status was skipped', key); return; }
    if (text.length > 65536) { statuses.delete(key); problem('Status exceeds 65536 characters', key); return; }
    const before = statuses.get(key);
    if (!statuses.has(key) && statuses.size >= 128) { problem('More than 128 statuses; new status skipped', key); return; }
    statuses.set(key, text);
    if (Buffer.byteLength(JSON.stringify([...statuses])) > 500000) {
      if (before === undefined) statuses.delete(key); else statuses.set(key, before);
      problem('Total status size exceeds 500000 bytes; update skipped', key); return;
    }
    recovered(key); dirty = true;
  }
  // Pi 1.5.2 emits routing fields before the payload. On overflow retain only a
  // bounded header: tool results/images are unrelated to statuses, and a large
  // get_state response must still complete the real-session handshake.
  const HEADER_LIMIT = 4096, LINE_LIMIT = 1048576;
  function observeOversized(prefix) {
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let index = 0; index < prefix.length; index++) {
      const char = prefix[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      else if (char === ',' && depth === 1) end = index;
    }
    // Parse only complete top-level fields, never embedded JSON/text in payloads.
    if (end >= 0) observe(prefix.slice(0, end) + '}', true);
  }
  const decoder = new StringDecoder('utf8');
  let pending = '', skipping = false;
  function header(tail) {
    const prefix = pending.slice(0, HEADER_LIMIT) + tail.slice(0, Math.max(0, HEADER_LIMIT - pending.length));
    // Join only bounded pieces and copy them; a slice must not retain a huge write.
    return Buffer.from(prefix).toString('utf8');
  }
  function tap(chunk) {
    const text = decoder.write(chunk);
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '\n') continue;
      const part = text.slice(start, index);
      if (!skipping && pending.length + part.length <= LINE_LIMIT) observe(pending + part);
      else observeOversized(skipping ? pending : header(part));
      pending = ''; skipping = false; start = index + 1;
    }
    if (!skipping) {
      const tail = text.slice(start);
      if (pending.length + tail.length <= LINE_LIMIT) pending += tail;
      else { pending = header(tail); skipping = true; }
    }
  }
  const originalWrite = process.stdout.write;
  // Pi's takeOverStdout() subsequently binds this function as its raw RPC writer.
  // Never replace arguments/callbacks, await HTTP, retry writes or override the return value.
  process.stdout.write = function (...args) {
    const result = Reflect.apply(originalWrite, this, args);
    if (active) {
      try {
        const [chunk, encoding] = args;
        tap(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk);
      } catch { stopTransport(); diagnose('observer stopped; Pi RPC continues normally'); }
    }
    return result;
  };
  timer = setInterval(() => {
    try { publish(++generation % 25 === 0); }
    catch { stopTransport(); diagnose('transport stopped; Pi RPC continues normally'); }
  }, 200);
  timer.unref();
  process.once('exit', stopTransport);
  // First publish is deferred: HTTP cannot affect startup or Pi's first RPC frame.
}
`;
