import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';

// A terminal in the person's own place on the server, to sign in to Claude Code (`claude`) and
// Codex (`codex login --device-auth`: the browser cannot reach the place for its usual callback). The keystrokes go to the shell as binary frames and a size as a text
// frame; nothing of it is kept by Agentome.

/** The terminal's colours from the page's own tokens, so it follows the light and dark themes. */
function themeOf(element: HTMLElement) {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--bg-sunken', '#fafafa'),
    foreground: token('--ink', '#111113'),
    cursor: token('--ink', '#111113'),
    selectionBackground: token('--bg-selected', '#ececee'),
  };
}

export function terminalUrl(location: Pick<Location, 'protocol' | 'host'>) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/me/place/terminal`;
}

export function PlaceTerminal(props: { open: boolean; onClose: () => void }) {
  // A ref the dialog sets once its content is in the page: the portal mounts after this renders.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');

  useEffect(() => {
    if (!props.open || !host) return;
    const element = host;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(element).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      theme: themeOf(element),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    setStatus('connecting');
    const socket = new WebSocket(terminalUrl(window.location));
    socket.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();
    const sendSize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cols: terminal.cols, rows: terminal.rows }));
      }
    };
    socket.onopen = () => {
      setStatus('open');
      sendSize();
      terminal.focus();
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) =>
      terminal.write(new Uint8Array(event.data));
    socket.onclose = () => setStatus('closed');
    const typed = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const resized = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    resized.observe(element);
    return () => {
      resized.disconnect();
      typed.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [props.open, host]);

  return (
    <D.Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent size="wide">
        <D.DialogTitle>Terminal in your place</D.DialogTitle>
        <D.DialogDescription>
          Run <code>claude</code> and sign in with your Claude subscription, or{' '}
          <code>codex login --device-auth</code> for ChatGPT. Your sign-in stays in your place;
          Agentome does not keep what you type.
        </D.DialogDescription>
        <div
          ref={setHost}
          className="h-[420px] w-full overflow-hidden rounded-md border border-line bg-desk p-2"
          aria-label="Terminal"
        />
        {/* Escape belongs to the terminal: a button closes the window. */}
        <div className="flex items-center gap-4">
          <p className="min-w-0 flex-1 text-ink-2" aria-live="polite">
            {status === 'connecting'
              ? 'Waking your place and opening the terminal…'
              : status === 'closed'
                ? 'The terminal is closed. Open it again for a new one.'
                : 'Connected.'}
          </p>
          <D.DialogClose asChild>
            <Button>Close terminal</Button>
          </D.DialogClose>
        </div>
      </D.DialogContent>
    </D.Dialog>
  );
}
