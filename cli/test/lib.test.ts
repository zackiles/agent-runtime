import { assertEquals } from '@std/assert'

Deno.test('basic assertion test', () => {
  const result = 2 + 2
  assertEquals(result, 4)
})

Deno.test('async test example', async () => {
  const promise = Promise.resolve('async result')
  const result = await promise
  assertEquals(result, 'async result')
})
