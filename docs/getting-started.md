# Getting started

[← Back to the README](../README.md) · [Architecture](architecture.md) · [How transitions work](transitions.md)

Heterodina is a small Node server next to your Plex and a web player. You need a Plex Media Server with a music library and its token ([how to find it](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)).

## Docker (recommended)

CI publishes a multi-arch image (amd64 and arm64) to `ghcr.io/haskou/heterodina` on every push to `main`. Old builds are pruned automatically.

```bash
cp .env.example .env   # fill in PLEX_URL and PLEX_TOKEN
docker compose up -d   # http://localhost:5174
```

- `PLEX_URL` must be reachable from inside the container. Use the Plex server's LAN address, `http://host.docker.internal:32400` when Plex runs on the same machine, or the service name (`http://plex:32400`) when both containers share a Docker network. A URL without `http://` is read as `http://`.
- The compose file takes `PLEX_URL` and `PLEX_TOKEN` from the shell, from your stack's variables (Portainer, Dockge…) or from a `.env` next to it, and refuses to start if either is missing. With plain Docker, use `docker run -e PLEX_URL=… -e PLEX_TOKEN=…`.
- Analysis caches and resized covers persist in the `heterodina-cache` volume. If you mount a host folder instead (`/some/path:/app/.cache`), it must be writable by the container's user, uid 1000: `sudo chown -R 1000:1000 /some/path`. Otherwise nothing is cached across restarts and the server warns about it in the log.

### What happens on first start

- The library index is built in memory at every start. It takes seconds, even for tens of thousands of tracks. If Plex is not reachable yet (for example, it starts in the same stack), the server keeps retrying, backing off to once a minute.
- Each new station's universe is then analysed for tempo in the background, one track at a time with a rest in between, at lower process priority. It is a head start only: the tracks the radio needs right now are analysed at once.
- Covers are resized by Plex once and then served from disk.
- While the library is being processed, the player says so above the controls.

## From source

Requires Node 24 or later. Node runs the TypeScript natively, so the server has no build step.

```bash
cp .env.example .env   # fill in PLEX_URL and PLEX_TOKEN
npm install
npm run dev            # API on :5174 + Vite on :5173
```

Open http://localhost:5173.

For production, `npm run build && npm start` serves the compiled front end from `dist/` on the API port.

## Settings

Settings come from environment variables. A `.env` file is optional and only fills in what the environment doesn't set.

| Variable | Purpose |
|---|---|
| `PLEX_URL` | Plex server URL, e.g. `http://127.0.0.1:32400` |
| `PLEX_TOKEN` | Read by the server only; never sent to the browser |
| `PLEX_LIBRARY` | Name of the music library (case- and accent-insensitive, default `Music`) |
| `API_PORT` | API port (default 5174) |
| `HOST` | Interface to listen on (default `127.0.0.1`; the Docker image uses `0.0.0.0`) |

## Development commands

- `npm test`: server tests (against a fake Plex), transition planner, beat detector and the front end's pure logic.
- `npm run typecheck`: strict TypeScript for server and front end.
- `node scripts/radio-sim.ts <trackId> [n] [--no-fit]`: plays a station without audio against your Plex and reports universe adherence, variety and how well the hand-overs fit. `--no-fit` is the baseline without the edge and tempo preferences.
- `node scripts/universe-probe.ts <albumId> […]`: prints the inferred universe of some albums.
