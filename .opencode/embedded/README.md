# Embedded MCP and Skills

This folder stores the first embedded-development setup for:

- platform: `ssc377`
- product: `as7230v1`

## Layout

- `manifest/platforms/*.json`: platform-level SDK and toolchain metadata
- `manifest/products/*.json`: product-level source/build/flash metadata
- `scripts/*.sh`: local helper scripts used by MCP tools

## Dependencies

- `ser2net` for UART to TCP bridge
- `cmake` and `ninja` (or your chosen build backend)
- flashing utility for your board (default script uses `openocd` command pattern)

## Recommended environment variables

- `SSC377_SDK_ROOT`: root path of SSC377 SDK
- `SER2NET_HOST`: ser2net host, default `127.0.0.1`
- `SER2NET_RW_PORT`: rw port, default `3333`
- `SER2NET_MON_PORT`: monitor port, default `3334`
- `FLASH_PORT`: serial/flash port, default `/dev/ttyUSB0`

## ser2net baseline example

Use one rw endpoint and one monitor endpoint so writing and monitoring are separated:

```yaml
connection: &ssc377_rw
  accepter: tcp,3333
  connector: serialdev,/dev/ttyUSB0,115200n81,local
  options:
    kickolduser: true

connection: &ssc377_mon
  accepter: tcp,3334
  connector: serialdev,/dev/ttyUSB0,115200n81,local
  options:
    read_only: true
```

Then use MCP `embedded_debug` tools for single-writer lock and multi-client monitoring.
