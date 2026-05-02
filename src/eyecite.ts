/**
 * Node-side wrapper for the Python eyecite citation detector.
 *
 * The detection itself runs in a Python container — see
 * `skills/detect-citations/Dockerfile` for the image build. This module
 * shells out to the runtime that built that image (Apple Container,
 * Docker, or Podman) and pipes case text in via stdin.
 *
 * Design choice: per-call subprocess (one container spawn per case),
 * not a long-lived daemon. The container start cost is ~200-400 ms with
 * a prebuilt image, which is acceptable for the corpus sizes we run on
 * (≤ a few hundred cases per detect-citations invocation). A daemon
 * pattern would be faster but adds lifecycle complexity; defer.
 *
 * The container runtime (`container` / `docker` / `podman`) is selected
 * via the `CONTAINER_RUNTIME` env var (default: `container`).
 *
 * Used by skill 2 (`detect-citations`).
 */

import { spawn } from 'node:child_process';

export interface DetectedCitation {
  /** The exact citation text as it appears in the source. */
  text: string;
  /** Character offset of the first character of the citation. */
  start: number;
  /** Character offset just past the last character of the citation. */
  end: number;
  /**
   * Citation type from eyecite.
   * Common values: `FullCaseCitation`, `ShortCaseCitation`,
   * `IdCitation`, `SupraCitation`, `StatutoryCitation`.
   */
  type: string;
}

const DEFAULT_IMAGE_TAG = process.env.EYECITE_IMAGE_TAG ?? 'semiont-eyecite:latest';
const RUNTIME = process.env.CONTAINER_RUNTIME ?? 'container';

/**
 * Detect legal citations in a single case's text by piping it through
 * the Python eyecite container and parsing the JSON response.
 *
 * Throws if the container exits non-zero or stdout isn't parseable JSON.
 * Build the image first via `container build -t semiont-eyecite:latest skills/detect-citations`
 * (or whatever your runtime is).
 */
export async function detectCitations(text: string): Promise<DetectedCitation[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(RUNTIME, ['run', '--rm', '-i', DEFAULT_IMAGE_TAG], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn '${RUNTIME}'. Make sure the runtime is installed ` +
            `and the eyecite image is built: ${err.message}`,
        ),
      );
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `eyecite container exited with code ${code}.\n` +
              `stderr: ${stderr.trim() || '(empty)'}\n` +
              `Hint: build the image first with ` +
              `'${RUNTIME} build -t ${DEFAULT_IMAGE_TAG} skills/detect-citations'.`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { citations: DetectedCitation[] };
        resolve(parsed.citations ?? []);
      } catch (err) {
        reject(
          new Error(`Failed to parse eyecite output as JSON: ${(err as Error).message}`),
        );
      }
    });

    proc.stdin.write(text);
    proc.stdin.end();
  });
}
