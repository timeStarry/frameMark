import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadTool, vue, window, waitFor} from './helpers/tool-dom.mjs';

globalThis.history = window.history;
const require = createRequire(import.meta.url);
const {createRouter, createMemoryHistory, RouterView} = require('vue-router');
const Studio = (await import(await loadTool('src/views/StudioView.vue'))).default;
const csrfToken = 's'.repeat(43);
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {'content-type': 'application/json'},
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
};
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await vue.nextTick();
};
const byId = (host, id) => host.querySelector(`[data-testid="${id}"]`);
const required = (host, id) => {
  const element = byId(host, id);
  assert.ok(element, `expected ${id} to be rendered`);
  return element;
};
const setInput = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event('input', {bubbles: true}));
};
const setCheckbox = (input, checked) => {
  input.checked = checked;
  input.dispatchEvent(new window.Event('change', {bubbles: true}));
};
const choose = (select, value) => {
  select.value = value;
  select.dispatchEvent(new window.Event('change', {bubbles: true}));
};
const submit = form => form.dispatchEvent(new window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
const isDisabled = element => element.disabled || Boolean(element.closest('fieldset[disabled]'));
const selectWith = (form, value) => [...form.querySelectorAll('select')].find(
  select => [...select.options].some(option => option.value === value),
);
const checkboxLabel = (form, text) => {
  const label = [...form.querySelectorAll('label')].find(label => label.textContent.includes(text));
  assert.ok(label, `expected checkbox label ${text}`);
  const input = label.querySelector('input[type="checkbox"]');
  assert.ok(input, `expected checkbox for ${text}`);
  return input;
};
const requestBody = call => JSON.parse(call.options.body);

function fixture() {
  return {
    asset: [{id: 'asset-existing', kind: 'asset', format: 'jpeg', width: 64, height: 48, bytes: 100}],
    work: [{
      id: 'work-existing', kind: 'work', title: 'Existing photograph', text: 'Existing caption',
      assets: ['asset-existing'], works: [], status: 'draft', visibility: 'private',
      distribute: true, allowOriginal: false, license: null, aiDeclaration: null, tags: [],
    }],
    collection: [],
    profile: [{
      id: 'profile-existing', kind: 'profile', name: 'Fixture photographer', bio: 'Fixture biography',
      cover: null, accent: '#ccd4c4', layout: 'grid', modules: ['works', 'collections'],
    }],
  };
}

function localApi(state = fixture(), handler = () => undefined) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    assert.ok(typeof url === 'string' && url.startsWith('/api/'), 'tests only use local mocked API paths');
    const call = {url, options};
    calls.push(call);
    const handled = await handler(call, state);
    if (handled !== undefined) return handled;
    if (url === '/api/me') return response({user: 'fixture-user', identityEnabled: true});
    if (url === '/api/auth/session') return response({user: 'fixture-user', csrfToken});
    if (url === '/api/studio') return response(state);
    if (url === '/api/square') return response({works: [], banner: []});
    if (url === '/api/work/work-existing') return response(state.work.find(work => work.id === 'work-existing'));
    throw new Error(`Unexpected mocked request: ${options.method || 'GET'} ${url}`);
  };
  return {fetcher, calls, state};
}

function saveRecord(state, kind, id, call, changes = {}) {
  const record = {...requestBody(call), ...changes, id, kind};
  state[kind] = [record, ...state[kind].filter(existing => existing.id !== id)];
  return response(record, call.options.method === 'POST' ? 201 : 200);
}

