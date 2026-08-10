import React, { useCallback, useEffect, useState } from "react";
import { DeleteScenesDialog } from "stash-ui/dist/src/components/Scenes/DeleteScenesDialog";
import { DeleteSceneMarkersDialog } from "stash-ui/dist/src/components/Scenes/DeleteSceneMarkersDialog";
import * as GQL from "stash-ui/dist/src/core/generated-graphql";
import { getLogger } from "@logtape/logtape";
import { MediaItem } from "./useMediaItems";

const logger = getLogger(["stash-tv", "useDeleteMediaItemDialog"]);

// Stash's own delete confirmation modal doesn't focus either of its buttons, so keyboard-only confirmation (e.g.
// pressing Enter) doesn't work out of the box. We poll for the danger/"Delete" button after the dialog mounts and
// focus it ourselves, since we don't have a mount/transition-complete callback to hook into instead.
function focusDeleteButtonWhenReady() {
  let frame: number;
  const tryFocus = (attempt: number) => {
    const deleteButton = document.querySelector<HTMLButtonElement>(".ModalComponent .btn-danger");
    if (deleteButton) {
      deleteButton.focus();
    } else if (attempt < 30) {
      frame = requestAnimationFrame(() => tryFocus(attempt + 1));
    }
  };
  frame = requestAnimationFrame(() => tryFocus(0));
  return () => cancelAnimationFrame(frame);
}

export function useDeleteMediaItemDialog(mediaItem: MediaItem, onDeleted?: () => void) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);

  useEffect(() => {
    if (!isOpen) return;
    return focusDeleteButtonWhenReady();
  }, [isOpen]);

  const handleClose = useCallback((confirmed: boolean) => {
    setIsOpen(false);
    if (confirmed) onDeleted?.();
  }, [onDeleted]);

  let dialog: JSX.Element | null = null;
  if (isOpen) {
    if (mediaItem.entityType === "scene") {
      dialog = (
        <DeleteScenesDialog
          selected={[mediaItem.entity as unknown as GQL.SlimSceneDataFragment]}
          onClose={handleClose}
        />
      );
    } else if (mediaItem.entityType === "marker") {
      dialog = (
        <DeleteSceneMarkersDialog
          selected={[mediaItem.entity as unknown as GQL.SceneMarkerDataFragment]}
          onClose={handleClose}
        />
      );
    } else {
      mediaItem satisfies never;
      logger.error("useDeleteMediaItemDialog used for unsupported media item type", { mediaItem });
    }
  }

  return { isOpen, open, dialog };
}
