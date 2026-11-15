import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

// What the program asks of the machine: run a command, ask a person. Both are passed in, so the
// tests run the program against a Docker and a person of their own.

export type Exec = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream;
  },
) => Promise<{ code: number; stdout: string }>;

/** Runs a command: its output goes to the terminal, or is kept when `capture` asks for it. */
export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['inherit', options.capture || options.stdout ? 'pipe' : 'inherit', 'inherit'],
      // Windows finds `docker.exe`, `node.exe` and `.cmd` shims only through its shell.
      shell: process.platform === 'win32',
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (options.stdout) options.stdout.write(chunk);
      else stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: 127, stdout }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });

export interface Ask {
  /** A line typed in answer, or `fallback` for an empty one. */
  text(question: string, fallback: string): Promise<string>;
  yes(question: string, fallback: boolean): Promise<boolean>;
}

/** Asks at the terminal; without one (a pipe, CI, --yes) every answer is its default. */
export function askAt(interactive: boolean): Ask {
  if (!interactive) {
    return { text: async (_q, fallback) => fallback, yes: async (_q, fallback) => fallback };
  }
  const line = async (question: string) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await reader.question(question)).trim();
    } finally {
      reader.close();
    }
  };
  return {
    text: async (question, fallback) =>
      (await line(`${question}${fallback ? ` (${fallback})` : ''}: `)) || fallback,
    yes: async (question, fallback) => {
      const answer = (await line(`${question} ${fallback ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
      return answer === '' ? fallback : answer.startsWith('y');
    },
  };
}

/** An error the program says to the person as it is, without a stack. */
export class Refusal extends Error {
  override name = 'Refusal';
}
