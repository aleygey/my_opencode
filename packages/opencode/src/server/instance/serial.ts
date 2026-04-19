import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import type { UpgradeWebSocket } from "hono/ws"
import z from "zod"
import { Serial } from "@/serial"
import { SerialID } from "@/serial/schema"
import { NotFoundError } from "../../storage/db"
import { errors } from "../error"

export function SerialRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List serial sessions",
        description: "Get a list of all open serial sessions managed by OpenCode.",
        operationId: "serial.list",
        responses: {
          200: {
            description: "List of sessions",
            content: { "application/json": { schema: resolver(Serial.Info.array()) } },
          },
        },
      }),
      async (c) => c.json(await Serial.list()),
    )
    .get(
      "/ports",
      describeRoute({
        summary: "List host serial ports",
        description: "Enumerate physical serial devices attached to the host.",
        operationId: "serial.ports",
        responses: {
          200: {
            description: "Available ports",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      path: z.string(),
                      manufacturer: z.string().optional(),
                      serialNumber: z.string().optional(),
                      pnpId: z.string().optional(),
                      vendorId: z.string().optional(),
                      productId: z.string().optional(),
                    })
                    .array(),
                ),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Serial.listPorts()),
    )
    .post(
      "/",
      describeRoute({
        summary: "Create serial session",
        description: "Open a new serial session on the given device path.",
        operationId: "serial.create",
        responses: {
          200: {
            description: "Created session",
            content: { "application/json": { schema: resolver(Serial.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("json", Serial.CreateInput),
      async (c) => c.json(await Serial.create(c.req.valid("json"))),
    )
    .get(
      "/:serialID",
      describeRoute({
        summary: "Get serial session",
        description: "Retrieve detailed information about a specific serial session.",
        operationId: "serial.get",
        responses: {
          200: {
            description: "Session info",
            content: { "application/json": { schema: resolver(Serial.Info) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ serialID: SerialID.zod })),
      async (c) => {
        const info = await Serial.get(c.req.valid("param").serialID)
        if (!info) throw new NotFoundError({ message: "Session not found" })
        return c.json(info)
      },
    )
    .put(
      "/:serialID",
      describeRoute({
        summary: "Update serial session",
        description: "Update properties (e.g. title) of an existing serial session.",
        operationId: "serial.update",
        responses: {
          200: {
            description: "Updated session",
            content: { "application/json": { schema: resolver(Serial.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ serialID: SerialID.zod })),
      validator("json", Serial.UpdateInput),
      async (c) => c.json(await Serial.update(c.req.valid("param").serialID, c.req.valid("json"))),
    )
    .delete(
      "/:serialID",
      describeRoute({
        summary: "Remove serial session",
        description: "Close and remove a specific serial session.",
        operationId: "serial.remove",
        responses: {
          200: {
            description: "Session removed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ serialID: SerialID.zod })),
      async (c) => {
        await Serial.remove(c.req.valid("param").serialID)
        return c.json(true)
      },
    )
    .post(
      "/:serialID/write",
      describeRoute({
        summary: "Write to a serial session",
        description: "Send a string payload down the serial session.",
        operationId: "serial.write",
        responses: {
          200: {
            description: "Bytes written",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ serialID: SerialID.zod })),
      validator("json", z.object({ data: z.string() })),
      async (c) => {
        await Serial.write(c.req.valid("param").serialID, c.req.valid("json").data)
        return c.json(true)
      },
    )
    .get(
      "/:serialID/connect",
      describeRoute({
        summary: "Connect to serial session",
        description:
          "Establish a WebSocket connection to stream serial data in real-time. Supports cursor-based resume.",
        operationId: "serial.connect",
        responses: {
          200: {
            description: "Connected session",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ serialID: SerialID.zod })),
      upgradeWebSocket(async (c) => {
        const id = SerialID.zod.parse(c.req.param("serialID"))
        const cursor = (() => {
          const value = c.req.query("cursor")
          if (!value) return
          const parsed = Number(value)
          if (!Number.isSafeInteger(parsed) || parsed < -1) return
          return parsed
        })()
        let handler: Awaited<ReturnType<typeof Serial.connect>>
        if (!(await Serial.get(id))) throw new Error("Session not found")

        type Socket = {
          readyState: number
          send: (data: string | Uint8Array | ArrayBuffer) => void
          close: (code?: number, reason?: string) => void
        }

        const isSocket = (value: unknown): value is Socket => {
          if (!value || typeof value !== "object") return false
          if (!("readyState" in value)) return false
          if (!("send" in value) || typeof (value as { send?: unknown }).send !== "function") return false
          if (!("close" in value) || typeof (value as { close?: unknown }).close !== "function") return false
          return typeof (value as { readyState?: unknown }).readyState === "number"
        }

        const pending: string[] = []
        let ready = false

        return {
          async onOpen(_event, ws) {
            const socket = ws.raw
            if (!isSocket(socket)) {
              ws.close()
              return
            }
            handler = await Serial.connect(id, socket, cursor)
            ready = true
            for (const msg of pending) handler?.onMessage(msg)
            pending.length = 0
          },
          onMessage(event) {
            if (typeof event.data !== "string") return
            if (!ready) {
              pending.push(event.data)
              return
            }
            handler?.onMessage(event.data)
          },
          onClose() {
            handler?.onClose()
          },
          onError() {
            handler?.onClose()
          },
        }
      }),
    )
}
