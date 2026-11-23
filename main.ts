// A tiny stack virtual machine for make.fun's tiny-stack-vm-01, written from ISA.md.
// Node 22 runs it directly: no dependencies, no build step, no type annotations.
const fs = require("node:fs");
const path = require("node:path");

const dirIn = process.env.MAKEFUN_INPUT_DIR;
const dirOut = process.env.MAKEFUN_OUTPUT_DIR;
const prog = fs.readFileSync(path.join(dirIn, "program.bin"));
let input = Buffer.alloc(0);
try {
  input = fs.readFileSync(path.join(dirIn, "input.bin"));
} catch (e) {
  input = Buffer.alloc(0);
}

// Per opcode: [values popped, values pushed, immediate bytes]. Absent = unknown opcode.
const T = [];
const op = (c, pops, pushes, imm) => { T[c] = [pops, pushes, imm || 0]; };
op(0x00, 0, 0); op(0x01, 0, 1, 1); op(0x02, 0, 1, 4);
op(0x03, 1, 0); op(0x04, 1, 2); op(0x05, 2, 2); op(0x06, 2, 3); op(0x07, 3, 3);
for (let c = 0x10; c <= 0x16; c++) op(c, 2, 1);
op(0x17, 1, 1); op(0x18, 2, 1); op(0x19, 2, 1); op(0x1a, 2, 1); op(0x1b, 1, 1);
op(0x1c, 2, 1); op(0x1d, 2, 1); op(0x1e, 2, 1);
op(0x20, 2, 1); op(0x21, 2, 1); op(0x22, 2, 1);
op(0x30, 0, 0, 2); op(0x31, 1, 0, 2); op(0x32, 1, 0, 2); op(0x33, 0, 0, 2); op(0x34, 0, 0);
op(0x40, 1, 1); op(0x41, 2, 0); op(0x50, 1, 0); op(0x51, 1, 0); op(0x52, 0, 1); op(0x53, 1, 0);

const stack = new Int32Array(256); // data stack, values are 32-bit two's complement
const calls = new Int32Array(64); // return addresses
const memory = new Int32Array(256); // 256 words, all zero
const out = []; // output bytes, at most 65536
let sp = 0, cp = 0, ip = 0, pc = 0, steps = 0, res = 0;

