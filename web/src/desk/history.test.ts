import { describe, expect, it } from 'vitest'
import { createHistory } from './history'

describe('createHistory', () => {
  it('undoes and redoes', () => {
    const h = createHistory(0)
    expect(h.canUndo()).toBe(false)
    expect(h.undo()).toBeNull()
    h.push(1)
    h.push(2)
    expect(h.current()).toBe(2)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.undo()).toBeNull()
    expect(h.current()).toBe(0)
    expect(h.canRedo()).toBe(true)
    expect(h.redo()).toBe(1)
    expect(h.redo()).toBe(2)
    expect(h.redo()).toBeNull()
    expect(h.canRedo()).toBe(false)
  })

  it('a push after undo clears redo', () => {
    const h = createHistory('a')
    h.push('b')
    h.undo()
    h.push('c')
    expect(h.canRedo()).toBe(false)
    expect(h.redo()).toBeNull()
    expect(h.undo()).toBe('a')
  })

  it('caps undo depth at max', () => {
    const h = createHistory(0, 3)
    for (let i = 1; i <= 5; i++) h.push(i)
    expect(h.undo()).toBe(4)
    expect(h.undo()).toBe(3)
    expect(h.undo()).toBe(2)
    expect(h.undo()).toBeNull()
    expect(h.current()).toBe(2)
  })

  it('defaults to 50 steps', () => {
    const h = createHistory(0)
    for (let i = 1; i <= 60; i++) h.push(i)
    let n = 0
    while (h.undo() !== null) n++
    expect(n).toBe(50)
    expect(h.current()).toBe(10)
  })

  it('reset clears both stacks', () => {
    const h = createHistory(0)
    h.push(1)
    h.push(2)
    h.undo()
    h.reset(9)
    expect(h.current()).toBe(9)
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
  })
})
