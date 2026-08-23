import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const REQUIRED_MAJOR = 22;
const REEXEC_MARKER = "AGENT_COFOUNDER_NODE_REEXEC";

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findNode22Binary(): Promise<string | undefined> {
  const candidates = [
    process.env.CHALLENGE_NODE_BINARY,
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@22/bin/node",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function handoffToSupportedNode(entryFile: string, argv: string[]): Promise<number | undefined> {
  if (Number(process.versions.node.split(".")[0]) === REQUIRED_MAJOR) return undefined;
  if (process.env[REEXEC_MARKER] === "1") {
    throw new Error(`The configured fallback Node runtime is ${process.version}; Node 22 is required.`);
  }
  const binary = await findNode22Binary();
  if (!binary) {
    throw new Error(
      `Node 22 is required (current: ${process.version}). Install node@22 or set CHALLENGE_NODE_BINARY to its executable.`,
    );
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, ["--import", "tsx", path.resolve(entryFile), ...argv], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [REEXEC_MARKER]: "1",
        PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
