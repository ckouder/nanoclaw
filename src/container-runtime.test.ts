import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  hostGatewayArgs,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Stub exports ---

describe('CONTAINER_RUNTIME_BIN', () => {
  it('is set to claude', () => {
    expect(CONTAINER_RUNTIME_BIN).toBe('claude');
  });
});

describe('readonlyMountArgs', () => {
  it('returns empty array (no-op in direct-runner mode)', () => {
    expect(readonlyMountArgs('/host', '/container')).toEqual([]);
  });
});

describe('stopContainer', () => {
  it('returns a no-op shell command', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe('true');
  });
});

describe('hostGatewayArgs', () => {
  it('returns empty array', () => {
    expect(hostGatewayArgs()).toEqual([]);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('succeeds when claude CLI is available', () => {
    mockExecSync.mockReturnValueOnce('claude 1.0.0');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('claude --version', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith('Claude CLI is available');
  });

  it('throws when claude CLI is not found', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('command not found: claude');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Claude CLI is required but not found',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('is a no-op that logs debug message', () => {
    cleanupOrphans();

    expect(logger.debug).toHaveBeenCalledWith(
      'Direct-runner mode: no orphan containers to clean up',
    );
  });
});
