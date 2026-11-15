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
  let warning = null, inflight = null, timer;
  function diagnose(message) {
    if (diagnosed) return;
    diagnosed = true;
    try { process.stderr.write('[Zeonest Pi status] ' + message + '\n'); } catch {}
  }
  function problem(message) { warning = message; dirty = true; diagnose(message); }
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
  function observe(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    // Paseo 0.15.4 can launch a separate MCP capability probe with the same env.
    // That probe only asks for commands. Buffer startup statuses, but publish only
    // once the real agent's initial get_state handshake succeeds.
    if (event?.type === 'response' && event.command === 'get_state' && event.success === true) { sessionReady = true; return; }
    if (event?.type !== 'extension_ui_request' || event.method !== 'setStatus') return;
    const { statusKey: key, statusText: text } = event;
    if (typeof key !== 'string' || !key.length || key.length > 256) { problem('Invalid or oversized status key was skipped'); return; }
    if (text === undefined || text === null) { statuses.delete(key); dirty = true; return; }
    if (typeof text !== 'string') { problem('Non-text status was skipped'); return; }
    if (text.length > 65536) { statuses.delete(key); problem('Status exceeds 65536 characters'); return; }
    const before = statuses.get(key);
    if (!statuses.has(key) && statuses.size >= 128) { problem('More than 128 statuses; new status skipped'); return; }
    statuses.set(key, text);
    if (Buffer.byteLength(JSON.stringify([...statuses])) > 500000) {
      if (before === undefined) statuses.delete(key); else statuses.set(key, before);
      problem('Total status size exceeds 500000 bytes; update skipped');
    }
    dirty = true;
  }
  const decoder = new StringDecoder('utf8');
  let pending = '', skipping = false;
  function tap(chunk) {
    const text = decoder.write(chunk);
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '\n') continue;
      const part = text.slice(start, index);
      if (!skipping && pending.length + part.length <= 1048576) observe(pending + part);
      else problem('Oversized RPC line skipped by status bridge');
      pending = ''; skipping = false; start = index + 1;
    }
    if (!skipping) {
      pending += text.slice(start);
      if (pending.length > 1048576) { pending = ''; skipping = true; }
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
