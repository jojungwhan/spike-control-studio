# Port registry

Every port this project binds is listed here. If the machine also runs unrelated
services, check their registry too before claiming a new one — these defaults are
deliberately in a high, uncommon range for that reason.

| Service | Port | Bind | Pinned in |
|---------|------|------|-----------|
| Web app dev server (Vite) | **5190** | `127.0.0.1` | `apps/web/vite.config.ts` (`strictPort: true`) |
| Web app preview build | **4190** | `127.0.0.1` | `apps/web/vite.config.ts` |
| Bridge HTTP + WebSocket | **8722** | `127.0.0.1` | `apps/bridge/spike_bridge/config.py` |

## Bridge binding

The bridge binds loopback by default. Raspberry Pi host mode genuinely needs LAN access — an operator
drives from a tablet across the room — so `--host 0.0.0.0` is an explicit opt-in flag. A pairing
token is required either way; the bridge admin page renders it as a QR code for phone pairing.

LAN access is not the same thing as the remote Internet mode excluded from MVP 1. Nothing here opens
an inbound router port.
