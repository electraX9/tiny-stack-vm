// A tiny stack VM for make.fun's tiny stack ISA (ISA.md).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STEP_LIMIT = 1000000;
const OUT_MAX = 65536;

// opcode: immediate bytes, pops, pushes
const T = '00,0,0,0;01,1,0,1;02,4,0,1;03,0,1,0;04,0,1,2;05,0,2,2;06,0,2,3;07,0,3,3;' +
  '10,0,2,1;11,0,2,1;12,0,2,1;13,0,2,1;14,0,2,1;15,0,2,1;16,0,2,1;17,0,1,1;' +
  '18,0,2,1;19,0,2,1;1a,0,2,1;1b,0,1,1;1c,0,2,1;1d,0,2,1;1e,0,2,1;20,0,2,1;' +
  '21,0,2,1;22,0,2,1;30,2,0,0;31,2,1,0;32,2,1,0;33,2,0,0;34,0,0,0;40,0,1,1;' +
  '41,0,2,0;50,0,1,0;51,0,1,0;52,0,0,1;53,0,1,0';

const IMM = new Uint8Array(256);
const POPS = new Uint8Array(256);
const PUSHES = new Uint8Array(256);
const KNOWN = new Uint8Array(256);
for (const row of T.split(';')) {
  const f = row.split(',');
  const c = parseInt(f[0], 16);
  IMM[c] = +f[1];
  POPS[c] = +f[2];
  PUSHES[c] = +f[3];
  KNOWN[c] = 1;
}

const stack = new Int32Array(256);
const calls = new Int32Array(64);
const memory = new Int32Array(256);
const out = Buffer.allocUnsafe(OUT_MAX);
const digits = Buffer.allocUnsafe(12);

function run(program: Uint8Array, input: Uint8Array): [number, number] {
  let pc = 0;
  let sp = 0;
  let cp = 0;
  let ip = 0;
  let outLen = 0;
  let steps = 0;
  let code = -1;
  const n = program.length;
  stack.fill(0);
  memory.fill(0);
  while (code < 0) {
    if (steps === STEP_LIMIT) code = 10;
    else if (pc < 0 || pc >= n) code = 9;
    else if (KNOWN[program[pc]] === 0) code = 5;
    else {
      const o = program[pc];
      const next = pc + 1 + IMM[o];
      const pops = POPS[o];
      const pushes = PUSHES[o];
      if (next > n) code = 9;
      else if (sp < pops) code = 2;
      else if (sp - pops + pushes > 256) code = 3;
      else {
        let a = 0;
        let b = 0;
        if (pops === 1) a = stack[sp - 1];
        else if (pops === 2) {
          b = stack[sp - 1];
          a = stack[sp - 2];
        } else if (pops === 3) {
          const c = stack[sp - 1];
          b = stack[sp - 2];
          a = stack[sp - 3];
          stack[sp - 3] = b;
          stack[sp - 2] = c;
          stack[sp - 1] = a;
        }
        sp -= pops;
        let jump = -1;
        switch (o) {
          case 0x00: code = 0; break;
          case 0x01: stack[sp++] = (program[pc + 1] << 24) >> 24; break;
          case 0x02: stack[sp++] = program[pc + 1] | (program[pc + 2] << 8) | (program[pc + 3] << 16) | (program[pc + 4] << 24); break;
          case 0x03: break;
          case 0x04: stack[sp++] = a; stack[sp++] = a; break;
          case 0x05: stack[sp++] = b; stack[sp++] = a; break;
          case 0x06: stack[sp++] = a; stack[sp++] = b; stack[sp++] = a; break;
          case 0x07: sp += 3; break;
          case 0x10: stack[sp++] = (a + b) | 0; break;
          case 0x11: stack[sp++] = (a - b) | 0; break;
          case 0x12: stack[sp++] = Math.imul(a, b); break;
          case 0x13:
            if (b === 0) code = 4;
            else if (a === -2147483648 && b === -1) stack[sp++] = a;
            else stack[sp++] = (a / b) | 0;
            break;
          case 0x14:
            if (b === 0) code = 4;
            else stack[sp++] = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:
            if (b === 0) code = 4;
            else stack[sp++] = ((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:
            if (b === 0) code = 4;
            else stack[sp++] = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x17: stack[sp++] = (-a) | 0; break;
          case 0x18: stack[sp++] = a & b; break;
          case 0x19: stack[sp++] = a | b; break;
          case 0x1a: stack[sp++] = a ^ b; break;
          case 0x1b: stack[sp++] = ~a; break;
          case 0x1c: stack[sp++] = a << (b & 31); break;
          case 0x1d: stack[sp++] = a >> (b & 31); break;
          case 0x1e: stack[sp++] = (a >>> (b & 31)) | 0; break;
          case 0x20: stack[sp++] = a === b ? 1 : 0; break;
          case 0x21: stack[sp++] = a < b ? 1 : 0; break;
          case 0x22: stack[sp++] = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
          case 0x30:
          case 0x31:
          case 0x32:
            if (o === 0x30 || (o === 0x31 ? a === 0 : a !== 0)) {
              jump = next + (((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16);
            } else jump = next;
            break;
          case 0x33:
            if (cp === 64) code = 7;
            else {
              calls[cp++] = next;
              jump = program[pc + 1] | (program[pc + 2] << 8);
            }
            break;
          case 0x34:
            if (cp === 0) code = 8;
            else jump = calls[--cp];
            break;
          case 0x40:
            if (a < 0 || a > 255) code = 6;
            else stack[sp++] = memory[a];
            break;
          case 0x41:
            if (b < 0 || b > 255) code = 6;
            else memory[b] = a;
            break;
          case 0x50: {
            const neg = a < 0;
            let v = neg ? (a === -2147483648 ? 2147483648 : -a) : a;
            let len = 0;
            do {
              digits[len++] = 48 + (v % 10);
              v = Math.floor(v / 10);
            } while (v > 0);
            if (neg) digits[len++] = 45;
            if (outLen + len > OUT_MAX) {
              code = 11;
              break;
            }
            for (let i = 0; i < len; i++) out[outLen + i] = digits[len - 1 - i];
            outLen += len;
            break;
          }
          case 0x51:
            if (outLen === OUT_MAX) code = 11;
            else out[outLen++] = a & 255;
            break;
          case 0x52: stack[sp++] = ip < input.length ? input[ip++] : -1; break;
          case 0x53: code = a & 255; break;
        }
        if (code < 0) {
          steps++;
          pc = jump < 0 ? next : jump;
        }
      }
    }
  }
  return [code, outLen];
}

const inputRoot = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(inputRoot).sort()) {
  const dir = join(inputRoot, id);
  let program: Uint8Array;
  try {
    program = readFileSync(join(dir, 'program.bin'));
  } catch {
    continue;
  }
  let input: Uint8Array;
  try {
    input = readFileSync(join(dir, 'input.bin'));
  } catch {
    input = new Uint8Array(0);
  }
  const [code, len] = run(program, input);
  const dest = join(outputRoot, id);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'stdout.bin'), out.subarray(0, len));
  writeFileSync(join(dest, 'exit.txt'), String(code) + '\n');
}
