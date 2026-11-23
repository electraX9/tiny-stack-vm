// tiny-stack-vm: an interpreter for make.fun's tiny stack ISA v1 (see ISA.md), plain TS, no deps.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// one byte's worth of immediate length: 0 none, 1 PUSH8, 2 branch, 4 PUSH32
const LEN = new Uint8Array(256);
LEN[0x01] = 1;
LEN[0x02] = 4;
for (let c = 0x30; c < 0x34; c++) LEN[c] = 2;

function run(prog: Uint8Array, input: Uint8Array): [Uint8Array, number] {
  const S = new Int32Array(256), C = new Int32Array(64), M = new Int32Array(256);
  const out: number[] = [];
  let sp = 0, cp = 0, pc = 0, ip = 0, steps = 0;
  const n = prog.length;
  const pop = () => S[--sp];
  const push = (v: number) => { S[sp++] = v; };
  const trap = (c: number): [Uint8Array, number] => [Uint8Array.from(out), c];
  for (;;) {
    if (steps++ === 1000000) return trap(10);
    if (pc < 0 || pc >= n) return trap(9);
    const op = prog[pc];
    const l = LEN[op];
    if (pc + l > n) return trap(9);
    // immediates
    const imm = l === 1 ? op === 1 ? (prog[pc + 1] << 24) >> 24 : 0
      : l === 2 ? ((prog[pc + 1] | (prog[pc + 2] << 8)) << 16) >> 16
      : l === 4 ? prog[pc + 1] | (prog[pc + 2] << 8) | (prog[pc + 3] << 16) | (prog[pc + 4] << 24)
      : 0;
    const npc = pc + 1 + l;
    // stack needs: values popped, values pushed
    let np = 0, pp = 0;
    if (op >= 0x10 && op <= 0x16 || op >= 0x18 && op <= 0x19 || op === 0x1a || op >= 0x20 && op <= 0x22) np = pp = 2;
    else if (op === 0x03) np = 1;
    else if (op === 0x1b || op === 0x17) np = pp = 1;
    else if (op === 0x04) { np = 1; pp = 2; } else if (op === 0x05) np = pp = 2;
    else if (op === 0x06) { np = 2; pp = 3; } else if (op === 0x07) np = pp = 3;
    else if (op === 0x1c || op === 0x1d || op === 0x1e) np = pp = 2;
    else if (op === 0x01 || op === 0x02 || op === 0x52) pp = 1;
    else if (op === 0x31 || op === 0x32 || op === 0x40 || op === 0x50 || op === 0x51 || op === 0x53) { np = 1; pp = 1; }
    else if (op === 0x41) np = 2;
    if (sp < np) return trap(2);
    if (sp - np + pp > 256) return trap(3);
    pc = npc;
    switch (op) {
      case 0x00: return [Uint8Array.from(out), 0];
      case 0x01: case 0x02: push(imm); break;
      case 0x03: sp--; break;
      case 0x04: push(S[sp - 1]); break;
      case 0x05: { const a = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a; break; }
      case 0x06: push(S[sp - 2]); break;
      case 0x07: { const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a; break; }
      case 0x10: { const b = pop(); push((pop() + b) | 0); break; }
      case 0x11: { const b = pop(); push((pop() - b) | 0); break; }
      case 0x12: { const b = pop(); push(Math.imul(pop(), b)); break; }
      case 0x13: { const b = pop(); const a = pop(); if (!b) return trap(4); push((a / b) | 0); break; }
      case 0x14: { const b = pop(); const a = pop(); if (!b) return trap(4); push(a % b | 0); break; }
      case 0x15: { const b = pop() >>> 0; const a = pop() >>> 0; if (!b) return trap(4); push((a / b) | 0); break; }
      case 0x16: { const b = pop() >>> 0; const a = pop() >>> 0; if (!b) return trap(4); push((a % b) | 0); break; }
      case 0x17: push(-pop() | 0); break;
      case 0x18: { const b = pop(); push(pop() & b); break; }
      case 0x19: { const b = pop(); push(pop() | b); break; }
      case 0x1a: { const b = pop(); push(pop() ^ b); break; }
      case 0x1b: push(~pop()); break;
      case 0x1c: { const b = pop(); push(pop() << (b & 31)); break; }
      case 0x1d: { const b = pop(); push(pop() >> (b & 31)); break; }
      case 0x1e: { const b = pop(); push(pop() >>> (b & 31) | 0); break; }
      case 0x20: { const b = pop(); push(pop() === b ? 1 : 0); break; }
      case 0x21: { const b = pop(); push(pop() < b ? 1 : 0); break; }
      case 0x22: { const b = pop() >>> 0; push((pop() >>> 0) < b ? 1 : 0); break; }
      case 0x30: pc = npc + imm; break;
      case 0x31: if (pop() === 0) pc = npc + imm; break;
      case 0x32: if (pop() !== 0) pc = npc + imm; break;
      case 0x33: if (cp === 64) return trap(7); C[cp++] = npc; pc = prog[npc - 2] | (prog[npc - 1] << 8); break;
      case 0x34: if (!cp) return trap(8); pc = C[--cp]; break;
      case 0x40: { const a = pop(); if (a < 0 || a > 255) return trap(6); push(M[a]); break; }
      case 0x41: { const a = pop(); const v = pop(); if (a < 0 || a > 255) return trap(6); M[a] = v; break; }
      case 0x50: {
        const s = String(pop());
        if (out.length + s.length > 65536) return trap(11);
        for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k));
        break;
      }
      case 0x51: if (out.length + 1 > 65536) return trap(11); out.push(pop() & 255); break;
      case 0x52: push(ip < input.length ? input[ip++] : -1); break;
      case 0x53: return [Uint8Array.from(out), pop() & 255];
      default: return trap(5);
    }
  }
}

for (const id of readdirSync(I).sort()) {
  const d = join(I, id);
  const prog = readFileSync(join(d, 'program.bin'));
  let inp: Uint8Array;
  try { inp = readFileSync(join(d, 'input.bin')); } catch { inp = new Uint8Array(0); }
  const [out, code] = run(prog, inp);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), out);
  writeFileSync(join(O, id, 'exit.txt'), code + '\n');
}
