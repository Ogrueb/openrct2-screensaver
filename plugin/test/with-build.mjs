// Runs the mock tests that need a built playlist, and skips them when there is no build:
//   node test/with-build.mjs "<sequence dir>" test/mode-run.mjs test/mock-run.mjs
// The build comes from `python tools/mksequence.py playlists/example.toml`, which needs the example
// parks downloaded into ExampleParks/ (see ExampleParks/README.md). mode-run.mjs takes the
// playlist JSON, mock-run.mjs the sequence folder and the playlist JSON.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const [seqDir, ...scripts] = process.argv.slice(2);
const playlist = seqDir + ".playlist.json";
if (!fs.existsSync(playlist)) {
    console.log(`skipped: ${scripts.join(", ")} (no build at ${seqDir}; build playlists/example.toml first)`);
    process.exit(0);
}
for (const script of scripts) {
    const args = script.endsWith("mock-run.mjs") ? [seqDir, playlist] : [playlist];
    const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
}
