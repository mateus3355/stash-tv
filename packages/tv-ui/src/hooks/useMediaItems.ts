import * as GQL from "stash-ui/dist/src/core/generated-graphql";
import { useMediaItemFilters } from './useMediaItemFilters';
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getMediaItemIdForVideoJsPlayer } from "../helpers";
import { useTvConfig } from "../store/tvConfig";
import hashObject from 'object-hash';
import { getLogger } from "@logtape/logtape";
import { getFunctionFromString } from "../helpers/getFunctionFromString";
import { ConfigurationContext } from "stash-ui/dist/src/hooks/Config";
import { create } from "zustand";

export type MediaItem = {
  id: string;
} & (
  {
    entityType: "scene";
    entity: GQL.SceneDataFragment;
  } |
  {
    entityType: "marker";
    entity: GQL.FindSceneMarkersForTvQuery["findSceneMarkers"]["scene_markers"][number] & {
      duration: number;
    }
  }
)

declare global {
  interface Window {
    mediaItems?: MediaItem[],
    modifiedMediaItems?: MediaItem[],
  }
}

export const defaultMarkerLength = 20;

// useMediaItems() is called from multiple independent components (FeedPage, SettingsTab, VideoScroller), each
// of which needs to see the same accumulated list -- a per-hook-instance-local accumulator would let those
// diverge (e.g. VideoScroller's own copy correctly losing an item on delete while FeedPage's separate copy
// keeps growing untouched), which is exactly what happened when this was a useRef/useState pair local to each
// call site. Keeping it in a module-level store instead means every instance reads and writes the same state.
//
// Pagination itself is also handled entirely here rather than via Apollo's own field-level merge/cache
// accumulation (previously done with a custom keyArgs/merge policy in getApolloClient.ts): that accumulated
// cache value proved unreliable under mutation races (e.g. deleting a scene while another scene's watch-time/
// view-count mutation -- fired automatically just from normal scrolling -- is still in flight) in ways that
// were never fully pinned down despite multiple attempted fixes at the Apollo cache layer, occasionally
// causing the query's own reported item count to silently stop growing even though further pages kept being
// requested. loadMoreMediaItems() now reads each page directly from fetchMore()'s own returned promise instead
// of from the query's `data`, and getApolloClient.ts's findScenes/findSceneMarkers fields are back to Apollo's
// default (unmerged, keyed by all variables including page) policy -- each page fetch is now a fully
// independent, one-shot operation whose result we merge into our own store ourselves.
type MediaItemsAccumulatorState = {
  items: Map<string, MediaItem>;
  // How many pages *beyond* the always-loaded first page have been successfully fetched for the current
  // filter, so loadMoreMediaItems() knows which page to fetch next. This only advances on a completed
  // fetchMore() response, never merely on the number of times loadMoreMediaItems() was called or on
  // items.size (both of those are, respectively, prone to duplicate calls and driven down by deletions).
  pagesLoadedBeyondFirst: number;
  fetchMoreInFlight: boolean;
}
const useMediaItemsAccumulatorStore = create<MediaItemsAccumulatorState>(() => ({
  items: new Map(),
  pagesLoadedBeyondFirst: 0,
  fetchMoreInFlight: false,
}))

function mergeMediaItemsIntoStore(newPageItems: MediaItem[]) {
  const state = useMediaItemsAccumulatorStore.getState()
  let changed = false
  const newItems = new Map(state.items)
  for (const item of newPageItems) {
    if (newItems.get(item.id) !== item) {
      newItems.set(item.id, item)
      changed = true
    }
  }
  if (changed) {
    useMediaItemsAccumulatorStore.setState({ items: newItems })
  }
}

