import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FaPlay,
  FaStepForward,
  FaRedo,
  FaPause,
  FaLock,
  FaLockOpen,
  FaShareAlt,
  FaBan,
  FaTerminal,
  FaLayerGroup,
} from "react-icons/fa";
import { GiPadlock } from "react-icons/gi";

/**
 * RustVisualizer
 * ------------------------------------------------------------------
 * A split-pane playground: Rust-ish source on the left, a live
 * ownership / stack visualization on the right. Not a real Rust
 * interpreter — a small heuristic engine that recognizes common
 * ownership patterns (move, copy, borrow, borrow-mut, println!,
 * function calls) so beginners can *see* what the borrow checker
 * is reasoning about.
 *
 * Drop this file into a React + Tailwind + framer-motion +
 * react-icons project. No other setup required.
 * ------------------------------------------------------------------
 */

const DEFAULT_CODE = `fn main() {
    let s1 = String::from("hello");
    let s2 = s1;

    println!("{}", s2);

    let x = 5;
    let y = x;
    println!("{} {}", x, y);

    let s3 = String::from("world");
    let len = calculate_length(s3);

    let s4 = String::from("borrow me");
    let r1 = &s4;
    println!("{}", r1);
}`;

// ---- non-Copy ("movable") type detection ---------------------------------
const MOVABLE_HINTS = ["String", "Vec", "Box", "HashMap", "String::from"];

function looksMovable(rhs, knownTypes) {
  if (/String::from|\.to_string\(\)|to_owned\(\)/.test(rhs)) return "String";
  if (/vec!\s*\[/.test(rhs)) return "Vec";
  if (/Box::new/.test(rhs)) return "Box";
  const bareIdent = rhs.trim().match(/^[a-zA-Z_]\w*$/);
  if (bareIdent && knownTypes[bareIdent[0]]) return knownTypes[bareIdent[0]];
  return null;
}

function valueLabel(rhs) {
  const str = rhs.match(/String::from\("([^"]*)"\)|"([^"]*)"\.to_string\(\)/);
  if (str) return `"${str[1] ?? str[2]}"`;
  const lit = rhs.match(/"([^"]*)"/);
  if (lit) return `"${lit[1]}"`;
  const vec = rhs.match(/vec!\s*(\[[^\]]*\])/);
  if (vec) return vec[1];
  const num = rhs.match(/^-?\d+(\.\d+)?/);
  if (num) return num[0];
  return rhs.trim();
}

