import { ApolloClient, InMemoryCache } from "@apollo/client";
import { getClient } from "stash-ui/dist/src/core/StashService";

export function getApolloClient() {
    const originalClient = getClient()
    // The "config" property on the cache is not officially documented or typed but it exists in practice.
    const originalCacheConfig = 'config' in originalClient.cache ? originalClient.cache.config as NonNullable<ConstructorParameters<typeof InMemoryCache>[0]> : {}
    const newCache = new InMemoryCache({
        ...originalCacheConfig,
    });
    const newClient = new ApolloClient({
        link: originalClient.link,
        cache: newCache,
    });
    return newClient;
}