export function useMediaItems() {
  const logger = getLogger(["stash-tv", "useMediaItems"]);
  const { lastLoadedCurrentMediaItemFilter } = useMediaItemFilters()
  const {
    maxMedia,
    scenePreviewOnly,
    markerPreviewOnly,
    pageSize: mediaItemsPerPage,
    showDevOptions,
    mediaItemsModifierFunction
  } = useTvConfig()
  const { configuration: stashConfig } = useContext(ConfigurationContext)
  const previewOnly = (lastLoadedCurrentMediaItemFilter?.entityType === "scene" && scenePreviewOnly)
    || (lastLoadedCurrentMediaItemFilter?.entityType === "marker" && markerPreviewOnly)

  const hydratedMediaItemsModifierFunction = getFunctionFromString(mediaItemsModifierFunction)

  const [ neverLoaded, setNeverLoaded ] = useState(true)

  function mapMarker(marker: GQL.FindSceneMarkersForTvQuery["findSceneMarkers"]["scene_markers"][number]): MediaItem {
    return {
      id: `marker:${marker.id}`,
      entityType: "marker" as const,
      entity: {
        ...marker,
        get duration() {
          const endTime = marker.end_seconds ?? Math.min(marker.seconds + defaultMarkerLength, marker.scene.files[0].duration);
          return endTime - marker.seconds;
        }
      }
    }
  }
  function markerIsValid(marker: GQL.FindSceneMarkersForTvQuery["findSceneMarkers"]["scene_markers"][number]): boolean {
    if (marker.seconds > marker.scene.files[0].duration) {
      logger.warn(`Marker with ID ${marker.id} has start time (${marker.seconds}s) greater than scene duration (${marker.scene.files[0].duration}s). This marker will be skipped.`, {marker})
      return false
    }
    return true
  }

  let response
  let apolloMediaItems: MediaItem[]
  let loadMoreMediaItemsImpl: () => Promise<void>
  if (!lastLoadedCurrentMediaItemFilter || lastLoadedCurrentMediaItemFilter.entityType === "scene") {
    const scenesResponse = GQL.useFindFullScenesQuery({
      variables: {
        filter: {
          ...lastLoadedCurrentMediaItemFilter?.generalFilter,
          // We manage pagination ourselves and so override whatever the saved filter had
          page: 1,
          per_page: mediaItemsPerPage,
        },
        scene_filter: lastLoadedCurrentMediaItemFilter?.entityFilter
      },
      skip: !lastLoadedCurrentMediaItemFilter,
    })
    apolloMediaItems = useMemo(
      () => scenesResponse.data?.findScenes.scenes.map(scene => ({
        id: `scene:${scene.id}`,
        entityType: "scene" as const,
        entity: scene,
      })) || [],
      [scenesResponse.data?.findScenes.scenes]
    )
    response = scenesResponse

    const { fetchMore } = scenesResponse
    const generalFilter = lastLoadedCurrentMediaItemFilter?.generalFilter
    const entityFilter = lastLoadedCurrentMediaItemFilter?.entityFilter
    loadMoreMediaItemsImpl = async () => {
      const state = useMediaItemsAccumulatorStore.getState()
      if (state.fetchMoreInFlight) return;
      const nextPage = state.pagesLoadedBeyondFirst + 2
      logger.debug("Fetch next media page: {*}", {nextPage})
      useMediaItemsAccumulatorStore.setState({ fetchMoreInFlight: true })
      try {
        const result = await fetchMore({
          variables: {
            filter: { ...generalFilter, page: nextPage, per_page: mediaItemsPerPage },
            scene_filter: entityFilter,
          }
        })
        const newPageItems: MediaItem[] = (result.data?.findScenes.scenes ?? []).map(scene => ({
          id: `scene:${scene.id}`,
          entityType: "scene" as const,
          entity: scene,
        }))
        mergeMediaItemsIntoStore(newPageItems)
        useMediaItemsAccumulatorStore.setState(s => ({ pagesLoadedBeyondFirst: s.pagesLoadedBeyondFirst + 1, fetchMoreInFlight: false }))
      } catch (error) {
        logger.error("Failed to fetch next media page", { error })
        useMediaItemsAccumulatorStore.setState({ fetchMoreInFlight: false })
      }
    }

  } else if (lastLoadedCurrentMediaItemFilter.entityType === "marker") {
    const markersResponse = GQL.useFindSceneMarkersForTvQuery({
      variables: {
        filter: {
          ...lastLoadedCurrentMediaItemFilter.generalFilter,
          // We manage pagination ourselves and so override whatever the saved filter had
          page: 1,
          per_page: mediaItemsPerPage,
        },
        scene_marker_filter: lastLoadedCurrentMediaItemFilter.entityFilter
      },
    })

    apolloMediaItems = useMemo(
      () => markersResponse.data?.findSceneMarkers.scene_markers
        .filter(markerIsValid)
        .map(mapMarker)
        || [],
      [markersResponse.data?.findSceneMarkers.scene_markers]
    )
    response = markersResponse

    const { fetchMore } = markersResponse
    const generalFilter = lastLoadedCurrentMediaItemFilter.generalFilter
    const entityFilter = lastLoadedCurrentMediaItemFilter.entityFilter
    loadMoreMediaItemsImpl = async () => {
      const state = useMediaItemsAccumulatorStore.getState()
      if (state.fetchMoreInFlight) return;
      const nextPage = state.pagesLoadedBeyondFirst + 2
      logger.debug("Fetch next media page: {*}", {nextPage})
      useMediaItemsAccumulatorStore.setState({ fetchMoreInFlight: true })
      try {
        const result = await fetchMore({
          variables: {
            filter: { ...generalFilter, page: nextPage, per_page: mediaItemsPerPage },
            scene_marker_filter: entityFilter,
          }
        })
        const newPageItems: MediaItem[] = (result.data?.findSceneMarkers.scene_markers ?? [])
          .filter(markerIsValid)
          .map(mapMarker)
        mergeMediaItemsIntoStore(newPageItems)
        useMediaItemsAccumulatorStore.setState(s => ({ pagesLoadedBeyondFirst: s.pagesLoadedBeyondFirst + 1, fetchMoreInFlight: false }))
      } catch (error) {
        logger.error("Failed to fetch next media page", { error })
        useMediaItemsAccumulatorStore.setState({ fetchMoreInFlight: false })
      }
    }
  } else {
    logger.debug("lastLoadedCurrentMediaItemFilter:", lastLoadedCurrentMediaItemFilter)
    throw new Error("Unsupported media item filter entity type")
  }
  // apolloMediaItems here only ever reflects page 1 (see the two branches above) -- it's kept as an active,
  // watched query for reactivity (e.g. picking up tag/metadata changes on currently-visible items) and as the
  // initial page of data, not for pagination.
  const accumulatorItems = useMediaItemsAccumulatorStore(s => s.items)

  useEffect(() => {
    logger.debug(`lastLoadedCurrentMediaItemFilter changed to "${lastLoadedCurrentMediaItemFilter?.savedFilter?.name}", resetting media items`)
    useMediaItemsAccumulatorStore.setState({ items: new Map(), pagesLoadedBeyondFirst: 0, fetchMoreInFlight: false })
  }, [lastLoadedCurrentMediaItemFilter])

  useEffect(() => {
    if (apolloMediaItems.length === 0) return;
    mergeMediaItemsIntoStore(apolloMediaItems)
  }, [apolloMediaItems])

  const removeMediaItem = useCallback((id: string) => {
    const state = useMediaItemsAccumulatorStore.getState()
    if (!state.items.has(id)) return;
    const newItems = new Map(state.items)
    newItems.delete(id)
    useMediaItemsAccumulatorStore.setState({ items: newItems })
  }, [])

  let mediaItems: MediaItem[] = useMemo(
    () => Array.from(accumulatorItems.values()),
    [accumulatorItems]
  )


  useEffect(() => {
    if (showDevOptions) {
      window.mediaItems = [...mediaItems]
    } else {
      delete window.mediaItems
    }
  }, [mediaItems])

  if (showDevOptions && typeof hydratedMediaItemsModifierFunction === "function") {
    try {
      const modifiedMediaItems = hydratedMediaItemsModifierFunction(mediaItems)
      if (Array.isArray(modifiedMediaItems)) {
        mediaItems = modifiedMediaItems
      }
    } catch(error) {
      logger.error(`Media items modifier function threw an error`, {error})
    }
  }

  useEffect(() => {
    if (showDevOptions) {
      window.modifiedMediaItems = [...mediaItems]
    } else {
      delete window.modifiedMediaItems
    }
  }, [mediaItems])

  const {
    error: mediaItemsError,
    loading: mediaItemsLoading,
  } = response

  useEffect(() => {
    mediaItems.length && setNeverLoaded(false)
  }, [mediaItems.length])

  // Stash doesn't provide the lengths of preview videos so we track that ourselves by saving the video's duration as
  // soon as its metadata loads
  const [previewLengths, setPreviewLengths] = useState<{[sceneId: string]: number}>({})
  useEffect(() => {
    if (!previewOnly) return;
    const saveDurationOnceMetadataLoaded = (event: Event) => {
      if (!(event?.target instanceof HTMLVideoElement)) return;
      const videoElm = event.target
      try {
        const mediaItemId = getMediaItemIdForVideoJsPlayer(videoElm);
        logger.debug("Saving preview length for media item {*}", {mediaItemId, duration: videoElm.duration})
        setPreviewLengths(
          prev => ({
            ...prev,
            [mediaItemId]: videoElm.duration
          })
        )
      } catch (error) {
        console.warn("Failed to get media item ID for video element", error)
      }
    }
    window.addEventListener('loadedmetadata', saveDurationOnceMetadataLoaded, {capture: true});
    return () => {
      window.removeEventListener('loadedmetadata', saveDurationOnceMetadataLoaded, {capture: true});
    }
  }, [previewOnly])

  // Modifying the ScenePlayer to handle playing only a scene's preview would be a lot of work and
  // would involve a lot of complexity to maintain since it would break many existing assumptions.
  // Instead we take the sightly hacky but much simpler approach of modifying the scene data itself
  // so that ScenePlayer thinks it's just a normal scene but the only available stream is the preview.
  function makeMediaItemPreviewOnly(mediaItem: MediaItem): MediaItem {
    let previewUrl
    if (mediaItem.entityType === "scene") {
      previewUrl = mediaItem.entity.paths.preview
    } else if (mediaItem.entityType === "marker") {
      previewUrl = mediaItem.entity.stream
    } else {
      mediaItem satisfies never
      throw new Error("Unsupported media item entity type")
    }
    if (!previewUrl) {
      console.warn(`Media item ${mediaItem.id} has no preview`)
      return mediaItem
    }
    const scene = 'scene' in mediaItem.entity ? mediaItem.entity.scene : mediaItem.entity
    let estimatedDuration: number
    if (mediaItem.entityType === "marker") {
      estimatedDuration = Math.min(defaultMarkerLength, scene.files[0].duration)
    } else {
      const segmentDuration = stashConfig?.general.previewSegmentDuration ?? 0.75
      const segmentCount = stashConfig?.general.previewSegments ?? 12
      estimatedDuration = Math.min((segmentDuration * segmentCount), scene.files[0].duration)
    }
    mediaItem.id in previewLengths && logger.debug("Duration cached for media item {*}", {mediaItemId: mediaItem.id, duration: previewLengths[mediaItem.id]})
    const duration = mediaItem.id in previewLengths
      ? previewLengths[mediaItem.id]
      // Estimate the video duration if we don't know it yet
      : estimatedDuration
    const updatedScene = {
      ...scene,
      sceneStreams: [
        {
          "url": previewUrl,
          "mime_type": "video/mp4",
          "label": "Direct stream",
          "__typename": "SceneStreamEndpoint" as const
        }
      ],
      files: [
        {
          ...scene.files[0],
          duration,
        },
        ...scene.files.slice(1)
      ],
      resume_time: null,
      captions: null,
      scene_markers: [],
    }

    if (mediaItem.entityType === "scene") {
      return {
        ...mediaItem,
        entity: updatedScene
      }
    } else if (mediaItem.entityType === "marker") {
      return {
        ...mediaItem,
        entity: {
          ...mediaItem.entity,
          scene: updatedScene
        }
      }
    } else {
      mediaItem satisfies never
      return mediaItem
    }
  }


  mediaItems = useMemo(
    () => {
      let modifiedMediaItems = mediaItems
      if (typeof maxMedia === "number") {
        modifiedMediaItems = modifiedMediaItems.slice(0, maxMedia)
      }
      if (previewOnly) {
        modifiedMediaItems = modifiedMediaItems.map(makeMediaItemPreviewOnly)
      }
      return modifiedMediaItems
    },
    [mediaItems, previewOnly, maxMedia, hashObject(previewLengths)]
  )

  return {
    mediaItems,
    removeMediaItem,
    loadMoreMediaItems: loadMoreMediaItemsImpl,
    mediaItemsError,
    mediaItemsLoading,
    mediaItemsNeverLoaded: neverLoaded,
    waitingForMediaItemsFilter: !lastLoadedCurrentMediaItemFilter,
  }
}
