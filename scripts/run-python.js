import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const repoRoot = path.resolve();
const venvWindows = path.join(repoRoot, ".venv", "Scripts", "python.exe");
const venvUnix = path.join(repoRoot, ".venv", "bin", "python");

let pythonPath = null;
if (fs.existsSync(venvWindows)) {pythonPath = venvWindows;}
else if (fs.existsSync(venvUnix)) {pythonPath = venvUnix;}
else {pythonPath = "python";}

const script = path.join(repoRoot, "Python_servers", "main.py");

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start = 8000, end = 8100) {
  for (let p = start; p <= end; p += 1) {
     
    if (await checkPortAvailable(p)) {return p;}
  }
  return null;
}

async function run() {
  const chosen = process.env.PY_SERVER_PORT ?? (await findFreePort(8000, 8100));
  if (!chosen) {
    console.error("No free port found for Python server (tried 8001-8100)");
    process.exit(1);
  }
  console.log(`Starting Python server using: ${pythonPath} on port ${chosen}`);

  const env = { ...process.env, PY_SERVER_PORT: String(chosen) };
  const child = spawn(pythonPath, [script], { stdio: "inherit", env });

  child.on("close", (code) => {
    console.log(`Python server exited with code ${code}`);
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error("Failed to start Python server:", err);
    process.exit(1);
  });
}

run().catch((err) => {
  console.error("run-python error:", err);
  process.exit(1);
});
