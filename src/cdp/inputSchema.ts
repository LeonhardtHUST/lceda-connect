import { z } from "zod";
import { INPUT_MAX_COORDINATE, INPUT_MAX_TEXT_LENGTH } from "./input.ts";

export const cdpInputActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("click"),
    x: z.number().min(0).max(INPUT_MAX_COORDINATE),
    y: z.number().min(0).max(INPUT_MAX_COORDINATE),
    button: z.enum(["left", "right"]).optional(),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  z.strictObject({
    kind: z.literal("key"),
    key: z.enum([
      "Escape",
      "Enter",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Backspace",
    ]),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(INPUT_MAX_TEXT_LENGTH) }),
]);
