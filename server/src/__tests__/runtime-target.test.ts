import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TOILET_PI_RUNTIMES,
  expandHomeDir,
  getRuntimeDefaults,
  resolveRuntimeTarget,
} from '../node/runtime-target.js'

const HOME_DIR = path.join(path.sep, 'home', 'tester')

describe('resolveRuntimeTarget', () => {
  it('defaults to pi when runtime is ambiguous', () => {
    const target = resolveRuntimeTarget({
      env: {},
      homeDir: HOME_DIR,
      dirExists: () => true,
      commandExists: () => true,
    })

    expect(target).toEqual({
      runtime: TOILET_PI_RUNTIMES.PI,
      agentDir: path.join(HOME_DIR, '.pi', 'agent'),
      sessionDir: path.join(HOME_DIR, '.pi', 'agent', 'sessions'),
      command: 'pi',
    })
  })

  it('selects omp when only omp defaults are available', () => {
    const ompDefaults = getRuntimeDefaults(TOILET_PI_RUNTIMES.OMP, { homeDir: HOME_DIR })
    const target = resolveRuntimeTarget({
      env: {},
      homeDir: HOME_DIR,
      dirExists: candidate => candidate === ompDefaults.agentDir,
      commandExists: () => false,
    })

    expect(target).toEqual({
      runtime: TOILET_PI_RUNTIMES.OMP,
      agentDir: ompDefaults.agentDir,
      sessionDir: ompDefaults.sessionDir,
      command: 'omp',
    })
  })

  it('respects TOILET_PI_RUNTIME override', () => {
    const target = resolveRuntimeTarget({
      env: { TOILET_PI_RUNTIME: 'omp' },
      homeDir: HOME_DIR,
      dirExists: () => false,
      commandExists: () => false,
    })

    expect(target.runtime).toBe(TOILET_PI_RUNTIMES.OMP)
    expect(target.command).toBe('omp')
    expect(target.agentDir).toBe(path.join(HOME_DIR, '.omp', 'agent'))
    expect(target.sessionDir).toBe(path.join(HOME_DIR, '.omp', 'agent', 'sessions'))
  })

  it('uses explicit env overrides for paths and command', () => {
    const target = resolveRuntimeTarget({
      env: {
        PI_CODING_AGENT_DIR: '~/custom-agent',
        TOILET_PI_SESSION_DIR: '~/custom-sessions',
        TOILET_PI_PI_COMMAND: '/usr/local/bin/omp',
      },
      homeDir: HOME_DIR,
      dirExists: () => false,
      commandExists: () => false,
    })

    expect(target).toEqual({
      runtime: TOILET_PI_RUNTIMES.OMP,
      agentDir: path.join(HOME_DIR, 'custom-agent'),
      sessionDir: path.join(HOME_DIR, 'custom-sessions'),
      command: '/usr/local/bin/omp',
    })
  })

  it('derives the default session dir from an explicit agent dir', () => {
    const target = resolveRuntimeTarget({
      env: {
        PI_CODING_AGENT_DIR: '~/custom-agent',
      },
      homeDir: HOME_DIR,
      dirExists: () => false,
      commandExists: () => false,
    })

    expect(target.runtime).toBe(TOILET_PI_RUNTIMES.PI)
    expect(target.agentDir).toBe(path.join(HOME_DIR, 'custom-agent'))
    expect(target.sessionDir).toBe(path.join(HOME_DIR, 'custom-agent', 'sessions'))
    expect(target.command).toBe('pi')
  })

  it('prefers the active host agent dir when provided', () => {
    const target = resolveRuntimeTarget({
      env: {},
      homeDir: HOME_DIR,
      hostAgentDir: path.join(HOME_DIR, '.omp', 'agent'),
      dirExists: () => false,
      commandExists: () => false,
    })

    expect(target).toEqual({
      runtime: TOILET_PI_RUNTIMES.OMP,
      agentDir: path.join(HOME_DIR, '.omp', 'agent'),
      sessionDir: path.join(HOME_DIR, '.omp', 'agent', 'sessions'),
      command: 'omp',
    })
  })

  it('expands tilde paths', () => {
    expect(expandHomeDir('~', HOME_DIR)).toBe(HOME_DIR)
    expect(expandHomeDir('~/agent', HOME_DIR)).toBe(path.join(HOME_DIR, 'agent'))
    expect(expandHomeDir('~\\agent', HOME_DIR)).toBe(path.join(HOME_DIR, 'agent'))
  })
})
