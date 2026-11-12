import { describe, expect, it } from 'vitest';

import { cliCommand, inheritedVar, rulePath } from './platform.js';

describe('a CLI on Windows', () => {
  const files: Record<string, string> = {
    'C:\\Users\\maria\\.local\\bin\\claude.exe': '',
    'C:\\Users\\maria\\AppData\\Roaming\\npm\\codex.cmd':
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  };
  const exists = (path: string) => path in files;
  const read = (path: string) => files[path] ?? '';
  const env = {
    Path: 'C:\\Windows\\system32;C:\\Users\\maria\\.local\\bin;C:\\Users\\maria\\AppData\\Roaming\\npm',
  };

  it('is the .exe on the PATH', () => {
    expect(cliCommand('claude', env, 'win32', exists, read)).toEqual([
      'C:\\Users\\maria\\.local\\bin\\claude.exe',
    ]);
  });

  it("is npm's script started by this Node, never the .cmd through a shell", () => {
    expect(cliCommand('codex', env, 'win32', exists, read)).toEqual([
      process.execPath,
      'C:\\Users\\maria\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    ]);
  });

  it("is found where its installer put it, off the person's PATH", () => {
    const home = {
      Path: 'C:\\Windows\\system32',
      USERPROFILE: 'C:\\Users\\maria',
      APPDATA: 'C:\\Users\\maria\\AppData\\Roaming',
    };
    expect(cliCommand('claude', home, 'win32', exists, read)).toEqual([
      'C:\\Users\\maria\\.local\\bin\\claude.exe',
    ]);
    expect(cliCommand('codex', home, 'win32', exists, read)).toEqual([
      process.execPath,
      'C:\\Users\\maria\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    ]);
  });

  it('is left as it is when it is a path, missing, or elsewhere than Windows', () => {
    expect(cliCommand('C:\\tools\\claude.exe', env, 'win32', exists, read)).toEqual([
      'C:\\tools\\claude.exe',
    ]);
    expect(cliCommand('gemini', env, 'win32', exists, read)).toEqual(['gemini']);
    expect(cliCommand('claude', env, 'darwin', exists, read)).toEqual(['claude']);
  });
});

describe('permission rule paths', () => {
  it('are absolute in the CLI’s own form', () => {
    expect(rulePath('/home/maria/.ssh', 'linux')).toBe('//home/maria/.ssh');
    expect(rulePath('C:\\Users\\maria\\.ssh', 'win32')).toBe('//c/Users/maria/.ssh');
  });
});

describe('the environment of a CLI', () => {
  const names = new Set(['PATH', 'HTTPS_PROXY']);

  it('takes on Windows what every program there needs, in any case', () => {
    expect(inheritedVar('SystemRoot', names, 'win32')).toBe(true);
    expect(inheritedVar('Path', names, 'win32')).toBe(true);
    expect(inheritedVar('https_proxy', names, 'win32')).toBe(true);
    expect(inheritedVar('AGENTOME_SEAT_TOKEN', names, 'win32')).toBe(false);
  });

  it('takes elsewhere only the names it lists', () => {
    expect(inheritedVar('SystemRoot', names, 'linux')).toBe(false);
    expect(inheritedVar('Path', names, 'linux')).toBe(false);
  });
});