async function mount(api, {platform = false} = {}) {
  const previousFetch = globalThis.fetch;
  const previousConfirm = window.confirm;
  globalThis.fetch = api.fetcher;
  window.confirm = () => true;
  const routeComponent = platform
    ? (await import(await loadTool('src/views/Platform.vue'))).default
    : Studio;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {path: '/', component: platform ? routeComponent : {template: '<p data-testid="square">square</p>'}},
      {path: '/studio', component: routeComponent},
      {path: '/login', component: {template: '<p>login</p>'}},
      {path: '/tools', component: {template: '<p>tools</p>'}},
      {path: '/work/:id', component: platform ? routeComponent : {template: '<p>work</p>'}},
      {path: '/collection/:id', component: platform ? routeComponent : {template: '<p>collection</p>'}},
      {path: '/profile/:id', component: platform ? routeComponent : {template: '<p>profile</p>'}},
    ],
  });
  await router.push('/studio');
  await router.isReady();
  const host = document.createElement('div');
  document.body.append(host);
  const app = vue.createApp({render: () => vue.h(RouterView)});
  app.use(router);
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      app.unmount();
    }
  };
  return {
    host, router, unmount,
    close() {
      unmount();
      host.remove();
      globalThis.fetch = previousFetch;
      window.confirm = previousConfirm;
    },
  };
}

async function ready(m) {
  await waitFor(() => byId(m.host, 'studio-title') && !isDisabled(byId(m.host, 'studio-title')));
}

test('studio read failure has its own retry and recovers without a mutation error', async () => {
  let reads = 0;
  const api = localApi(fixture(), call => {
    if (call.url === '/api/studio' && ++reads === 1) return response({error: 'Fixture read failure'}, 503);
  });
  const m = await mount(api);
  try {
    await waitFor(() => byId(m.host, 'studio-read-error'));
    assert.match(required(m.host, 'studio-read-error').textContent, /Fixture read failure/);
    assert.equal(byId(m.host, 'studio-mutation-error'), null);
    required(m.host, 'studio-read-error').querySelector('button').click();
    await ready(m);
    assert.equal(reads, 2);
    assert.equal(byId(m.host, 'studio-read-error'), null);
    assert.ok(byId(m.host, 'studio-edit-work-existing'));
  } finally { m.close(); }
});

test('failed work save retains fields and retries the mutation without reloading the studio', async () => {
  let attempts = 0;
  const api = localApi(fixture(), (call, state) => {
    if (call.url === '/api/work') {
      if (++attempts === 1) return response({error: 'Fixture save failure'}, 503);
      return saveRecord(state, 'work', 'work-saved', call);
    }
  });
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Retained draft title');
    setInput(required(m.host, 'studio-content-form').querySelector('textarea'), 'Retained draft caption');
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => byId(m.host, 'studio-mutation-error'));
    assert.match(required(m.host, 'studio-mutation-error').textContent, /Fixture save failure/);
    assert.equal(byId(m.host, 'studio-read-error'), null);
    assert.equal(required(m.host, 'studio-title').value, 'Retained draft title');
    assert.equal(required(m.host, 'studio-content-form').querySelector('textarea').value, 'Retained draft caption');
    assert.equal(api.calls.filter(call => call.url === '/api/studio').length, 1);
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => byId(m.host, 'studio-edit-work-saved') && !isDisabled(byId(m.host, 'studio-save')));
    assert.equal(attempts, 2);
    assert.equal(byId(m.host, 'studio-mutation-error'), null);
    const bodies = api.calls.filter(call => call.url === '/api/work').map(requestBody);
    assert.equal(bodies[1].title, bodies[0].title);
    assert.equal(bodies[1].text, bodies[0].text);
  } finally { m.close(); }
});

test('pending work save attaches CSRF, blocks double submit and disables conflicting controls', async () => {
  const pending = deferred();
  const api = localApi(fixture(), call => call.url === '/api/work' ? pending.promise : undefined);
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'One pending save');
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => api.calls.some(call => call.url === '/api/work'));
    await vue.nextTick();
    submit(required(m.host, 'studio-content-form'));
    required(m.host, 'studio-new').click();
    required(m.host, 'studio-edit-work-existing').click();
    required(m.host, 'studio-tab-collection').click();
    required(m.host, 'studio-tab-profile').click();
    await settle();
    assert.equal(api.calls.filter(call => call.url === '/api/work').length, 1);
    assert.equal(api.calls.filter(call => call.url === '/api/auth/session').length, 1);
    const call = api.calls.find(call => call.url === '/api/work');
    assert.equal(new Headers(call.options.headers).get('X-CSRF-Token'), csrfToken);
    assert.equal(call.options.credentials, 'same-origin');
    for (const id of ['studio-save', 'studio-new', 'studio-edit-work-existing', 'studio-tab-work', 'studio-tab-collection', 'studio-tab-profile']) {
      assert.ok(isDisabled(required(m.host, id)), `${id} should be disabled during save`);
    }
    for (const field of required(m.host, 'studio-content-form').querySelectorAll('input, textarea, select')) {
      assert.ok(isDisabled(field), 'editor fields should be disabled during save');
    }
    assert.equal(required(m.host, 'studio-title').value, 'One pending save');
    assert.equal(required(m.host, 'studio-tab-work').getAttribute('aria-pressed'), 'true');
    pending.resolve(saveRecord(api.state, 'work', 'work-pending', call));
    await waitFor(() => byId(m.host, 'studio-edit-work-pending') && !isDisabled(byId(m.host, 'studio-save')));
  } finally {
    pending.resolve(response({error: 'Fixture cleanup'}, 503));
    m.close();
    await settle();
  }
});

