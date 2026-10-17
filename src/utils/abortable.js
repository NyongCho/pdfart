export const abortable = (promise, signal, createError = () => new Error('aborted')) => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(createError());

    return new Promise((resolve, reject) => {
        const onAbort = () => reject(createError());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
};
