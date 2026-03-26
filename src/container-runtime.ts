/**
 * Container runtime abstraction for NanoClaw.
 *
 * In direct-runner mode the K8s pod IS the sandbox — no Docker needed.
 * Functions are stubbed to maintain import compatibility.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** @deprecated No container runtime in direct-runner mode. Kept for import compat. */
export const CONTAINER_RUNTIME_BIN = 'claude';

/** @deprecated No host gateway needed in direct-runner mode. */
export function hostGatewayArgs(): string[] {
  return [];
}

/** @deprecated No readonly mounts in direct-runner mode. */
export function readonlyMountArgs(
  _hostPath: string,
  _containerPath: string,
): string[] {
  return [];
}

/** @deprecated No containers to stop in direct-runner mode. */
export function stopContainer(_name: string): string {
  return 'true'; // no-op shell command
}

/** Ensure the claude CLI is available. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync('claude --version', {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Claude CLI is available');
  } catch (err) {
    logger.error({ err }, 'Claude CLI not found');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Claude CLI not found                                   ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without the Claude CLI. To fix:             ║',
    );
    console.error(
      '║  1. Install Claude Code: npm install -g @anthropic-ai/claude   ║',
    );
    console.error(
      '║  2. Ensure `claude` is on PATH                                 ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Claude CLI is required but not found', {
      cause: err,
    });
  }
}

/** No-op — no containers to clean up in direct-runner mode. */
export function cleanupOrphans(): void {
  logger.debug('Direct-runner mode: no orphan containers to clean up');
}