test('editing work preserves publication, license, declaration and original-download controls in a PUT', async () => {
  const state = fixture();
  const license = {code: 'by-nc', label: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/'};
  const declaration = {code: 'no-generative-ai', label: '未使用生成式 AI（作者自声明）', source: 'author'};
  Object.assign(state.work[0], {
    status: 'published', visibility: 'unlisted', distribute: false, allowOriginal: true,
    license, aiDeclaration: declaration,
  });
  const api = localApi(state, (call, records) => {
    if (call.url === '/api/work/work-existing') {
      return saveRecord(records, 'work', 'work-existing', call, {license, aiDeclaration: declaration});
    }
  });
  const m = await mount(api);
  try {
    await ready(m);
    required(m.host, 'studio-edit-work-existing').click();
    await vue.nextTick();
    const form = required(m.host, 'studio-content-form');
    assert.equal(required(m.host, 'studio-title').value, 'Existing photograph');
    assert.equal(selectWith(form, 'by').value, 'by-nc');
    assert.equal(selectWith(form, 'no-generative-ai').value, 'no-generative-ai');
    assert.equal(selectWith(form, 'published').value, 'published');
    assert.equal(selectWith(form, 'unlisted').value, 'unlisted');
    assert.equal(checkboxLabel(form, '允许访客下载原文件').checked, true);
    assert.equal(checkboxLabel(form, '公开时进入广场').checked, false);
    setInput(form.querySelector('textarea'), 'Updated caption with retained controls');
    submit(form);
    await waitFor(() => api.calls.some(call => call.url === '/api/work/work-existing' && call.options.method === 'PUT') && !isDisabled(byId(m.host, 'studio-save')));
    const call = api.calls.find(call => call.url === '/api/work/work-existing' && call.options.method === 'PUT');
    const body = requestBody(call);
    assert.equal(body.text, 'Updated caption with retained controls');
    assert.equal(body.license, 'by-nc');
    assert.equal(body.aiDeclaration, 'no-generative-ai');
    assert.equal(body.allowOriginal, true);
    assert.equal(body.distribute, false);
    assert.equal(body.status, 'published');
    assert.equal(body.visibility, 'unlisted');
    assert.deepEqual(body.assets, ['asset-existing']);
    assert.equal(selectWith(form, 'by').value, 'by-nc');
    assert.equal(selectWith(form, 'no-generative-ai').value, 'no-generative-ai');
    assert.equal(new Headers(call.options.headers).get('X-CSRF-Token'), csrfToken);
  } finally { m.close(); }
});

test('a query and hash update during pending creation keeps the saved id so the next save uses PUT', async () => {
  const pending = deferred();
  const api = localApi(fixture(), (call, state) => {
    if (call.url === '/api/work') return pending.promise;
    if (call.url === '/api/work/work-query') return saveRecord(state, 'work', 'work-query', call);
  });
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Draft across local URL changes');
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => api.calls.some(call => call.url === '/api/work'));
    await m.router.push('/studio?panel=work#draft');
    assert.equal(m.router.currentRoute.value.fullPath, '/studio?panel=work#draft');
    assert.ok(isDisabled(required(m.host, 'studio-save')));
    const create = api.calls.find(call => call.url === '/api/work');
    pending.resolve(saveRecord(api.state, 'work', 'work-query', create));
    await waitFor(() => byId(m.host, 'studio-edit-work-query') && !isDisabled(byId(m.host, 'studio-save')));
    assert.equal(required(m.host, 'studio-title').value, 'Draft across local URL changes');
    setInput(required(m.host, 'studio-content-form').querySelector('textarea'), 'Updated after creation');
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => api.calls.some(call => call.url === '/api/work/work-query') && !isDisabled(byId(m.host, 'studio-save')));
    assert.equal(api.calls.filter(call => call.url === '/api/work').length, 1);
    const update = api.calls.find(call => call.url === '/api/work/work-query');
    assert.equal(update.options.method, 'PUT');
    assert.equal(requestBody(update).text, 'Updated after creation');
    assert.equal(api.calls.filter(call => call.url === '/api/studio').length, 1);
  } finally {
    pending.resolve(response({error: 'Fixture cleanup'}, 503));
    m.close();
    await settle();
  }
});