run: while (true) {
  if (steps >= 1000000) { res = 10; break; } // step limit
  if (pc < 0 || pc >= prog.length) { res = 9; break; } // pc outside the program
  const opc = prog[pc];
  const meta = T[opc];
  if (meta === undefined) { res = 5; break; } // unknown opcode
  const immLen = meta[2];
  if (pc + 1 + immLen > prog.length) { res = 9; break; } // immediate cut off
  if (sp < meta[0]) { res = 2; break; } // stack underflow
  if (sp - meta[0] + meta[1] > 256) { res = 3; break; } // stack overflow

  const nx = pc + 1 + immLen; // the address after this instruction
  const b1 = immLen > 0 ? prog[pc + 1] : 0;
  const w2 = immLen > 1 ? b1 | (prog[pc + 2] << 8) : 0;
  const s8 = (b1 << 24) >> 24;
  const s16 = (w2 << 16) >> 16;
  const s32 = immLen > 3 ? w2 | (prog[pc + 3] << 16) | (prog[pc + 4] << 24) : 0;
  steps++;
  pc = nx;

  switch (opc) {
    case 0x00: res = 0; break run; // HALT
    case 0x01: stack[sp++] = s8; break; // PUSH8, sign-extended
    case 0x02: stack[sp++] = s32; break; // PUSH32
    case 0x03: sp--; break; // POP
    case 0x04: stack[sp] = stack[sp - 1]; sp++; break; // DUP
    case 0x05: { const t = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = t; break; } // SWAP
    case 0x06: stack[sp] = stack[sp - 2]; sp++; break; // OVER
    case 0x07: { // ROT: ( a b c -- b c a )
      const t = stack[sp - 3];
      stack[sp - 3] = stack[sp - 2];
      stack[sp - 2] = stack[sp - 1];
      stack[sp - 1] = t;
      break;
    }
    case 0x10: stack[sp - 2] = (stack[sp - 2] + stack[sp - 1]) | 0; sp--; break; // ADD
    case 0x11: stack[sp - 2] = (stack[sp - 2] - stack[sp - 1]) | 0; sp--; break; // SUB
    case 0x12: stack[sp - 2] = Math.imul(stack[sp - 2], stack[sp - 1]); sp--; break; // MUL
    case 0x13: case 0x14: { // DIV, MOD: signed, truncated toward zero
      const a = stack[sp - 2], b = stack[sp - 1];
      if (b === 0) { res = 4; break run; }
      stack[sp - 2] = opc === 0x13 ? (a / b) | 0 : (a % b) | 0;
      sp--;
      break;
    }
    case 0x15: case 0x16: { // DIVU, MODU: both operands unsigned, result read back as signed
      const a = stack[sp - 2] >>> 0, b = stack[sp - 1] >>> 0;
      if (b === 0) { res = 4; break run; }
      stack[sp - 2] = opc === 0x15 ? (a / b) | 0 : (a % b) | 0;
      sp--;
      break;
    }
    case 0x17: stack[sp - 1] = -stack[sp - 1] | 0; break; // NEG
    case 0x18: stack[sp - 2] = stack[sp - 2] & stack[sp - 1]; sp--; break; // AND
    case 0x19: stack[sp - 2] = stack[sp - 2] | stack[sp - 1]; sp--; break; // OR
    case 0x1a: stack[sp - 2] = stack[sp - 2] ^ stack[sp - 1]; sp--; break; // XOR
    case 0x1b: stack[sp - 1] = ~stack[sp - 1]; break; // NOT
    case 0x1c: stack[sp - 2] = stack[sp - 2] << (stack[sp - 1] & 31); sp--; break; // SHL
    case 0x1d: stack[sp - 2] = stack[sp - 2] >> (stack[sp - 1] & 31); sp--; break; // SHR, arithmetic
    case 0x1e: stack[sp - 2] = (stack[sp - 2] >>> (stack[sp - 1] & 31)) | 0; sp--; break; // SHRU, logical
    case 0x20: stack[sp - 2] = stack[sp - 2] === stack[sp - 1] ? 1 : 0; sp--; break; // EQ
    case 0x21: stack[sp - 2] = stack[sp - 2] < stack[sp - 1] ? 1 : 0; sp--; break; // LT, signed
    case 0x22: stack[sp - 2] = (stack[sp - 2] >>> 0) < (stack[sp - 1] >>> 0) ? 1 : 0; sp--; break; // LTU
    case 0x30: pc = nx + s16; break; // JMP
    case 0x31: if (stack[--sp] === 0) pc = nx + s16; break; // JZ
    case 0x32: if (stack[--sp] !== 0) pc = nx + s16; break; // JNZ
    case 0x33: // CALL
      if (cp >= 64) { res = 7; break run; }
      calls[cp++] = nx;
      pc = w2;
      break;
    case 0x34: // RET
      if (cp === 0) { res = 8; break run; }
      pc = calls[--cp];
      break;
    case 0x40: { // LOAD
      const addr = stack[sp - 1];
      if (addr < 0 || addr > 255) { res = 6; break run; }
      stack[sp - 1] = memory[addr];
      break;
    }
    case 0x41: { // STORE: ( v addr -- )
      const addr = stack[sp - 1];
      if (addr < 0 || addr > 255) { res = 6; break run; }
      memory[addr] = stack[sp - 2];
      sp -= 2;
      break;
    }
    case 0x50: { // PRINT, decimal ASCII
      const text = String(stack[--sp]);
      if (out.length + text.length > 65536) { res = 11; break run; }
      for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
      break;
    }
    case 0x51: { // PUTC
      const v = stack[--sp] & 255;
      if (out.length >= 65536) { res = 11; break run; }
      out.push(v);
      break;
    }
    case 0x52: stack[sp++] = ip < input.length ? input[ip++] : -1; break; // IN
    case 0x53: res = stack[--sp] & 255; break run; // EXIT
  }
}

fs.mkdirSync(dirOut, { recursive: true });
fs.writeFileSync(path.join(dirOut, "stdout.bin"), Buffer.from(out));
fs.writeFileSync(path.join(dirOut, "exit.txt"), String(res) + "\n");
