import React from "react";
import { EditTagSelectionForm, SlimTag } from "../EditTagSelectionForm";
import "./EditTagsContents.css";

// Shared between the edit-tags action button's popover and MediaSlide's edit-tags modal so their
// contents can't drift out of sync.
export function EditTagsContents(
  {initialTags, pinnedTagIds, primaryTag, save, cancel}: {
    initialTags: SlimTag[],
    pinnedTagIds?: string[],
    primaryTag?: SlimTag | null,
    save: (tags: SlimTag[]) => void,
    cancel: () => void
  }) {
  return <>
    <EditTagSelectionForm
      initialTags={initialTags}
      pinnedTagIds={pinnedTagIds}
      save={save}
      cancel={cancel}
    />
    {primaryTag && <div className="primary-tag-note">
      Marker's primary tag is "{primaryTag.name}".
    </div>}
  </>
}
