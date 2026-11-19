// Kept as source so the server remains a single bundle. This child imports the
// installed Pi SDK, not the CLI entrypoint or any user/project extension.
export const subscriptionWorker = String.raw`
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const controller = new AbortController();
const { signal } = controller;
let pending;
let sequence = 0;
const send = (message) => process.connected && process.send(message);
function prompt(value) {
  const scoped = value.signal ? AbortSignal.any([signal, value.signal]) : signal;
  scoped.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const abort = () => finish(reject, scoped.reason);
    function finish(done, result) {
      scoped.removeEventListener('abort', abort);
      if (pending?.id === id) pending = undefined;
      send({ type: 'clear', id });
      done(result);
    }
    pending = { id, reply: (answer) => finish(resolve, answer) };
    scoped.addEventListener('abort', abort, { once: true });
    send({ type: 'prompt', id, kind: value.type, message: value.message, options: value.options?.map(({ id, label }) => ({ value: id, label })) });
  });
}
function notify(event) {
  if (event.type === 'auth_url') send({ type: 'link', url: event.url });
  if (event.type === 'device_code') send({ type: 'link', url: event.verificationUri, code: event.userCode });
}
const ref = (model) => model.provider + '/' + model.id;
async function run({ entry, agentDir, request }) {
  const { ModelRuntime, SettingsManager, resolveModelScopeWithDiagnostics } = await import(pathToFileURL(entry).href);
  const nativeSettings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'),
    allowModelNetwork: false, signal,
  });
  const subscriptions = runtime.getProviders().filter((provider) => provider.auth?.oauth?.isSubscription);
  function requireSubscription(id) {
    if (!subscriptions.some((provider) => provider.id === id)) throw new Error('Not a subscription provider');
  }
  if (request.action === 'login' || request.action === 'logout') {
    requireSubscription(request.provider);
    const stored = await runtime.listCredentials({ signal });
    if (request.action === 'login') {
      if (stored.some((entry) => entry.providerId === request.provider && entry.type !== 'oauth')) throw new Error('Existing non-OAuth credential');
      await runtime.login(request.provider, 'oauth', { signal, notify, prompt }, { getDeviceId: () => nativeSettings.getOrCreateDeviceId() });
    } else if (stored.some((entry) => entry.providerId === request.provider && entry.type === 'oauth')) {
      await runtime.logout(request.provider, { signal });
    }
    await nativeSettings.flush();
    await runtime.settleCredentialWrites();
    return null;
  }
  let refreshFailed = false;
  if (request.refresh) {
    requireSubscription(request.refresh);
    if (process.env.PI_OFFLINE !== undefined) refreshFailed = true;
    else {
      const result = await runtime.refresh({ providers: [request.refresh], allowNetwork: true, signal });
      refreshFailed = !!(result.aborted || result.errors.has(request.refresh));
    }
  }
  const [models, stored] = await Promise.all([runtime.getAvailable(undefined, { signal }), runtime.listCredentials({ signal })]);
  const providers = subscriptions.map(({ id, name, auth }) => ({ id, name: (auth.oauth.name ?? name ?? id).slice(0, 160), connected: stored.some((entry) => entry.providerId === id && entry.type === 'oauth') }));
  const fixedInventory = { getAvailable: async () => models };
  const rules = [];
  let matchCount = 0;
  for (const pattern of new Set(request.patterns)) {
    signal.throwIfAborted();
    const { scopedModels } = await resolveModelScopeWithDiagnostics([pattern], fixedInventory, { signal });
    matchCount += scopedModels.length;
    if (matchCount > 50000) throw new Error('Too many model matches');
    rules.push({ pattern, matches: scopedModels.map(({ model, thinkingLevel }) => ({ ref: ref(model), thinking: thinkingLevel })) });
  }
  if (models.length > 10000) throw new Error('Too many models');
  return { providers, rules, refreshFailed, models: models.map((model) => ({ provider: model.provider, id: model.id, context: String(model.contextWindow),
    contextWindow: model.contextWindow, maxOutput: String(model.maxTokens), reasoning: !!model.reasoning, images: model.input?.includes('image') ?? false })) };
}
let started = false;
process.on('message', (message) => {
  if (message.type === 'cancel') controller.abort();
  if (message.type === 'reply' && pending?.id === message.id) pending.reply(message.value);
  if (message.type !== 'start' || started) return;
  started = true;
  run(message).then((value) => send({ type: 'done', value }), () => send({ type: 'failed' }));
});
process.on('disconnect', () => controller.abort());
`;
