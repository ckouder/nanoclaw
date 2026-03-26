/**
 * Container runtime abstraction for NanoClaw.
 * Direct-runner mode: Claude Code runs as a child process, not in a container.
 * All Docker-specific logic is stubbed out.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** Kept for interface compatibility — unused in direct-runner mode. */
export const CONTAINER_RUNTIME_BIN = 'claude';

/** No-op: host gateway is irrelevant without containers. */
export function hostGatewayArgs(): string[] {
  return [];
}

/** No-op: no container mounts in direct-runner mode. */
export function readonlyMountArgs(
  _hostPath: string,
  _containerPath: string,
): string[] {
  return [];
}

/** No-op: no containers to stop. */
export function stopContainer(_name: string): string {
  return 'true'; // shell no-op
}

/** Verify that the `claude` CLI is available on the host. */
export function ensureContainerRuntimeRunning(): void {
  try {
    const version = execSync('claude --version', {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();
    logger.info({ version }, 'Claude CLI available');
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
      '║  Direct-runner mode requires the `claude` CLI on PATH.         ║',
    );
    console.error(
      '║  Install: npm install -g @anthropic-ai/claude-code             ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Claude CLI is required but not found', { cause: err });
  }
}

/** No-op: no orphaned containers in direct-runner mode. */
export function cleanupOrphans(): void {
  logger.debug('cleanupOrphans: no-op in direct-runner mode');
}
