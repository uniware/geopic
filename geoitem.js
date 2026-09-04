/**
 * Copyright (c) Lucian Wischik
 * Copyright (c) 2026 Yao Andrew Zhao
 */
import { FetchError, authFetch, blobToDataUrl, indefinitelyRetryOn429, multipartUpload, postprocessBatchResponse, progressBar, rateLimitedBlobFetch } from './utils.js';
const SCHEMA_VERSION = 5;
/**
 * Converts a number in YYYYMMDD format to a Date object.
 */
export function numToDate(yyyymmdd) {
    const year = Math.floor(yyyymmdd / 10000);
    const month = Math.floor((yyyymmdd % 10000) / 100) - 1; // Month is 1-indexed in YYYYMMDD, but 0-indexed in Date
    const day = yyyymmdd % 100;
    return new Date(Date.UTC(year, month, day));
}
/**
 * Converts Date object to a number in YYYYMMDD format
 */
export function dateToNum(date) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1; // Month is 0-indexed in Date, but 1-indexed in YYYYMMDD
    const day = date.getUTCDate();
    return year * 10000 + month * 100 + day;
}
;
function cacheFilename(path) {
    if (path.length === 0)
        return 'index.json';
    return path.join('_') + '.json';
}
/**
 * Creates a START WorkItem with two requests, one for children and one for cache.
 */
function createStartWorkItem(driveItem, path) {
    return {
        state: 'START',
        requests: [
            {
                id: `children-${driveItem.id}`,
                method: 'GET',
                url: `/me/drive/items/${driveItem.id}/children?$top=200&expand=tags,thumbnails&select=name,id,ctag,etag,size,lastModifiedDateTime,folder,file,location,photo,video`
            },
            {
                id: `cache-${driveItem.id}`,
                method: 'GET',
                url: `/me/drive/special/approot:/${cacheFilename(path)}:/content`
            }
        ],
        responses: {},
        data: {
            schemaVersion: SCHEMA_VERSION,
            id: driveItem.id,
            size: driveItem.size,
            lastModifiedDateTime: driveItem.lastModifiedDateTime,
            cTag: driveItem.cTag,
            eTag: driveItem.eTag,
            immediateChildCount: 0,
            thumbnailsComplete: false,
            folders: [],
            geoItems: [],
        },
        path,
        remainingSubfolders: 0,
        childrenAccumulated: [],
        thumbnailReuseMap: new Map(),
    };
}
/**
 * Creates an END workitem with one request, to upload to cache
 */
function createEndWorkItem(item) {
    return {
        ...item, state: 'END', responses: {}, requests: [
            {
                id: `write-${item.data.id}`,
                method: 'PUT',
                url: `/me/drive/special/approot:/${cacheFilename(item.path)}:/content`,
                // I experimentally found weird bugs and workarounds in the batch API (not the individual API):
                // - If I upload an object with content-type application/json, OneDrive claims success but stores a file of size 0
                // - If I upload a string, or base64-encoded json string, with application/json, OneDrive fails with "Invalid json body"
                // - If I upload a base64-encoded json string as text/plain, OneDrive succeeds and stores the file, and subsequent download has content-type application/json
                body: btoa((Array.from(new TextEncoder().encode(JSON.stringify(item.data)), b => String.fromCharCode(b))).join('')),
                headers: { 'Content-Type': 'text/plain' }
            }
        ]
    };
}
/**
 * Creates a GeoItem
 */
function createGeoItem(driveItem, folderIndex) {
    const d = new Date(driveItem.photo.takenDateTime); // ISO8601 string "2019-08-05T17:42:22Z"
    const date = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); // YYYYMMDD number
    return {
        id: driveItem.id,
        name: driveItem.name.toLowerCase(),
        position: {
            lat: Math.round(driveItem.location.latitude * 100000) / 100000,
            lng: Math.round(driveItem.location.longitude * 100000) / 100000,
        },
        date,
        thumbnailUrl: driveItem.thumbnails[0].small.url,
        folderIndex,
        tags: (driveItem.tags ?? []).map((t) => t.name.toLowerCase()),
    };
}
/**
 * Resolves all thumbnails that haven't yet been resolved, for item's own immediate children
 * (mutating each GeoItem's thumbnailUrl to a data: url in place).
 *
 * To bound how much work an interruption can lose for a folder with a huge number of photos, this
 * processes unresolved items in chunks of CHUNK_SIZE, and after every chunk except the last, hands
 * the still-partial item.data (thumbnailsComplete remains false throughout this function - the
 * caller sets it true only after this function returns) to `checkpoint`, which persists it to the
 * OneDrive cache. A resumed run can then reuse already-resolved thumbnails via the cache-Map
 * fallback in indexImpl instead of re-fetching every thumbnail in the folder from scratch.
 */
