import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { withStatics } from "@/util/schema"

const serialIdSchema = Schema.String.pipe(Schema.brand("SerialID"))

export type SerialID = typeof serialIdSchema.Type

export const SerialID = serialIdSchema.pipe(
  withStatics((schema: typeof serialIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("serial", id)),
    zod: Identifier.schema("serial").pipe(z.custom<SerialID>()),
  })),
)
