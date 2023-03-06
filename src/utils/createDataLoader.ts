export const mapAsyncIterable = <T, O>(map: (input: T) => Promise<O> | O) =>
    async function* mapGenerator(asyncIterable: AsyncIterableIterator<T>) {
        for await (const value of asyncIterable) {
            yield map(value)
        }
    }