async function resolveThumbnails(f, item, checkpoint) {
    const CHUNK_SIZE = 500;
    let lastPct = "";
    function log(count, total, throttled) {
        const pct = `${Math.floor(count / total * 100)}%`;
        if (pct === lastPct)
            return;
        lastPct = pct;
        f(`making thumbnails ${pct}${throttled ? ' (throttled)' : ''}`);
    }
    // A photo whose thumbnail fetch failed for a reason other than 429 (rateLimitedBlobFetch already
    // retries 429s internally) is left alone for RETRY_COOLDOWN_MS before we ask again, rather than
    // either retrying it every single re-index forever, or giving up on it permanently - some of these
    // failures come from Microsoft's own service being unable to process a specific source image today,
    // which could change on their end later, so we don't want to stop checking altogether.
    const RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
    const now = Date.now();
    const unresolved = item.data.geoItems.filter(geo => !geo.thumbnailUrl.startsWith('data:') && (geo.thumbnailFailedAt === undefined || now - geo.thumbnailFailedAt >= RETRY_COOLDOWN_MS));
    for (let start = 0; start < unresolved.length; start += CHUNK_SIZE) {
        const chunk = unresolved.slice(start, start + CHUNK_SIZE);
        const fetches = await rateLimitedBlobFetch((count, _total, throttled) => log(start + count, unresolved.length, throttled), chunk.map(gi => [gi.thumbnailUrl, gi]));
        for (const [blobOrError, geoItem] of fetches) {
            if (blobOrError instanceof Blob) {
                geoItem.thumbnailUrl = await blobToDataUrl(blobOrError);
                geoItem.thumbnailFailedAt = undefined;
            }
            else {
                console.error(`Failed to fetch thumbnail ${geoItem.thumbnailUrl}: ${blobOrError.message}`);
                geoItem.thumbnailFailedAt = now;
            }
        }
        if (start + CHUNK_SIZE < unresolved.length)
            await checkpoint(item.data);
    }
    if (unresolved.length > 0 && lastPct !== '100%')
        log(unresolved.length, unresolved.length, false); // so it appears as "100%"
}
/**
 * Recursive walk of all photos in the Pictures folder, reading and writing a persistent cache in OneDrive.
 * Takes ~30mins for 10 years' worth of photos.
 *
 * Every discovered GeoItem is sent to the callback as it's discovered.
 * Also human-readable progress updates are sent through the callback to.
 */
