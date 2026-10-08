import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A committed fixture (src/test/fixtures/docx) or a private one (fixtures/private), as an ArrayBuffer made by THIS environment's
 * constructor. Under jsdom a Buffer's own buffer comes from another realm and the zip reader does not recognise it.
 */
export function loadDocx(name: string, dir: 'fixtures' | 'private' = 'fixtures'): ArrayBuffer {
  const path = dir === 'fixtures' ? join(process.cwd(), 'src/test/fixtures/docx', name) : join(process.cwd(), 'fixtures/private', name);
  const b = readFileSync(path);
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}
