import React from "react"
import * as yup from "yup";
import ActionButtonBase from "../ActionButtonBase";
import { sharedActionButtonSchema } from "../action-button-config";
import { actionButtonIcons } from "../icons";
import type { ActionButtonDefinitionInput } from "./index";
import { useDeleteMediaItemDialog } from "../../../hooks/useDeleteMediaItemDialog";
import { MediaItem } from "../../../hooks/useMediaItems";
import cx from "classnames";

const id = "delete-media-item";

export const buttonDefinition = {
  id,
  title: {
    active: "Delete scene/marker",
    inactive: "Delete scene/marker",
  },
  icon: actionButtonIcons["trash"].states,
  components: {
    button: DeleteMediaItemActionButton,
  },
  configSchema: sharedActionButtonSchema.shape({
    buttonType: yup.string().oneOf([id]).required(),
  }),
} as const satisfies ActionButtonDefinitionInput;

export function DeleteMediaItemActionButton({
    mediaItem
}: {
    mediaItem: MediaItem
}) {
  const { open, dialog } = useDeleteMediaItemDialog(mediaItem);

  return <>
    {dialog}
    <ActionButtonBase
      state="inactive"
      icon={buttonDefinition.icon}
      title={buttonDefinition.title}
      className={cx(buttonDefinition.id, "hide-on-ui-hide")}
      onClick={open}
    />
  </>
}
