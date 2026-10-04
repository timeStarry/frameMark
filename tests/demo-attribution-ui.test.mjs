import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {vue, loadTool, window} from './helpers/tool-dom.mjs';

globalThis.history = window.history;
const require = createRequire(import.meta.url);
const {createRouter, createMemoryHistory} = require('vue-router');
const WorkViewer = (await import(await loadTool('src/components/photography/WorkViewer.vue'))).default;

const source = {
  title: '山间晨光', author: 'Example Photographer',
  sourcePage: 'https://commons.wikimedia.org/wiki/File:Morning_light.jpg',
  licenseName: 'CC BY 4.0', licenseURL: 'https://creativecommons.org/licenses/by/4.0/',
  changes: '缩小至展示尺寸，并转换为 WebP；未裁切。',
};
function work(extra = {}) {
  return {id: 'demo-morning', title: '晨光', photographer: 'markr-demo', photographerName: 'Markr Demo',
    assets: ['demo-photo'], media: [{id: 'demo-photo', width: 1200, height: 800}],
    isDemo: true, attributions: [{...source}], allowOriginal: false, license: null, aiDeclaration: null, ...extra};
}
async function mount(record) {
  const props = vue.reactive({work: record});
  const router = createRouter({history: createMemoryHistory(), routes: [{path: '/:pathMatch(.*)*', component: {render: () => null}}]});
  await router.push('/work/' + record.id); await router.isReady();
  const host = document.createElement('div'); document.body.append(host);
  const app = vue.createApp({render: () => vue.h(WorkViewer, props)});
  app.use(router); app.mount(host); await vue.nextTick();
  return {host, props, close() {app.unmount(); host.remove();}};
}

test('demo viewer clearly identifies borrowed photos and shows each exact source, author, license and changes', async () => {
  const second = {...source, title: '城市倒影', author: 'Second Photographer', sourcePage: 'https://www.flickr.com/photos/example/12345/',
    licenseName: 'CC0 1.0', licenseURL: 'https://creativecommons.org/publicdomain/zero/1.0/', changes: '缩小至 1600 像素。'};
  const m = await mount(work({attributions: [source, second]}));
  try {
    assert.equal(m.host.querySelector('.work-viewer__demo').textContent, '演示内容 · 非本站用户原创');
    assert.equal(m.host.querySelector('h1').textContent, '晨光');
    const items = [...m.host.querySelectorAll('[aria-label="图片来源与许可"] li')];
    assert.equal(items.length, 2);
    for (const [index, record] of [source, second].entries()) {
      const item = items[index];
      assert.ok(item.textContent.includes(record.title)); assert.ok(item.textContent.includes(record.author));
      assert.ok(item.textContent.includes(record.changes));
      const links = [...item.querySelectorAll('a')];
      assert.deepEqual(links.map(link => link.getAttribute('href')), [record.sourcePage, record.licenseURL]);
      assert.ok(links[1].textContent.includes(record.licenseName));
      for (const link of links) {
        assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
        assert.ok(link.textContent.includes('新窗口'));
      }
    }
    assert.equal(m.host.querySelector('a[href$="/original"]'), null);
    assert.equal(m.host.querySelector('.work-viewer__permissions'), null);
    assert.doesNotMatch(m.host.textContent, /未使用.*AI|本站用户原创作品|demo-photo/);
    assert.equal(m.host.querySelector('.work-viewer__author').getAttribute('href'), '/profile/markr-demo');
  } finally {m.close();}
});

test('unsafe source and license addresses remain plain text without actionable external links', async () => {
  const unsafe = [
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'http://commons.wikimedia.org/wiki/File:Example.jpg', '//commons.wikimedia.org/wiki/File:Example.jpg',
    '/relative', 'https://commons.wikimedia.org.evil.example/file',
    'https://commons.wikimedia.org@evil.example/file', 'https://user:secret@commons.wikimedia.org/file',
    'https://commons.wikimedia.org:444/file', 'https://example.com/file',
  ];
  const m = await mount(work({attributions: unsafe.map((url, index) => ({...source, title: `来源 ${index}`, sourcePage: url, licenseURL: url})),
    license: {label: 'Unsafe generic license', url: 'javascript:alert(2)'}}));
  try {
    assert.equal(m.host.querySelectorAll('.work-viewer__attributions li').length, unsafe.length);
    assert.equal(m.host.querySelectorAll('a[target="_blank"]').length, 0);
    assert.equal(m.host.querySelectorAll('.work-viewer__attributions a').length, 0);
    assert.ok(m.host.textContent.includes('CC BY 4.0'));
    assert.ok(m.host.textContent.includes('原始页面链接不可用'));
    assert.equal(m.host.innerHTML.includes('javascript:'), false);
  } finally {m.close();}
});

test('long attribution text is escaped and malformed records do not create markup or links', async () => {
  const title = '<script>window.injected=true</script>' + '很长的摄影作品名称'.repeat(40);
  const author = '<img src=x onerror=alert(1)> & Photographer';
  const changes = '<a href="javascript:alert(2)">原样文本</a>\n仅转换格式。';
  const m = await mount(work({attributions: [null, [], 1, 'invalid', {}, {...source, title, author, changes,
    licenseName: '<svg onload=alert(3)>许可文本</svg>'}]}));
  try {
    const section = m.host.querySelector('.work-viewer__attributions');
    assert.equal(section.querySelectorAll('li').length, 1);
    assert.ok(section.textContent.includes(title)); assert.ok(section.textContent.includes(author)); assert.ok(section.textContent.includes(changes));
    assert.equal(section.querySelector('script, img, svg, [onerror], [onload]'), null);
    assert.equal(section.querySelectorAll('a').length, 2);
    assert.match(section.innerHTML, /&lt;script&gt;/);
    assert.equal(section.querySelectorAll('a[href^="javascript:"]').length, 0);
  } finally {m.close();}
});

test('ordinary works keep their existing declarations and downloads with no demo or attribution block', async () => {
  const m = await mount(work({isDemo: false, attributions: undefined, allowOriginal: true,
    license: {label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/'},
    aiDeclaration: {label: '未使用生成式 AI（作者自声明）'}}));
  try {
    assert.equal(m.host.querySelector('.work-viewer__demo'), null);
    assert.equal(m.host.querySelector('.work-viewer__attributions'), null);
    assert.ok(m.host.textContent.includes('未使用生成式 AI（作者自声明）'));
    assert.equal(m.host.querySelector('.work-viewer__permissions a[target="_blank"]').getAttribute('href'), 'https://creativecommons.org/licenses/by/4.0/');
    assert.equal(m.host.querySelector('a[href$="/original"]').getAttribute('href'), '/api/media/demo-photo/original');
    m.props.work = work(); await vue.nextTick();
    assert.ok(m.host.querySelector('.work-viewer__demo'));
    assert.ok(m.host.querySelector('.work-viewer__attributions'));
    assert.equal(m.host.querySelector('a[href$="/original"]'), null);
    assert.equal(m.host.querySelector('.work-viewer__permissions'), null);
    m.props.work = work({isDemo: false, attributions: []}); await vue.nextTick();
    assert.equal(m.host.querySelector('.work-viewer__demo'), null);
    assert.equal(m.host.querySelector('.work-viewer__attributions'), null);
  } finally {m.close();}
});
