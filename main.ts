// make.fun tiny stack ISA, version 1: a 32-bit stack machine with ten traps.
// Each instance is <MAKEFUN_INPUT_DIR>/<id>/program.bin plus input.bin; the answer is
// <MAKEFUN_OUTPUT_DIR>/<id>/stdout.bin and exit.txt, so a whole set is one run.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function run(P: Uint8Array, IN: Uint8Array): [Uint8Array, number] {
  const n = P.length;
  const s = new Int32Array(256); // data stack
  const m = new Int32Array(256); // memory words
  const cs = new Int32Array(64); // return addresses
  const o = new Uint8Array(65536); // output bytes
  let sp = 0, cp = 0, ip = 0, pc = 0, ol = 0, st = 0, ex = -1;

  // trap 2 when fewer than k values are held
  const need = (k: number) => (sp >= k ? true : (ex = 2, false));
  // push, trapping 3 when the stack would hold more than 256
  const push = (v: number) => (sp > 255 ? (ex = 3, false) : (s[sp++] = v, true));
  const bn = (f: (a: number, b: number) => number) => { if (need(2)) { s[sp - 2] = f(s[sp - 2], s[sp - 1]); sp--; } };
  const un = (f: (a: number) => number) => { if (need(1)) s[sp - 1] = f(s[sp - 1]); };
  // signed 16-bit jump offset at i
  const off = (i: number) => ((P[i] | (P[i + 1] << 8)) << 16) >> 16;
  // division family; kind 0 DIV, 1 MOD, 2 DIVU, 3 MODU
  const dv = (a: number, b: number, k: number) => b === 0 ? (ex = 4, 0)
    : k === 0 ? (a === -2147483648 && b === -1 ? a : (a / b) | 0)
      : k === 1 ? (a % b) | 0
        : k === 2 ? ((a >>> 0) / (b >>> 0)) | 0 : ((a >>> 0) % (b >>> 0)) | 0;

  while (ex < 0) {
    if (st >= 1000000) { ex = 10; break; } // step limit
    if (pc < 0 || pc >= n) { ex = 9; break; } // pc outside the program
    const op = P[pc], nx = pc + 1;
    let q = nx; // pc of the next instruction unless this one jumps
    switch (op) {
      case 0x00: ex = 0; break; // HALT
      case 0x01: if (nx >= n) ex = 9; else if (push((P[nx] << 24) >> 24)) q = nx + 1; break;
      case 0x02:
        if (nx + 4 > n) ex = 9;
        else if (push(P[nx] | (P[nx + 1] << 8) | (P[nx + 2] << 16) | (P[nx + 3] << 24))) q = nx + 4;
        break;
      case 0x03: if (need(1)) sp--; break; // POP
      case 0x04: if (need(1)) push(s[sp - 1]); break; // DUP
      case 0x05: if (need(2)) { const t = s[sp - 1]; s[sp - 1] = s[sp - 2]; s[sp - 2] = t; } break;
      case 0x06: if (need(2)) push(s[sp - 2]); break; // OVER
      case 0x07: // ROT
        if (need(3)) { const t = s[sp - 3]; s[sp - 3] = s[sp - 2]; s[sp - 2] = s[sp - 1]; s[sp - 1] = t; }
        break;
      case 0x10: bn((a, b) => (a + b) | 0); break;
      case 0x11: bn((a, b) => (a - b) | 0); break;
      case 0x12: bn((a, b) => Math.imul(a, b)); break; // low 32 bits of the product
      case 0x13: bn((a, b) => dv(a, b, 0)); break;
      case 0x14: bn((a, b) => dv(a, b, 1)); break;
      case 0x15: bn((a, b) => dv(a, b, 2)); break;
      case 0x16: bn((a, b) => dv(a, b, 3)); break;
      case 0x17: un((a) => (-a) | 0); break; // NEG
      case 0x18: bn((a, b) => a & b); break;
      case 0x19: bn((a, b) => a | b); break;
      case 0x1a: bn((a, b) => a ^ b); break;
      case 0x1b: un((a) => ~a); break;
      case 0x1c: bn((a, b) => a << (b & 31)); break;
      case 0x1d: bn((a, b) => a >> (b & 31)); break; // arithmetic
      case 0x1e: bn((a, b) => (a >>> (b & 31)) | 0); break; // logical
      case 0x20: bn((a, b) => (a === b ? 1 : 0)); break;
      case 0x21: bn((a, b) => (a < b ? 1 : 0)); break;
      case 0x22: bn((a, b) => ((a >>> 0) < (b >>> 0) ? 1 : 0)); break;
      case 0x30: if (nx + 2 > n) ex = 9; else q = nx + 2 + off(nx); break; // JMP
      case 0x31: // JZ
        if (nx + 2 > n) ex = 9;
        else if (need(1)) q = nx + 2 + (s[--sp] === 0 ? off(nx) : 0);
        break;
      case 0x32: // JNZ
        if (nx + 2 > n) ex = 9;
        else if (need(1)) q = nx + 2 + (s[--sp] !== 0 ? off(nx) : 0);
        break;
      case 0x33: // CALL
        if (nx + 2 > n) ex = 9;
        else if (cp >= 64) ex = 7;
        else { cs[cp++] = nx + 2; q = P[nx] | (P[nx + 1] << 8); }
        break;
      case 0x34: if (cp === 0) ex = 8; else q = cs[--cp]; break; // RET
      case 0x40: // LOAD
        if (need(1)) { const a = s[--sp]; if (a < 0 || a > 255) ex = 6; else s[sp++] = m[a]; }
        break;
      case 0x41: // STORE
        if (need(2)) { const a = s[--sp], v = s[--sp]; if (a < 0 || a > 255) ex = 6; else m[a] = v; }
        break;
      case 0x50: // PRINT, decimal ASCII
        if (need(1)) {
          const t = String(s[--sp]);
          if (ol + t.length > 65536) ex = 11;
          else for (let i = 0; i < t.length; i++) o[ol++] = t.charCodeAt(i);
        }
        break;
      case 0x51: // PUTC
        if (need(1)) { if (ol > 65535) ex = 11; else o[ol++] = s[--sp] & 255; }
        break;
      case 0x52: push(ip < IN.length ? IN[ip++] : -1); break; // IN
      case 0x53: if (need(1)) ex = s[--sp] & 255; break; // EXIT
      default: ex = 5;
    }
    if (ex < 0) { pc = q; st++; }
  }
  return [o.subarray(0, ol), ex];
}

const one = existsSync(join(I, 'program.bin'));
const ids = one ? ['.'] : readdirSync(I).filter((d) => existsSync(join(I, d, 'program.bin'))).sort();
for (const id of ids) {
  const d = join(I, id), f = join(d, 'input.bin');
  const [out, code] = run(readFileSync(join(d, 'program.bin')), existsSync(f) ? readFileSync(f) : new Uint8Array(0));
  const od = one ? O : join(O, id);
  mkdirSync(od, { recursive: true });
  writeFileSync(join(od, 'stdout.bin'), out);
  writeFileSync(join(od, 'exit.txt'), code + '\n');
}
