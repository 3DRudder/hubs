import { paths } from "../paths";
import { sets } from "../sets";
import { xforms } from "./xforms";
import { addSetsToBindings } from "./utils";

const device = paths.device.drudder;

export const controller3drudderUserBindings = addSetsToBindings({
  [sets.global]: [
    {
        src: {
          x: device(0).axis("leftright"),
          y: device(0).axis("forwardbackward")
        },
        dest: { value: paths.actions.characterAcceleration },
        xform: xforms.compose_vec2
    },
    {
      src: { 
          x: device(0).axis("rotation"), 
          y: device(0).axis("updown") 
        },
      dest: { value: "/var/actions/cameraDelta" },
      xform: xforms.compose_vec2
    },
    {
      src: {
        value: "/var/actions/cameraDelta",
      },
      dest: { value: paths.actions.cameraDelta },
      xform: xforms.copyVec2IfTrue
    },
    {
      src: { value: paths.actions.cameraDelta },
      dest: { value: paths.actions.lobbyCameraDelta },
      xform: xforms.copy
    },
  ],
});