export async function indexImpl(progressCallback, photosDriveItem) {
    const waiting = new Map();
    const toProcess = [];
    const toFetch = [createStartWorkItem(photosDriveItem, [])];
    // INVARIANT: stats.startTime is set once, when indexing begins, and never mutated;
    // log() reads it each call to derive elapsed wall-clock time for display.
    // INVARIANT: stats.photosSoFar always equals the total count of GeoItems handed to progressCallback
    // so far (maintained solely by the progress() wrapper below, the single choke-point all GeoItem[]
    // batches pass through), so log() can use it together with the existing byte-based completion
    // fraction (bytesFromCache+bytesProcessed)/bytesTotal to extrapolate an estimated photo count remaining.
    // This estimate assumes geo-tagged photos are distributed roughly uniformly across bytes, which is
    // rough but the best available signal since OneDrive only gives us a total byte count upfront, not a photo count.
    // INVARIANT: stats.subtreesDone counts folders (each folder = one subtree, since indexing is a
    // recursive walk) that have fully finished processing, incremented exactly once per folder at the
    // point its WorkItem reaches 'END' state (see below) - whether that folder came from a fresh walk
    // or was reused wholesale from the OneDrive cache.
    const stats = { bytesFromCache: 0, bytesProcessed: 0, bytesTotal: photosDriveItem.size, startTime: Date.now(), photosSoFar: 0, subtreesDone: 0 };
    // Wraps the caller's progressCallback so we can track photosSoFar without duplicating that
    // bookkeeping at each of indexImpl's several call sites that hand over a GeoItem[] batch.
    function progress(update) {
        if (update.length > 0 && typeof update[0] !== 'string')
            stats.photosSoFar += update.length;
        progressCallback(update);
    }
    function log(item) {
        return (s) => {
            const bar = progressBar(stats.bytesFromCache, stats.bytesProcessed, stats.bytesTotal);
            const elapsedSec = Math.floor((Date.now() - stats.startTime) / 1000);
            const elapsed = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`;
            const bytesDone = stats.bytesFromCache + stats.bytesProcessed;
            const remaining = bytesDone > 0
                ? `~${Math.max(0, Math.round(stats.photosSoFar * stats.bytesTotal / bytesDone) - stats.photosSoFar)} left (est.)`
                : 'estimating...';
            const folder = item.path.length === 0 ? ['Pictures'] : item.path;
            progress([`[${bar}] ${elapsed} elapsed, ${stats.photosSoFar} found, ${remaining}, ${stats.subtreesDone} folders done`, folder.join('/'), s || ' ']);
        };
    }
    let lastSuccessfulFetch = performance.now();
    let got429recently = false;
    // We're doing batch requests, so the 429/503/504s come in some of the responses within the batch,
    // not the batch itself. We'll record whether any of them got "429 Too Many Requests",
    // "503 Service Unavailable", or "504 Gateway Timeout" (the last happens when a heavy request,
    // e.g. a large $top combined with expand=thumbnails, takes too long for Graph to generate), and if
    // so then the next fetch wll delay.
    while (true) {
        const item = toProcess.shift();
        if (item && item.state === 'START') {
            // ========================================
            // ========== PROCESS START ITEM ==========
            // ========================================
            const cacheResult = item.responses[`cache-${item.data.id}`];
            const childrenResult = item.responses[`children-${item.data.id}`];
            if (childrenResult.status === 429 || childrenResult.status === 503 || childrenResult.status === 504) {
                toFetch.unshift({ ...item, responses: {} });
                const secondsSinceSuccess = Math.round((performance.now() - lastSuccessfulFetch) / 1000);
                log(item)(`throttled for ${secondsSinceSuccess}s`);
                got429recently = true;
                continue;
            }
            lastSuccessfulFetch = performance.now();
            if (childrenResult.body.error) {
                throw new FetchError(`${childrenResult.request.url}[child]`, new Response(childrenResult.body, { status: childrenResult.status }), JSON.stringify(childrenResult.body));
            }
            // cacheResult is only present on page 1 (a continuation page's requests contain only the
            // next children-link, not a repeat cache request) - so the wholesale-reuse shortcut and the
            // stale-cache thumbnail-reuse Map are only ever considered/built once, on that first page.
            if (cacheResult !== undefined) {
                if (cacheResult.status === 200 && cacheResult.body.size === item.data.size && cacheResult.body.schemaVersion === SCHEMA_VERSION && cacheResult.body.thumbnailsComplete !== false) {
                    stats.bytesFromCache += item.data.size;
                    toProcess.unshift({ ...item, data: cacheResult.body, state: 'END', requests: [], responses: {} });
                    progress(cacheResult.body.geoItems);
                    continue;
                }
                if (cacheResult.status === 200) {
                    const cacheGeoData = cacheResult.body;
                    for (const cachedItem of cacheGeoData.geoItems.splice(0, cacheGeoData.immediateChildCount)) {
                        item.thumbnailReuseMap.set(cachedItem.id, cachedItem.thumbnailUrl);
                    }
                }
            }
            // Accumulate this page, and if Graph says there's another page, fetch only that (not
            // cache again) before doing anything else with this folder's children.
            item.childrenAccumulated.push(...childrenResult.body.value);
            const nextLink = childrenResult.body['@odata.nextLink'];
            if (nextLink) {
                const nextUrl = nextLink.replace('https://graph.microsoft.com/v1.0', '');
                toFetch.push({ ...item, responses: {}, requests: [{ id: `children-${item.data.id}`, method: 'GET', url: nextUrl }] });
                log(item)(`listing children: ${item.childrenAccumulated.length} so far`);
                continue;
            }
            // Kick off subfolders, and gather immediate children (but resolving their thumbnails is deferred until our finish-action)
            for (const child of item.childrenAccumulated) {
                if (child.folder) {
                    toFetch.push(createStartWorkItem(child, [...item.path, child.name]));
                    item.remainingSubfolders++;
                }
                else if (child.file) {
                    stats.bytesProcessed += child.size;
                    if (child.location && child.location.latitude && child.location.longitude && child.thumbnails?.at(0)?.small?.url && child.photo?.takenDateTime) {
                        const folderIndex = 0; // invariant: item.folders[0] will be folder of that workitem
                        const childItem = createGeoItem(child, folderIndex);
                        if (item.thumbnailReuseMap.has(childItem.id))
                            childItem.thumbnailUrl = item.thumbnailReuseMap.get(childItem.id);
                        item.data.geoItems.push(childItem);
                    }
                }
            }
            item.data.immediateChildCount = item.data.geoItems.length;
            if (item.data.immediateChildCount > 0)
                item.data.folders.push(item.path.join('/').toLowerCase());
            // Book-keeping: either our finish-action can be done now, or is done by our final subfolder.
            if (item.remainingSubfolders === 0) {
                await resolveThumbnails(log(item), item, async (data) => {
                    await multipartUpload((count, total) => log(item)(`checkpoint ${Math.floor(count / total * 100)}%`), cacheFilename(item.path), JSON.stringify(data));
                });
                // Not unconditionally true: a cooldown-skipped or still-failing item leaves a non-data:
                // thumbnailUrl behind, and marking this folder complete anyway would let the wholesale
                // cache-hit shortcut adopt it forever, since that path never calls resolveThumbnails again.
                item.data.thumbnailsComplete = item.data.geoItems.every(gi => gi.thumbnailUrl.startsWith('data:'));
                progress(item.data.geoItems);
                toFetch.unshift(createEndWorkItem(item));
            }
            else {
                toFetch.sort((a, b) => cacheFilename(a.path).localeCompare(cacheFilename(b.path))); // alphabetical order to finish off subtrees quicker
                waiting.set(cacheFilename(item.path), item);
            }
            // Refresh the visible progress line for this folder even when neither branch above happened
            // to call log() itself (e.g. a folder with subfolders just gets queued into 'waiting' with no
            // log() call at all; a leaf folder with zero unresolved thumbnails skips resolveThumbnails'
            // internal log() call too) - otherwise $batch keeps succeeding while the display looks frozen.
            log(item)();
        }
        else if (item && item.state === 'END') {
            // ========================================
            // ========== PROCESS END ITEM ==========
            // ========================================
            stats.subtreesDone++; // this folder's WorkItem has now reached 'END': its subtree is fully done
            log(item)();
            if (item.path.length === 0)
                return item.data; // Finished the root folder!
            // Book-keeping: if our parent's finish-action was left to us, then we'll do it now.
            // We'll have to adjust all our folder indexes. Invariant: a child's folders[] are
            // are all different from those of its parent (hence no need to dedupe).
            const parentName = cacheFilename(item.path.slice(0, -1));
            const parent = waiting.get(parentName);
            try {
                const adjustedItems = item.data.geoItems.map(gi => ({ ...gi, folderIndex: gi.folderIndex + parent.data.folders.length }));
                parent.data.geoItems = parent.data.geoItems.concat(adjustedItems);
                parent.data.folders = parent.data.folders.concat(item.data.folders);
            }
            catch (e) {
                console.error(String(e));
                debugger;
            }
            parent.remainingSubfolders--;
            if (parent.remainingSubfolders === 0) {
                await resolveThumbnails(log(parent), parent, async (data) => {
                    await multipartUpload((count, total) => log(parent)(`checkpoint ${Math.floor(count / total * 100)}%`), cacheFilename(parent.path), JSON.stringify(data));
                });
                // See the matching comment in the leaf-folder branch above: must reflect reality, not
                // just "resolveThumbnails ran", or a cooldown-skipped item gets stuck forever.
                parent.data.thumbnailsComplete = parent.data.geoItems.every(gi => gi.thumbnailUrl.startsWith('data:'));
                progress(parent.data.geoItems.slice(0, parent.data.immediateChildCount));
                waiting.delete(parentName);
                const data = JSON.stringify(parent.data);
                if (data.length < 4 * 1024 * 1024) {
                    toFetch.unshift(createEndWorkItem(parent));
                }
                else {
                    const logpct = (count, total) => log(parent)(`upload ${Math.floor(count / total * 100)}%`);
                    await multipartUpload(logpct, cacheFilename(parent.path), data);
                    toProcess.unshift({ ...parent, state: 'END', responses: {}, requests: [] });
                }
            }
        }
        else {
            // ========================================
            // ========== FETCH =======================
            // ========================================
            const thisFetch = [];
            const requests = [];
            // batch API limit is 20 requests. Each of our items in toFetch has 1 or 2 requests.
            while (toFetch.length > 0 && requests.length < 18) {
                const item = toFetch.shift();
                requests.push(...item.requests);
                thisFetch.push(item);
            }
            if (got429recently)
                await new Promise(resolve => setTimeout(resolve, 10000));
            got429recently = false;
            const url = 'https://graph.microsoft.com/v1.0/$batch';
            const body = JSON.stringify({ requests });
            // A successful connection can still fail while its (often large) response body is being
            // read/parsed, e.g. a network drop mid-download - a different failure point from the one
            // myFetch already retries (which only covers the connection attempt itself). We retry the
            // whole round-trip indefinitely in that case, but let a genuine HTTP-level error (a FetchError,
            // meaning the connection succeeded and Graph responded with a real non-ok status) propagate.
            let batchResult;
            while (true) {
                const batchResponse = await authFetch(url, indefinitelyRetryOn429, {
                    'method': 'POST',
                    'headers': { 'Content-Type': 'application/json' },
                    'body': body
                });
                try {
                    if (!batchResponse.ok)
                        throw new FetchError(`${url}[POST:batch(${requests.length})]`, batchResponse, await batchResponse.text());
                    batchResult = await batchResponse.json();
                    break;
                }
                catch (e) {
                    if (e instanceof FetchError)
                        throw e;
                    console.warn(`Batch response failed to read/parse (${String(e)}): will retry...`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
            }
            await postprocessBatchResponse(batchResult, indefinitelyRetryOn429);
            for (const r of batchResult.responses) {
                const item = thisFetch.find(item => item.requests.some(req => req.id === r.id));
                const requests = item.requests.find(req => req.id === r.id);
                r.request = requests;
                item.responses[r.id] = r;
            }
            toProcess.push(...thisFetch);
        }
    }
}
/**
 * Given a longitude, normalizes it to the range [-180, 180).
 * Used for instance if you want to calculate "lng1 + width" which might cross the antimeridian.
 */
function lngWrap(lng) {
    return (lng + 180 + 360) % 360 - 180;
}
/**
 * Returns the westmost of two longitudes -- the one that can be reached
 * from the other by travelling less than 180 degrees westwards.
 * If the two points are exactly opposite, the choice is arbitrary.
 */
function westmost(lng1, lng2) {
    // use +720 instead of +360 to allow for mild non-normalization of input values (so we still get positive distance)
    return (lng1 - lng2 + 720) % 360 < 180 ? lng2 : lng1;
}
/**
 * Returns the eastmost of two longitudes -- the one that can be reached
 * from the other by travelling less than 180 degrees eastwards.
 * If the two points are exactly opposite, the choice is arbitrary.
 */
function eastmost(lng1, lng2) {
    // use +720 instead of +360 to allow for mild non-normalization of input values
    return (lng1 - lng2 + 720) % 360 < 180 ? lng1 : lng2;
}
/**
 * This function takes a map viewport, represented by (1) its lat/lng bounds, (2) its pixel dimensions.
 * It splits this into "clusters" (tiles), each cluster being an approximately 60x60 square of pixels (give or take;
 * if the pixelWidth/Height don't neatly divide into 60 then we'll use however many clusters best fit).
 * It iterates through all the items (it's fast! at about 50k points in one ms) and figures out which cluster each item
 * belongs to.
 *
 * It returns an array of clusters that contain at least one item. Each returned cluster is represented by
 * (1) a list of up to 20 items in that cluster, (2) the total count of items in that cluster.
 * The tiling is "stable": when the user pans the map, cluster boundaries remain fixed.
 */
export function asClusters(sw, ne, pixelWidth, geoData, filter) {
    const TILE_SIZE_PX = 60;
    const MAX_ITEMS_PER_TILE = 40;
    const tileSize = ((ne.lng - sw.lng + 360) % 360 || 360) / Math.max(1, Math.round(pixelWidth / TILE_SIZE_PX));
    const swSnap = { lat: Math.floor(sw.lat / tileSize) * tileSize, lng: lngWrap((Math.floor(sw.lng / tileSize) * tileSize)) };
    const realWidth = (ne.lng - sw.lng + 360) % 360 || 360; // the ||360 is to handle -180 to +180, which is width of 360 not 0
    const snapWidth = (ne.lng - swSnap.lng + 360) % 360; // this might have snapped westwards but gone right past ne.lng!
    const numTilesX = Math.ceil((snapWidth < realWidth ? snapWidth + 360 : snapWidth) / tileSize);
    const numTilesY = Math.ceil((ne.lat - swSnap.lat) / tileSize);
    const tiles = [];
    for (let y = 0; y < numTilesY; y++) {
        for (let x = 0; x < numTilesX; x++) {
            tiles.push({
                somePassFilterItems: [],
                totalPassFilterItems: 0,
                oneFailFilterItem: undefined,
                bounds: {
                    sw: { lat: swSnap.lat + y * tileSize, lng: lngWrap(swSnap.lng + x * tileSize) },
                    ne: { lat: swSnap.lat + (y + 1) * tileSize, lng: lngWrap(swSnap.lng + (x + 1) * tileSize) }
                },
                center: { lat: swSnap.lat + (y + 0.5) * tileSize, lng: lngWrap(swSnap.lng + (x + 0.5) * tileSize) }
            });
        }
    }
    const filterText = filter.text ? filter.text.toLowerCase() : undefined;
    const filterFolders = filterText === undefined ? new Set() :
        new Set(geoData.folders.map((f, i) => f.includes(filterText) ? i : -1).filter(i => i !== -1));
    const dateCounts = new Map();
    // CARE! Following loop is hot; goal is 50,000 items in 5ms, but we're currently at 10ms
    for (const item of geoData.geoItems) {
        let tally = dateCounts.get(item.date); // PERF: this lookup costs 2ms
        if (!tally) {
            tally = { inBounds: { inFilter: 0, outFilter: 0 }, outBounds: { inFilter: 0, outFilter: 0 } };
            dateCounts.set(item.date, tally);
        }
        const x = Math.floor(((item.position.lng - swSnap.lng + 360) % 360) / tileSize);
        const y = Math.floor((item.position.lat - swSnap.lat) / tileSize);
        const inBounds = (x >= 0 && x < numTilesX && y >= 0 && y < numTilesY);
        const inFilter = filterText !== undefined && (item.name.includes(filterText) || filterFolders.has(item.folderIndex) || item.tags.some(tag => tag.includes(filterText)));
        const inDateRange = filter.dateRange === undefined || (item.date >= filter.dateRange.start && item.date < filter.dateRange.end);
        tally[inBounds ? 'inBounds' : 'outBounds'][inFilter ? 'inFilter' : 'outFilter']++;
        if (!inBounds)
            continue;
        const tile = tiles[y * numTilesX + x];
        if ((filter.text && !inFilter) || !inDateRange) {
            if (tile.oneFailFilterItem === undefined)
                tile.oneFailFilterItem = item;
            continue;
        }
        if (tile.somePassFilterItems.length < MAX_ITEMS_PER_TILE)
            tile.somePassFilterItems.push(item); // PERF: this push costs 1ms
        tile.totalPassFilterItems++;
    }
    return [tiles.filter(t => t.somePassFilterItems.length > 0 || t.oneFailFilterItem !== undefined), { dateCounts }];
}
export function boundsForDateRange(geoData, dateRange) {
    let r = undefined;
    for (const item of geoData.geoItems) {
        const inDateRange = dateRange === undefined || (item.date >= dateRange.start && item.date < dateRange.end);
        if (!inDateRange)
            continue;
        if (r === undefined) {
            r = { sw: structuredClone(item.position), ne: structuredClone(item.position) };
        }
        else {
            r.sw.lat = Math.min(r.sw.lat, item.position.lat);
            r.sw.lng = westmost(r.sw.lng, item.position.lng);
            r.ne.lat = Math.max(r.ne.lat, item.position.lat);
            r.ne.lng = eastmost(r.ne.lng, item.position.lng);
        }
    }
    return r;
}
//# sourceMappingURL=geoitem.js.map