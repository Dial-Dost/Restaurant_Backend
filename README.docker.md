# Docker compose for backend

This folder contains Dockerfiles and a `docker-compose.yml` to run the backend (Node.js + Python) together.

Services
- `python`: Builds from `Dockerfile.python` and runs the FastAPI app via `uvicorn` on port `8000`.
- `node`: Builds from `Dockerfile.node`, runs `npm run build` and then `npm run start` to run the compiled Node server on port `3001`.

Quick start

```bash
# from Restaurant_Backend/
docker compose up --build
```

Notes
- The Python service is exposed on `8000` and the Node service on `3001`.
- The compose file sets `PY_SERVER_URL` for the Node container to `http://python:8000` (container hostname).
- If your Node code expects the Python server on localhost, update any internal URLs to use `process.env.PY_SERVER_URL`.
