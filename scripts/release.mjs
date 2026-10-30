import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import semanticRelease from "semantic-release";

/** Keep semantic-release in charge of publication; expose only its actual result. */
export async function runRelease({ release = semanticRelease, outputFile = process.env.GITHUB_OUTPUT, dryRun = false } = {}) {
	// A failed or skipped release must never authorize downstream attestation.
	if (outputFile) await appendFile(outputFile, "released=false\n");
	const result = await release(dryRun ? { dryRun: true } : {});
	if (dryRun || !result?.nextRelease) return false;
	const { version, gitTag } = result.nextRelease;
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || gitTag !== version) {
		throw new Error("Expected an Obsidian release tag matching a stable semantic version.");
	}
	if (outputFile) await appendFile(outputFile, `released=true\nversion=${version}\ntag=${gitTag}\n`);
	return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runRelease({ dryRun: process.argv.includes("--dry-run") });
}