// ---- tiny line-by-line "interpreter" --------------------------------------
function buildSteps(code) {
  const rawLines = code.split("\n");
  const steps = [];
  const knownTypes = {}; // varName -> type label ('String' | 'Copy' | ...)

  rawLines.forEach((raw, idx) => {
    const line = raw.trim();
    const lineNo = idx + 1;
    if (!line || line === "{" || line === "}" || /^fn\s+main/.test(line) || line.startsWith("//")) {
      return;
    }

    // let [mut] name [: Type] = expr;
    let m = line.match(/^let\s+(mut\s+)?([a-zA-Z_]\w*)\s*(?::\s*[\w<>:&' ]+)?\s*=\s*(.+);?$/);
    if (m) {
      const [, mut, name, rhsRaw] = m;
      const rhs = rhsRaw.replace(/;$/, "");

      // borrow: &mut ident / &ident
      const borrowMut = rhs.match(/^&mut\s+([a-zA-Z_]\w*)/);
      const borrow = rhs.match(/^&([a-zA-Z_]\w*)/);
      if (borrowMut || borrow) {
        const target = (borrowMut || borrow)[1];
        steps.push({
          lineNo,
          code: line,
          type: "borrow",
          name,
          target,
          mutable: !!borrowMut,
        });
        knownTypes[name] = "&" + (knownTypes[target] || "T");
        return;
      }

      const movableType = looksMovable(rhs, knownTypes);
      const bareIdent = rhs.trim().match(/^[a-zA-Z_]\w*$/);

      if (bareIdent && movableType) {
        // moving another variable's ownership into `name`
        steps.push({
          lineNo,
          code: line,
          type: "move",
          from: bareIdent[0],
          to: name,
          valueType: movableType,
          mutable: !!mut,
        });
        knownTypes[name] = movableType;
        return;
      }

      if (bareIdent && !movableType) {
        // Copy type (integers, bool, etc.)
        steps.push({
          lineNo,
          code: line,
          type: "copy",
          from: bareIdent[0],
          to: name,
          mutable: !!mut,
        });
        knownTypes[name] = "Copy";
        return;
      }

      // fresh binding: literal, String::from, vec!, function-call result...
      const fnCall = rhs.match(/^([a-zA-Z_]\w*)\(([^)]*)\)$/);
      if (fnCall) {
        const [, fnName, argsRaw] = fnCall;
        const args = argsRaw
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        steps.push({
          lineNo,
          code: line,
          type: "call-assign",
          fnName,
          args,
          to: name,
          resultType: movableType || "Copy",
          mutable: !!mut,
        });
        knownTypes[name] = movableType || "Copy";
        return;
      }

      steps.push({
        lineNo,
        code: line,
        type: "bind",
        name,
        value: valueLabel(rhs),
        valueType: movableType || "Copy",
        mutable: !!mut,
      });
      knownTypes[name] = movableType || "Copy";
      return;
    }

    // println!(...)
    m = line.match(/^println!\((.+)\);?$/);
    if (m) {
      const inner = m[1];
      const parts = inner.split(/,(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.trim());
      const fmt = parts[0];
      const args = parts.slice(1);
      steps.push({ lineNo, code: line, type: "print", fmt, args });
      return;
    }

    // bare function-call statement: foo(a, b);
    m = line.match(/^([a-zA-Z_]\w*)\(([^)]*)\);?$/);
    if (m) {
      const [, fnName, argsRaw] = m;
      const args = argsRaw
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      steps.push({ lineNo, code: line, type: "call", fnName, args });
      return;
    }

    steps.push({ lineNo, code: line, type: "noop" });
  });

  return steps;
}

// ---- visual state reducer ---------------------------------------------
function applyStep(state, step) {
  const vars = { ...state.vars };
  const log = [...state.log];
  let flash = null;

  const dropVar = (name) => {
    if (vars[name]) vars[name] = { ...vars[name], state: "moved" };
  };

  switch (step.type) {
    case "bind": {
      vars[step.name] = {
        name: step.name,
        value: step.value,
        valueType: step.valueType,
        mutable: step.mutable,
        state: "owned",
        borrowedBy: [],
      };
      flash = { kind: "new", name: step.name };
      break;
    }
    case "copy": {
      const src = vars[step.from];
      vars[step.to] = {
        name: step.to,
        value: src ? src.value : "?",
        valueType: "Copy",
        mutable: step.mutable,
        state: "owned",
        borrowedBy: [],
      };
      flash = { kind: "copy", from: step.from, to: step.to };
      break;
    }
    case "move": {
      const src = vars[step.from];
      vars[step.to] = {
        name: step.to,
        value: src ? src.value : "?",
        valueType: step.valueType,
        mutable: step.mutable,
        state: "owned",
        borrowedBy: [],
      };
      if (src) vars[step.from] = { ...src, state: "moved" };
      flash = { kind: "move", from: step.from, to: step.to };
      break;
    }
    case "borrow": {
      const target = vars[step.target];
      vars[step.name] = {
        name: step.name,
        value: target ? `→ ${step.target}` : "?",
        valueType: step.mutable ? "&mut" : "&",
        mutable: false,
        state: "owned",
        borrowedBy: [],
        borrowsFrom: step.target,
      };
      if (target) {
        vars[step.target] = {
          ...target,
          state: step.mutable ? "borrowed-mut" : "borrowed",
          borrowedBy: [...(target.borrowedBy || []), step.name],
        };
      }
      flash = { kind: "borrow", from: step.target, to: step.name, mutable: step.mutable };
      break;
    }
    case "call-assign": {
      step.args.forEach((a) => {
        if (vars[a] && vars[a].valueType !== "Copy" && !vars[a].valueType?.startsWith("&")) {
          dropVar(a);
        }
      });
      vars[step.to] = {
        name: step.to,
        value: `${step.fnName}(...)`,
        valueType: step.resultType,
        mutable: step.mutable,
        state: "owned",
        borrowedBy: [],
      };
      flash = { kind: "call", fn: step.fnName, args: step.args };
      break;
    }
    case "call": {
      step.args.forEach((a) => {
        if (vars[a] && vars[a].valueType !== "Copy" && !vars[a].valueType?.startsWith("&")) {
          dropVar(a);
        }
      });
      flash = { kind: "call", fn: step.fnName, args: step.args };
      break;
    }
    case "print": {
      const rendered = step.fmt
        .replace(/^"|"$/g, "")
        .replace(/\{\}/g, () => {
          const argName = step.args.shift();
          const v = vars[argName];
          if (v && v.state === "moved") {
            return `⚠ use of moved value \`${argName}\``;
          }
          return v ? v.value : argName ?? "";
        });
      const hasError = /use of moved value/.test(rendered);
      log.push({ text: rendered, error: hasError });
      flash = { kind: "print", error: hasError };
      break;
    }
    default:
      break;
  }

  return { vars, log, flash };
}

// ---- small presentational bits --------------------------------------------

const stateStyles = {
  owned: {
    border: "border-violet-500/40",
    ring: "shadow-[0_0_0_1px_rgba(155,107,255,0.15)]",
    badge: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    label: "owned",
  },
  moved: {
    border: "border-white/5",
    ring: "",
    badge: "bg-white/5 text-zinc-500 border-white/10",
    label: "moved",
  },
  borrowed: {
    border: "border-zinc-400/40",
    ring: "shadow-[0_0_0_1px_rgba(212,212,216,0.12)]",
    badge: "bg-zinc-400/10 text-zinc-300 border-zinc-400/30",
    label: "borrowed",
  },
  "borrowed-mut": {
    border: "border-fuchsia-400/40",
    ring: "shadow-[0_0_0_1px_rgba(232,121,249,0.15)]",
    badge: "bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-400/30",
    label: "borrowed mut",
  },
};

function VariableCard({ v }) {
  const style = stateStyles[v.state] || stateStyles.owned;
  const isMoved = v.state === "moved";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 340, damping: 28 }}
      className={`relative rounded-lg border ${style.border} ${style.ring} bg-[#151320] px-3.5 py-3 flex flex-col gap-1.5 min-w-[150px]`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className={`font-mono text-[13px] ${isMoved ? "text-zinc-600 line-through" : "text-zinc-100"}`}>
            {v.name}
          </span>
          {v.mutable && !isMoved && (
            <span className="text-[9px] tracking-wide text-fuchsia-400/70 font-mono">mut</span>
          )}
        </div>
        <span className={`text-[9px] px-1.5 py-0.5 rounded border ${style.badge} font-mono leading-none`}>
          {style.label}
        </span>
      </div>

      <div className={`font-mono text-[12.5px] ${isMoved ? "text-zinc-700" : "text-violet-200/90"} truncate`}>
        {isMoved ? "— value moved —" : v.value}
      </div>

      <div className="text-[10px] font-mono text-zinc-500">{v.valueType || "Copy"}</div>

      {v.borrowedBy && v.borrowedBy.length > 0 && (
        <div className="flex items-center gap-1 mt-0.5">
          <FaShareAlt className="text-zinc-500" size={9} />
          <span className="text-[10px] font-mono text-zinc-500">
            borrowed by {v.borrowedBy.join(", ")}
          </span>
        </div>
      )}

      {isMoved && (
        <FaBan className="absolute top-2.5 right-2.5 text-zinc-700" size={10} style={{ display: "none" }} />
      )}
    </motion.div>
  );
}

