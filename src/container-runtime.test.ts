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

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions (stubs in direct-runner mode) ---

describe('readonlyMountArgs', () => {
  it('returns empty array (no-op in direct-runner mode)', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([]);
  });
});

describe('stopContainer', () => {
  it('returns shell no-op command', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe('true');
  });
});

describe('CONTAINER_RUNTIME_BIN', () => {
  it('is set to claude', () => {
    expect(CONTAINER_RUNTIME_BIN).toBe('claude');
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('succeeds when claude CLI is available', () => {
    mockExecSync.mockReturnValueOnce('1.0.0');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('claude --version', {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf-8',
    });
    expect(logger.info).toHaveBeenCalledWith(
      { version: '1.0.0' },
      'Claude CLI available',
    );
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
  it('is a no-op in direct-runner mode', () => {
    cleanupOrphans();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'cleanupOrphans: no-op in direct-runner mode',
    );
  });
});
