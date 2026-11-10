// Pure shared contract: safe to import from server code and bridge generators.
export const SHARED_BUILD_TIMEOUT_MS = 10000;
export function getRequestBudget(config = {}, endpointKey = 'characters-all') {
    const blocking = endpointKey === 'characters-all' && config.blockCharactersAllOnMiss === true;
    return { fastWaitMs: blocking ? 10000 : 1500, bridgeTimeoutMs: blocking ? 11000 : 2000 };
}
