import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import EndFrame from './EndFrame.vue'
import { card, collection, fullFrame, neighbors, photo } from './testFixtures'

const col = collection([fullFrame(photo('p1')), fullFrame(photo('p2'))])

describe('EndFrame', () => {
  let w: VueWrapper | null = null
  afterEach(() => {
    w?.unmount()
    w = null
  })

  it('shows the collection name, count, and three entries when there is a next collection', async () => {
    w = mount(EndFrame, {
      props: {
        collection: col,
        neighbors: neighbors({ next: card('c2', '山中', '林', 'u2'), strip: [] }),
        mode: 'public',
      },
    })
    expect(w.text()).toContain('海边')
    expect(w.text()).toMatch(/2/)
    const restart = w.get('button')
    expect(w.text()).toContain('从头再看')
    expect(w.find('a[href="/u/u1"]').text()).toMatch(/作者主页/)
    expect(w.text()).toContain('下一组')
    expect(w.text()).toContain('山中')
    expect(w.text()).toContain('林')
    await w.findAll('button').find((b) => b.text().includes('从头再看'))!.trigger('click')
    expect(w.emitted('go')).toEqual([[1]])
    await w.findAll('button').find((b) => b.text().includes('下一组'))!.trigger('click')
    expect(w.emitted('navigate')).toEqual([[1]])
  })

  it('uses 回到墙 when there is no next collection', async () => {
    w = mount(EndFrame, {
      props: { collection: col, neighbors: neighbors({ next: null }), mode: 'public' },
    })
    expect(w.text()).toContain('回到墙')
    expect(w.text()).not.toContain('下一组')
    await w.findAll('button').find((b) => b.text().includes('回到墙'))!.trigger('click')
    expect(w.emitted('exit')).toHaveLength(1)
  })

  it('in preview mode only offers 从头再看', () => {
    w = mount(EndFrame, {
      props: {
        collection: col,
        neighbors: neighbors({ next: card('c2', '山中') }),
        mode: 'preview',
      },
    })
    expect(w.text()).toContain('从头再看')
    expect(w.text()).not.toContain('作者主页')
    expect(w.text()).not.toContain('下一组')
    expect(w.text()).not.toContain('回到墙')
  })
})