test('logout-all attaches CSRF, allows one pending request and redirects after one dirty confirmation', async () => {
  const pending = deferred();
  const api = localApi(fixture(), call => call.url === '/api/auth/logout-all' ? pending.promise : undefined);
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Unsaved before logout');
    let confirmations = 0;
    window.confirm = () => { confirmations++; return true; };
    const logoutAll = [...m.host.querySelectorAll('button')].find(button => button.textContent.includes('退出所有会话'));
    assert.ok(logoutAll);
    logoutAll.click();
    logoutAll.click();
    await waitFor(() => api.calls.some(call => call.url === '/api/auth/logout-all'));
    assert.equal(confirmations, 1);
    assert.equal(logoutAll.disabled, true);
    const calls = api.calls.filter(call => call.url === '/api/auth/logout-all');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(new Headers(calls[0].options.headers).get('X-CSRF-Token'), csrfToken);
    assert.equal(api.calls.filter(call => call.url === '/api/auth/session').length, 1);
    pending.resolve(response({user: null, csrfToken: 'n'.repeat(43)}));
    await waitFor(() => m.router.currentRoute.value.path === '/login');
    assert.equal(confirmations, 1);
    assert.equal(byId(m.host, 'studio-workspace'), null);
  } finally {
    pending.resolve(response({error: 'Fixture cleanup'}, 503));
    m.close();
    await settle();
  }
});

test('partial upload retains successful assets and retries the same failed and unattempted Files', async () => {
  const good = new File(['good fixture'], 'good.jpg', {type: 'image/jpeg'});
  const failed = new File(['failed fixture'], 'failed.jpg', {type: 'image/jpeg'});
  const later = new File(['later fixture'], 'later.jpg', {type: 'image/jpeg'});
  const uploaded = [];
  let failedOnce = false;
  const api = localApi(fixture(), (call, state) => {
    if (call.url === '/api/assets') {
      const file = call.options.body.get('file');
      uploaded.push(file);
      if (file === failed && !failedOnce) {
        failedOnce = true;
        return response({error: 'Fixture upload failure'}, 503);
      }
      const asset = {id: `asset-${file.name.split('.')[0]}`, kind: 'asset', width: 64, height: 48, bytes: file.size};
      state.asset.unshift(asset);
      return response(asset, 201);
    }
    if (call.url === '/api/work') return saveRecord(state, 'work', 'work-uploaded', call);
  });
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Draft with successful upload');
    const input = required(m.host, 'studio-upload');
    Object.defineProperty(input, 'files', {configurable: true, value: [good, failed, later]});
    input.dispatchEvent(new window.Event('change', {bubbles: true}));
    await waitFor(() => byId(m.host, 'studio-upload-retry'));
    assert.deepEqual(uploaded, [good, failed]);
    assert.equal(required(m.host, 'studio-title').value, 'Draft with successful upload');
    assert.equal(required(m.host, 'studio-content-form').querySelector('input[type="checkbox"][value="asset-good"]').checked, true);
    assert.equal(byId(m.host, 'studio-read-error'), null);
    required(m.host, 'studio-tab-collection').click();
    await vue.nextTick();
    assert.equal(byId(m.host, 'studio-upload-retry'), null);
    assert.equal(required(m.host, 'studio-mutation-error').querySelector('button'), null);
    required(m.host, 'studio-tab-work').click();
    await vue.nextTick();
    assert.equal(required(m.host, 'studio-mutation-error').querySelectorAll('button').length, 1);
    assert.doesNotMatch(required(m.host, 'studio-mutation-error').textContent, /重试保存/);
    required(m.host, 'studio-upload-retry').click();
    await waitFor(() => uploaded.length === 4 && !isDisabled(byId(m.host, 'studio-save')));
    assert.deepEqual(uploaded, [good, failed, failed, later]);
    assert.equal(byId(m.host, 'studio-upload-retry'), null);
    for (const id of ['asset-good', 'asset-failed', 'asset-later']) {
      const selected = required(m.host, 'studio-content-form').querySelectorAll(`input[type="checkbox"][value="${id}"]`);
      assert.equal(selected.length, 1);
      assert.equal(selected[0].checked, true);
    }
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => byId(m.host, 'studio-edit-work-uploaded') && !isDisabled(byId(m.host, 'studio-save')));
    assert.deepEqual(requestBody(api.calls.find(call => call.url === '/api/work')).assets.sort(), ['asset-failed', 'asset-good', 'asset-later']);
    for (const call of api.calls.filter(call => call.url === '/api/assets')) {
      assert.equal(new Headers(call.options.headers).get('X-CSRF-Token'), csrfToken);
    }
  } finally { m.close(); }
});

