const tails = new Map();
/** Serialize a user's optimized mutations so two hash-based patches cannot both use the same baseline. */
export async function withUserWriteLock(handle, action) {
    const previous = tails.get(handle) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    tails.set(handle, next);
    await previous;
    try { return await action(); }
    finally { release(); if (tails.get(handle) === next) tails.delete(handle); }
}