function LineNumbers({ count, current, onJump }) {
  return (
    <div className="select-none text-right pr-3 pt-4 pb-4 font-mono text-[13px] leading-[22px] text-zinc-600">
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
        <div
          key={n}
          onClick={() => onJump && onJump(n)}
          className={`cursor-default px-1 rounded transition-colors ${
            n === current ? "text-violet-300 bg-violet-500/10" : ""
          }`}
        >
          {n}
        </div>
      ))}
    </div>
  );
}

export default function RustVisualizer() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [vars, setVars] = useState({});
  const [log, setLog] = useState([]);
  const [flash, setFlash] = useState(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playTimer = useRef(null);

  const steps = useMemo(() => buildSteps(code), [code]);
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const currentLine = stepIndex > 0 ? steps[stepIndex - 1]?.lineNo : null;
  const isDone = stepIndex >= steps.length;

  const reset = useCallback(() => {
    setVars({});
    setLog([]);
    setFlash(null);
    setStepIndex(0);
    setIsPlaying(false);
  }, []);

  // re-parse from scratch whenever the code changes
  useEffect(() => {
    reset();
  }, [code, reset]);

  const advance = useCallback(() => {
    setStepIndex((i) => {
      if (i >= steps.length) {
        setIsPlaying(false);
        return i;
      }
      const step = steps[i];
      setVars((prevVars) => {
        const { vars: nextVars, log: nextLog, flash: nextFlash } = applyStep(
          { vars: prevVars, log, flash: null },
          step
        );
        setLog(nextLog);
        setFlash(nextFlash);
        return nextVars;
      });
      return i + 1;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, log]);

  useEffect(() => {
    if (!isPlaying) return;
    if (stepIndex >= steps.length) {
      setIsPlaying(false);
      return;
    }
    playTimer.current = setTimeout(advance, 850);
    return () => clearTimeout(playTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, stepIndex, steps.length]);

  const varList = Object.values(vars);

  return (
    <div className="w-full h-full min-h-[640px] bg-[#0a0912] text-zinc-200 flex flex-col font-sans">
      {/* header */}
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] bg-[#0d0c16]">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
            <span className="text-[11px] font-bold text-white">R</span>
          </div>
          <h1 className="text-[14px] font-medium text-zinc-100 tracking-tight">Rust Ownership Visualizer</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPlaying((p) => (isDone ? p : !p))}
            disabled={isDone}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:bg-white/5 disabled:text-zinc-600 text-white text-[12.5px] font-medium transition-colors"
          >
            {isPlaying ? <FaPause size={10} /> : <FaPlay size={10} />}
            {isPlaying ? "Pause" : "Run"}
          </button>
          <button
            onClick={advance}
            disabled={isDone}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 text-zinc-200 text-[12.5px] font-medium transition-colors"
          >
            <FaStepForward size={10} />
            Step
          </button>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-zinc-200 text-[12.5px] font-medium transition-colors"
          >
            <FaRedo size={10} />
            Reset
          </button>
        </div>
      </header>

      {/* body */}
      <div className="flex-1 flex min-h-0">
        {/* left: code */}
        <div className="w-1/2 border-r border-white/[0.06] flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-white/[0.06] text-[11px] font-mono text-zinc-500 flex items-center justify-between bg-[#0d0c16]">
            <span>main.rs</span>
            <span className="text-zinc-600">
              step {Math.min(stepIndex, steps.length)}/{steps.length}
            </span>
          </div>
          <div className="flex-1 overflow-auto flex bg-[#0a0912]">
            <LineNumbers count={lineCount} current={currentLine} />
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              className="flex-1 resize-none bg-transparent outline-none font-mono text-[13px] leading-[22px] text-zinc-200 pt-4 pb-4 pr-4 caret-violet-400"
            />
          </div>
        </div>

        {/* right: visualization */}
        <div className="w-1/2 flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-white/[0.06] text-[11px] font-mono text-zinc-500 flex items-center gap-2 bg-[#0d0c16]">
            <FaLayerGroup size={10} />
            <span>stack — main()</span>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {currentLine && (
              <div className="mb-3 text-[11.5px] font-mono text-zinc-500">
                executing <span className="text-violet-300">line {currentLine}</span>
                <span className="text-zinc-600">  ·  {steps[stepIndex - 1]?.code}</span>
              </div>
            )}

            {varList.length === 0 ? (
              <div className="h-full flex items-center justify-center text-zinc-600 text-[13px]">
                Press <span className="mx-1 text-zinc-400">Step</span> or{" "}
                <span className="mx-1 text-zinc-400">Run</span> to start executing.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <AnimatePresence mode="popLayout">
                  {varList.map((v) => (
                    <VariableCard key={v.name} v={v} />
                  ))}
                </AnimatePresence>
              </div>
            )}

            <AnimatePresence>
              {flash && flash.kind === "move" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-3 text-[11.5px] font-mono text-violet-300/80 flex items-center gap-1.5"
                >
                  <FaLockOpen size={9} />
                  ownership of <span className="text-violet-200">{flash.from}</span> moved into{" "}
                  <span className="text-violet-200">{flash.to}</span> — {flash.from} is no longer valid
                </motion.div>
              )}
              {flash && flash.kind === "borrow" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-3 text-[11.5px] font-mono text-zinc-400 flex items-center gap-1.5"
                >
                  {flash.mutable ? <FaLockOpen size={9} /> : <FaLock size={9} />}
                  <span className="text-zinc-200">{flash.to}</span> borrows{" "}
                  {flash.mutable ? "mutably" : "immutably"} from{" "}
                  <span className="text-zinc-200">{flash.from}</span>
                </motion.div>
              )}
              {flash && flash.kind === "call" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-3 text-[11.5px] font-mono text-zinc-400"
                >
                  called <span className="text-zinc-200">{flash.fn}(...)</span>
                  {flash.args.length > 0 && (
                    <>
                      {" "}
                      — argument{flash.args.length > 1 ? "s" : ""}{" "}
                      <span className="text-zinc-200">{flash.args.join(", ")}</span> passed by value
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* console */}
          <div className="border-t border-white/[0.06] bg-[#0d0c16]">
            <div className="px-4 py-2 text-[11px] font-mono text-zinc-500 flex items-center gap-2 border-b border-white/[0.06]">
              <FaTerminal size={9} />
              <span>console</span>
            </div>
            <div className="p-3.5 h-32 overflow-auto font-mono text-[12.5px] space-y-1">
              {log.length === 0 ? (
                <div className="text-zinc-700">no output yet</div>
              ) : (
                log.map((l, i) => (
                  <div key={i} className={l.error ? "text-rose-400/90" : "text-zinc-300"}>
                    {l.error ? "error: " : "> "}
                    {l.text}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}