test('a wholly failed upload protects queued Files during New, Edit and route navigation even with a blank form', async () => {
  const file = new File(['queued fixture'], 'queued.jpg', {type: 'image/jpeg'});
  const api = localApi(fixture(), call => call.url === '/api/assets'
    ? response({error: 'Wholly failed upload'}, 503)
    : undefined);
  const m = await mount(api);
  try {
    await ready(m);
    const input = required(m.host, 'studio-upload');
    Object.defineProperty(input, 'files', {configurable: true, value: [file]});
    input.dispatchEvent(new window.Event('change', {bubbles: true}));
    await waitFor(() => byId(m.host, 'studio-upload-retry'));
    assert.equal(required(m.host, 'studio-title').value, '');
    const beforeUnload = new window.Event('beforeunload', {cancelable: true});
    window.dispatchEvent(beforeUnload);
    assert.equal(beforeUnload.defaultPrevented, true);
    let confirmations = 0;
    window.confirm = () => { confirmations++; return false; };
    required(m.host, 'studio-new').click();
    await vue.nextTick();
    assert.equal(confirmations, 1);
    assert.ok(byId(m.host, 'studio-upload-retry'));
    required(m.host, 'studio-edit-work-existing').click();
    await vue.nextTick();
    assert.equal(confirmations, 2);
    assert.equal(required(m.host, 'studio-title').value, '');
    assert.ok(byId(m.host, 'studio-upload-retry'));
    await m.router.push('/');
    assert.equal(confirmations, 3);
    assert.equal(m.router.currentRoute.value.path, '/studio');
    assert.ok(byId(m.host, 'studio-upload-retry'));
    window.confirm = () => { confirmations++; return true; };
    required(m.host, 'studio-new').click();
    await vue.nextTick();
    assert.equal(confirmations, 4);
    assert.equal(byId(m.host, 'studio-upload-retry'), null);
    assert.equal(byId(m.host, 'studio-mutation-error'), null);
    const cleanUnload = new window.Event('beforeunload', {cancelable: true});
    window.dispatchEvent(cleanUnload);
    assert.equal(cleanUnload.defaultPrevented, false);
    await m.router.push('/');
    assert.equal(confirmations, 4);
    assert.equal(m.router.currentRoute.value.path, '/');
    assert.equal(api.calls.filter(call => call.url === '/api/assets').length, 1);
  } finally { m.close(); }
});

