const MAX_RENDERED_LOG_BYTES = 128 * 1024;
const OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESCAPE = /\u001b[()][0-2A-Z0-9]|\u001b[@-_]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

/** Converts provider terminal output into a bounded plain-text renderer payload. */
export function sanitizeTerminalOutput(value: string): string {
  const plain = value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESCAPE, '')
    .replace(UNSAFE_CONTROL, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
  const bytes = Buffer.byteLength(plain, 'utf8');
  if (bytes <= MAX_RENDERED_LOG_BYTES) return plain;
  let start = Math.max(0, plain.length - MAX_RENDERED_LOG_BYTES);
  while (start < plain.length && Buffer.byteLength(plain.slice(start), 'utf8') > MAX_RENDERED_LOG_BYTES) {
    start += 1;
  }
  const tail = plain.slice(start);
  const lineStart = tail.indexOf('\n');
  return `[Earlier output omitted; showing the last ${MAX_RENDERED_LOG_BYTES / 1024} KiB.]\n${
    lineStart === -1 ? tail : tail.slice(lineStart + 1)
  }`;
}
