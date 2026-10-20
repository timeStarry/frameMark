import { expect, it } from 'vitest'
import { wallRoute } from './wallRoute'

it.each([
  ['square', 'u9', '/'],
  ['user:u1', 'u9', '/u/u1'],
  ['album:a 1', 'u9', '/a/a%201'],
  ['user', 'u9', '/u/u9'],
  [null, 'u9', '/u/u9'],
  ['weird', 'u9', '/u/u9'],
])('%s → %s', (w, o, path) => expect(wallRoute(w, o)).toBe(path))