test('late studio read is aborted and ignored after route departure', async () => {
  const pending = deferred();
  let reads = 0;
  const api = localApi(fixture(), call => {
    if (call.url === '/api/studio' && ++reads === 1) return pending.promise;
  });
  const m = await mount(api);
  try {
    await waitFor(() => api.calls.some(call => call.url === '/api/studio'));
    const call = api.calls.find(call => call.url === '/api/studio');
    await m.router.push('/');
    assert.equal(call.options.signal.aborted, true);
    pending.resolve(response({...fixture(), work: [{...fixture().work[0], title: 'Stale departed read'}]}));
    await settle();
    assert.equal(m.router.currentRoute.value.path, '/');
    assert.equal(byId(m.host, 'studio-workspace'), null);
    await m.router.push('/studio');
    await ready(m);
    assert.equal(reads, 2);
    assert.doesNotMatch(m.host.textContent, /Stale departed read/);
  } finally {
    pending.resolve(response(fixture()));
    m.close();
    await settle();
  }
});

test('late unauthorized mutation after unmount cannot redirect the current route', async () => {
  const pending = deferred();
  const api = localApi(fixture(), call => call.url === '/api/work' ? pending.promise : undefined);
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Departed draft');
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => api.calls.some(call => call.url === '/api/work'));
    m.unmount();
    await m.router.push('/');
    pending.resolve(response({error: 'Expired departed session'}, 401));
    await settle();
    await settle();
    assert.equal(m.router.currentRoute.value.path, '/');
    assert.equal(api.calls.filter(call => call.url === '/api/studio').length, 1);
  } finally {
    pending.resolve(response({error: 'Fixture cleanup'}, 503));
    m.close();
    await settle();
  }
});

test('dirty router navigation can be cancelled and accepted without losing the draft on cancellation', async () => {
  const m = await mount(localApi());
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Unsaved navigation draft');
    let confirmations = 0;
    window.confirm = () => { confirmations++; return false; };
    await m.router.push('/');
    assert.equal(confirmations, 1);
    assert.equal(m.router.currentRoute.value.path, '/studio');
    assert.equal(required(m.host, 'studio-title').value, 'Unsaved navigation draft');
    window.confirm = () => { confirmations++; return true; };
    await m.router.push('/');
    assert.equal(confirmations, 2);
    assert.equal(m.router.currentRoute.value.path, '/');
  } finally { m.close(); }
});

test('dirty leave guard works through the real Platform nested in RouterView during a public route record change', async () => {
  const api = localApi();
  const m = await mount(api, {platform: true});
  try {
    await ready(m);
    assert.equal(api.calls.filter(call => call.url === '/api/studio').length, 1);
    setInput(required(m.host, 'studio-title'), 'Nested Studio draft');
    let confirmations = 0;
    window.confirm = () => { confirmations++; return false; };
    await m.router.push('/work/work-existing');
    assert.equal(confirmations, 1);
    assert.equal(m.router.currentRoute.value.path, '/studio');
    assert.equal(required(m.host, 'studio-title').value, 'Nested Studio draft');
    assert.equal(api.calls.some(call => call.url === '/api/work/work-existing'), false);
    window.confirm = () => { confirmations++; return true; };
    await m.router.push('/work/work-existing');
    await waitFor(() => [...m.host.querySelectorAll('h1')].some(heading => heading.textContent.trim() === 'Existing photograph'));
    assert.equal(confirmations, 2);
    assert.equal(m.router.currentRoute.value.path, '/work/work-existing');
    assert.equal(byId(m.host, 'studio-workspace'), null);
  } finally { m.close(); }
});

