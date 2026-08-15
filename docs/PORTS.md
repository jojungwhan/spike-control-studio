# Port registry

This project shares a machine with the CIT stack, whose canonical registry is
`<workspace>/PORTS.md` (8000, 5174, 3000, 8787, 5173, 8765, 8797 are taken there).
Verify a port is free on both lists before claiming it.

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
