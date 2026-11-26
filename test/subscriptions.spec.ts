import assert from 'node:assert/strict'
import test from 'node:test'
import { eventBus, publishEvent, Topic } from '../src/topic'

test('subscription events reach iterators through the shared bus', async () => {
    const iterator = eventBus.asyncIterableIterator(Topic.NewLike)
    const payload = {
        likedBy: 'Test User',
        blogTitle: 'Subscription migration',
        blogId: 'blog-1',
    }

    const nextEvent = iterator.next()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await publishEvent(Topic.NewLike, payload)
    assert.deepEqual(await nextEvent, { value: payload, done: false })
    await iterator.return?.()
})