test('work and collection tabs retain separate drafts and collection saves member and publication controls', async () => {
  const api = localApi(fixture(), (call, state) => {
    if (call.url === '/api/collection') return saveRecord(state, 'collection', 'collection-saved', call);
    if (call.url === '/api/collection/collection-saved') return saveRecord(state, 'collection', 'collection-saved', call);
  });
  const m = await mount(api);
  try {
    await ready(m);
    setInput(required(m.host, 'studio-title'), 'Separate work draft');
    required(m.host, 'studio-tab-collection').click();
    await vue.nextTick();
    assert.equal(required(m.host, 'studio-tab-collection').getAttribute('aria-pressed'), 'true');
    assert.equal(required(m.host, 'studio-title').value, '');
    assert.equal(byId(m.host, 'studio-upload'), null);
    const form = required(m.host, 'studio-content-form');
    assert.ok(form.querySelector('[role="group"][aria-label="选择成员作品"]'));
    assert.equal(selectWith(form, 'no-generative-ai'), undefined);
    assert.equal(selectWith(form, 'by'), undefined);
    setInput(required(m.host, 'studio-title'), 'Separate collection draft');
    setCheckbox(form.querySelector('input[type="checkbox"][value="work-existing"]'), true);
    choose(selectWith(form, 'published'), 'published');
    choose(selectWith(form, 'unlisted'), 'unlisted');
    required(m.host, 'studio-tab-work').click();
    await vue.nextTick();
    assert.equal(required(m.host, 'studio-title').value, 'Separate work draft');
    required(m.host, 'studio-tab-collection').click();
    await vue.nextTick();
    assert.equal(required(m.host, 'studio-title').value, 'Separate collection draft');
    assert.equal(required(m.host, 'studio-content-form').querySelector('input[value="work-existing"]').checked, true);
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => byId(m.host, 'studio-edit-collection-saved') && !isDisabled(byId(m.host, 'studio-save')));
    const call = api.calls.find(call => call.url === '/api/collection');
    assert.equal(call.options.method, 'POST');
    assert.equal(requestBody(call).title, 'Separate collection draft');
    assert.deepEqual(requestBody(call).works, ['work-existing']);
    assert.equal(requestBody(call).status, 'published');
    assert.equal(requestBody(call).visibility, 'unlisted');
    required(m.host, 'studio-edit-collection-saved').click();
    await vue.nextTick();
    setInput(required(m.host, 'studio-title'), 'Updated collection');
    submit(required(m.host, 'studio-content-form'));
    await waitFor(() => api.calls.some(call => call.url === '/api/collection/collection-saved') && !isDisabled(byId(m.host, 'studio-save')));
    assert.equal(api.calls.find(call => call.url === '/api/collection/collection-saved').options.method, 'PUT');
  } finally { m.close(); }
});

test('profile mutation retry retains fields and successful server values persist across tabs', async () => {
  let attempts = 0;
  const api = localApi(fixture(), (call, state) => {
    if (call.url === '/api/profile/profile-existing') {
      if (++attempts === 1) return response({error: 'Fixture profile failure'}, 503);
      return saveRecord(state, 'profile', 'profile-existing', call, {name: 'Saved photographer name'});
    }
  });
  const m = await mount(api);
  try {
    await ready(m);
    required(m.host, 'studio-tab-profile').click();
    await vue.nextTick();
    assert.equal(required(m.host, 'studio-profile-name').value, 'Fixture photographer');
    setInput(required(m.host, 'studio-profile-name'), 'Retained photographer name');
    submit(required(m.host, 'studio-profile-form'));
    await waitFor(() => byId(m.host, 'studio-mutation-error'));
    assert.match(required(m.host, 'studio-mutation-error').textContent, /Fixture profile failure/);
    assert.equal(required(m.host, 'studio-profile-name').value, 'Retained photographer name');
    assert.equal(byId(m.host, 'studio-read-error'), null);
    submit(required(m.host, 'studio-profile-form'));
    await waitFor(() => byId(m.host, 'studio-profile-name')?.value === 'Saved photographer name' && !isDisabled(byId(m.host, 'studio-profile-save')));
    assert.equal(byId(m.host, 'studio-mutation-error'), null);
    required(m.host, 'studio-tab-work').click();
    await vue.nextTick();
    required(m.host, 'studio-tab-profile').click();
    await vue.nextTick();
    assert.equal(required(m.host, 'studio-profile-name').value, 'Saved photographer name');
    const calls = api.calls.filter(call => call.url === '/api/profile/profile-existing');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.options.method === 'PUT'));
    assert.equal(requestBody(calls[1]).name, 'Retained photographer name');
    assert.equal(new Headers(calls[1].options.headers).get('X-CSRF-Token'), csrfToken);
  } finally { m.close(); }
});
