// demo.ts
// Self-contained staged monomorphisation demo:
// - AST lowers to runtime-template IR
// - Runtime-template IR references indexed value slots
// - A linear CT specialization pass fills unresolved slots
// - CT blocks support basic reflection and trait resolution
// - Instantiation injects concrete offsets, types, and method symbols

// -----------------------------
// Types
// -----------------------------

type Type =
  | { kind: "prim"; name: "Int" | "Float" | "Bool" }
  | { kind: "struct"; name: string }
  | { kind: "generic"; name: string };

const Int: Type = { kind: "prim", name: "Int" };
const Float: Type = { kind: "prim", name: "Float" };
const Bool: Type = { kind: "prim", name: "Bool" };
const Point: Type = { kind: "struct", name: "Point" };
const Pixel: Type = { kind: "struct", name: "Pixel" };
const Pair: Type = { kind: "struct", name: "Pair" };
const PointF: Type = { kind: "struct", name: "PointF" };
const Flagged: Type = { kind: "struct", name: "Flagged" };

function showType(t: Type): string {
  switch (t.kind) {
    case "prim":
      return t.name;
    case "struct":
      return t.name;
    case "generic":
      return t.name;
  }
}

function sameType(a: Type, b: Type): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// -----------------------------
// AST
// -----------------------------

type ExprAst =
  | { kind: "var"; name: string }
  | { kind: "field"; base: ExprAst; field: string }
  | { kind: "binary"; op: "+"; left: ExprAst; right: ExprAst }
  | { kind: "call"; fn: string; typeArgs: Type[]; args: ExprAst[] };

type FnAst = {
  name: string;
  typeParams: string[];
  params: { name: string; ty: Type }[];
  returnTy: Type;
  body: ExprAst;
};

// Example:
//
// fn addX<T>(a: T, b: T) -> Int {
//   return a.x + b.x
// }

const addXAst: FnAst = {
  name: "addX",
  typeParams: ["T"],
  params: [
    { name: "a", ty: { kind: "generic", name: "T" } },
    { name: "b", ty: { kind: "generic", name: "T" } },
  ],
  returnTy: Int,
  body: {
    kind: "binary",
    op: "+",
    left: {
      kind: "field",
      base: { kind: "var", name: "a" },
      field: "x",
    },
    right: {
      kind: "field",
      base: { kind: "var", name: "b" },
      field: "x",
    },
  },
};

const genericInnerAst: FnAst = {
  name: "genericInner",
  typeParams: ["T"],
  params: [{ name: "x", ty: { kind: "generic", name: "T" } }],
  returnTy: { kind: "generic", name: "T" },
  body: { kind: "var", name: "x" },
};

const genericOuterAst: FnAst = {
  name: "genericOuter",
  typeParams: ["T"],
  params: [{ name: "x", ty: { kind: "generic", name: "T" } }],
  returnTy: { kind: "generic", name: "T" },
  body: {
    kind: "call",
    fn: "genericInner",
    typeArgs: [{ kind: "generic", name: "T" }],
    args: [{ kind: "var", name: "x" }],
  },
};

const regularFnAst: FnAst = {
  name: "regularFn",
  typeParams: [],
  params: [{ name: "x", ty: Int }],
  returnTy: Int,
  body: {
    kind: "call",
    fn: "genericOuter",
    typeArgs: [Int],
    args: [{ kind: "var", name: "x" }],
  },
};

const badArityCallAst: FnAst = {
  name: "badArityCall",
  typeParams: [],
  params: [{ name: "x", ty: Int }],
  returnTy: Int,
  body: {
    kind: "call",
    fn: "genericOuter",
    typeArgs: [],
    args: [{ kind: "var", name: "x" }],
  },
};

const badUnknownCallAst: FnAst = {
  name: "badUnknownCall",
  typeParams: [],
  params: [{ name: "x", ty: Int }],
  returnTy: Int,
  body: {
    kind: "call",
    fn: "doesNotExist",
    typeArgs: [Int],
    args: [{ kind: "var", name: "x" }],
  },
};

// -----------------------------
// Template IR
// -----------------------------

type SymbolId = string;
type TypeIdx = number;
type ConstIdx = number;
type SymbolIdx = number;
type InstrIdx = number;

type WhereClause =
  | {
      kind: "trait_bound";
      typeExpr: Type;
      trait: string;
    }
  | {
      kind: "assoc_eq";
      typeExpr: Type;
      trait: string;
      assocType: string;
      equals: Type;
    };

type MethodSig = {
  name: string;
  typeParams: string[];
  params: { name: string; ty: Type }[];
  returnTy: Type;
  where: WhereClause[];
};

type TraitDef = {
  name: string;
  typeParams: string[];
  assocTypes: string[];
  methods: Record<string, MethodSig>;
};

type ImplDef = {
  trait: string;
  forType: Type;
  where: WhereClause[];
  methods: Record<string, SymbolId>;
  assocTypes: Record<string, Type>;
  methodSigs: Record<string, MethodSig>;
};

type TraitRef = {
  trait: string;
  forType: Type;
};

type AssocTypeRef = {
  traitRef: TraitRef;
  name: string;
  ty: Type;
};

type FnSigRef = {
  symbol: SymbolId;
  sig: MethodSig;
};

type RuntimeInstr =
  | { op: "param"; name: string; tyIdx: TypeIdx }
  | { op: "field_ptr"; out: string; base: string; offsetIdx: ConstIdx }
  | { op: "load"; out: string; ptr: string; tyIdx: TypeIdx }
  | { op: "call"; out: string; fnIdx: SymbolIdx; args: string[] }
  | { op: "splice"; instrIdx: InstrIdx }
  | { op: "return"; value: string };

type CtWriteTarget =
  | { kind: "type"; idx: TypeIdx }
  | { kind: "const"; idx: ConstIdx }
  | { kind: "symbol"; idx: SymbolIdx }
  | { kind: "instr"; idx: InstrIdx };

type CtWrite = {
  target: CtWriteTarget;
  instrs: CtInstr[];
};

type TemplateFunction = {
  id: string;
  typeParams: string[];
  runtime: RuntimeInstr[];
  specialize: CtWrite[];
  typeValues: Array<Type | null>;
  constValues: Array<number | null>;
  symbolValues: Array<SymbolId | null>;
  instrValues: Array<ConcreteInstr[] | null>;
};

type ConcreteInstr =
  | { op: "param"; name: string; ty: Type }
  | { op: "field_ptr"; out: string; base: string; offset: number }
  | { op: "load"; out: string; ptr: string; ty: Type }
  | { op: "call"; out: string; fn: SymbolId; args: string[] }
  | { op: "return"; value: string };

// -----------------------------
// Compile-time IR
// -----------------------------

type CtValue =
  | { kind: "type"; value: Type }
  | { kind: "layout"; value: Layout }
  | { kind: "const"; value: number }
  | { kind: "impl"; value: ImplDef }
  | { kind: "symbol"; value: SymbolId }
  | { kind: "trait_ref"; value: TraitRef }
  | { kind: "assoc_type"; value: AssocTypeRef }
  | { kind: "fn_sig"; value: FnSigRef }
  | { kind: "instr_chunk"; value: ConcreteInstr[] };

type SpecializationState = {
  typeValues: Array<Type | null>;
  constValues: Array<number | null>;
  symbolValues: Array<SymbolId | null>;
  instrValues: Array<ConcreteInstr[] | null>;
  typeWrites: Set<number>;
  constWrites: Set<number>;
  symbolWrites: Set<number>;
  instrWrites: Set<number>;
};

type CtInstr =
  | { op: "get_type_arg"; out: string; index: number }
  | { op: "resolve_type_expr"; out: string; typeIdx: TypeIdx }
  | { op: "get_layout"; out: string; typeReg: string }
  | { op: "field_offset"; out: string; layoutReg: string; field: string }
  | { op: "field_type"; out: string; layoutReg: string; field: string }
  | { op: "resolve_trait"; out: string; trait: string; typeReg: string }
  | { op: "trait_method"; out: string; implReg: string; method: string }
  | { op: "prove_trait_bound"; out: string; trait: string; typeReg: string }
  | {
      op: "project_assoc_type";
      out: string;
      traitRefReg: string;
      assocType: string;
    }
  | {
      op: "resolve_method_call";
      out: string;
      traitRefReg: string;
      method: string;
    }
  | { op: "resolve_function_symbol"; out: string; fn: string }
  | { op: "request_fn_instantiation"; fnReg: string; typeArgRegs: string[] }
  | {
      op: "instantiate_generic_symbol";
      out: string;
      symbolReg: string;
      typeArgRegs: string[];
    }
  | { op: "field_count"; out: string; layoutReg: string }
  | { op: "field_offset_at"; out: string; layoutReg: string; indexReg: string }
  | { op: "field_type_at"; out: string; layoutReg: string; indexReg: string }
  | { op: "const_lit"; out: string; value: number }
  | { op: "add_const"; out: string; lhsReg: string; rhsReg: string }
  | { op: "branch_lt"; leftReg: string; rightReg: string; target: number }
  | { op: "goto"; target: number }
  | { op: "init_instr_chunk"; out: string }
  | {
      op: "build_instr_chunk";
      out: string;
      base: string;
      offsetReg: string;
      typeReg: string;
      fnReg: string;
      indexReg: string;
      ptrPrefix: string;
      valPrefix: string;
    }
  | { op: "append_instr_chunk"; toReg: string; chunkReg: string }
  | { op: "return"; valueReg: string };

// -----------------------------
// Reflection / trait DB
// -----------------------------

type Layout = {
  size: number;
  align: number;
  fields: Record<string, { offset: number; ty: Type }>;
};

type Impl = ImplDef;

// -----------------------------
// Compiler
// -----------------------------

class Compiler {
  templates = new Map<string, TemplateFunction>();
  traits = new Map<string, TraitDef>();
  layouts = new Map<string, Layout>();
  impls: Impl[] = [];

  emitted = new Map<string, ConcreteInstr[]>();
  queue: { fn: string; typeArgs: Type[] }[] = [];
  done = new Set<string>();

  request(fn: string, typeArgs: Type[]) {
    const key = this.mangle(fn, typeArgs);
    if (!this.done.has(key)) {
      this.queue.push({ fn, typeArgs });
    }
  }

  run() {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const key = this.mangle(item.fn, item.typeArgs);

      if (this.done.has(key)) continue;
      this.done.add(key);

      const template = this.templates.get(item.fn);
      if (!template) throw new Error(`unknown template function ${item.fn}`);

      const concrete = this.instantiate(template, item.typeArgs);
      this.emitted.set(key, concrete);
    }
  }

  instantiate(template: TemplateFunction, typeArgs: Type[]): ConcreteInstr[] {
    const state = this.buildSpecializationState(template, typeArgs);
    this.runSpecializationWrites(template, typeArgs, state);

    const concrete: ConcreteInstr[] = [];
    for (const instr of template.runtime) {
      switch (instr.op) {
        case "param": {
          concrete.push({
            op: "param",
            name: instr.name,
            ty: this.readTypeIdx(state, instr.tyIdx, `param ${instr.name}`),
          });
          break;
        }

        case "field_ptr": {
          concrete.push({
            op: "field_ptr",
            out: instr.out,
            base: instr.base,
            offset: this.readConstIdx(
              state,
              instr.offsetIdx,
              `field_ptr ${instr.out}`,
            ),
          });
          break;
        }

        case "load": {
          concrete.push({
            op: "load",
            out: instr.out,
            ptr: instr.ptr,
            ty: this.readTypeIdx(state, instr.tyIdx, `load ${instr.out}`),
          });
          break;
        }

        case "call": {
          concrete.push({
            op: "call",
            out: instr.out,
            fn: this.readSymbolIdx(state, instr.fnIdx, `call ${instr.out}`),
            args: instr.args,
          });
          break;
        }

        case "splice": {
          const chunk = this.readInstrIdx(
            state,
            instr.instrIdx,
            `splice ${instr.instrIdx}`,
          );
          concrete.push(...chunk);
          break;
        }

        case "return": {
          concrete.push(instr);
          break;
        }
      }
    }

    return concrete;
  }

  buildSpecializationState(
    template: TemplateFunction,
    typeArgs: Type[],
  ): SpecializationState {
    return {
      typeValues: template.typeValues.map((v) =>
        v ? this.substType(template, typeArgs, v) : null,
      ),
      constValues: [...template.constValues],
      symbolValues: [...template.symbolValues],
      instrValues: template.instrValues.map((chunk) =>
        chunk ? [...chunk] : null,
      ),
      typeWrites: new Set<number>(),
      constWrites: new Set<number>(),
      symbolWrites: new Set<number>(),
      instrWrites: new Set<number>(),
    };
  }

  runSpecializationWrites(
    template: TemplateFunction,
    typeArgs: Type[],
    state: SpecializationState,
  ) {
    for (const write of template.specialize) {
      const value = this.evalCtBlock(template, typeArgs, state, write.instrs);

      switch (write.target.kind) {
        case "type": {
          if (
            state.typeWrites.has(write.target.idx) ||
            state.typeValues[write.target.idx] !== null
          ) {
            throw new Error(
              `duplicate specialization write for type idx ${write.target.idx}`,
            );
          }
          if (value.kind === "type") {
            state.typeValues[write.target.idx] = value.value;
          } else if (value.kind === "assoc_type") {
            state.typeValues[write.target.idx] = value.value.ty;
          } else {
            throw new Error(
              `specialization write expected type-like value for idx ${write.target.idx}`,
            );
          }
          state.typeWrites.add(write.target.idx);
          break;
        }

        case "const": {
          if (
            state.constWrites.has(write.target.idx) ||
            state.constValues[write.target.idx] !== null
          ) {
            throw new Error(
              `duplicate specialization write for const idx ${write.target.idx}`,
            );
          }
          if (value.kind !== "const") {
            throw new Error(
              `specialization write expected const value for idx ${write.target.idx}`,
            );
          }
          state.constValues[write.target.idx] = value.value;
          state.constWrites.add(write.target.idx);
          break;
        }

        case "symbol": {
          if (
            state.symbolWrites.has(write.target.idx) ||
            state.symbolValues[write.target.idx] !== null
          ) {
            throw new Error(
              `duplicate specialization write for symbol idx ${write.target.idx}`,
            );
          }
          if (value.kind !== "symbol") {
            throw new Error(
              `specialization write expected symbol value for idx ${write.target.idx}`,
            );
          }
          state.symbolValues[write.target.idx] = value.value;
          state.symbolWrites.add(write.target.idx);
          break;
        }

        case "instr": {
          if (
            state.instrWrites.has(write.target.idx) ||
            state.instrValues[write.target.idx] !== null
          ) {
            throw new Error(
              `duplicate specialization write for instr idx ${write.target.idx}`,
            );
          }
          if (value.kind !== "instr_chunk") {
            throw new Error(
              `specialization write expected instruction chunk for idx ${write.target.idx}`,
            );
          }
          state.instrValues[write.target.idx] = value.value;
          state.instrWrites.add(write.target.idx);
          break;
        }
      }
    }
  }

  readTypeIdx(state: SpecializationState, idx: TypeIdx, context: string): Type {
    const value = state.typeValues[idx];
    if (value === null || value === undefined) {
      throw new Error(
        `unresolved type idx ${idx} while instantiating ${context}`,
      );
    }
    return value;
  }

  readConstIdx(
    state: SpecializationState,
    idx: ConstIdx,
    context: string,
  ): number {
    const value = state.constValues[idx];
    if (value === null || value === undefined) {
      throw new Error(
        `unresolved const idx ${idx} while instantiating ${context}`,
      );
    }
    return value;
  }

  readSymbolIdx(
    state: SpecializationState,
    idx: SymbolIdx,
    context: string,
  ): SymbolId {
    const value = state.symbolValues[idx];
    if (value === null || value === undefined) {
      throw new Error(
        `unresolved symbol idx ${idx} while instantiating ${context}`,
      );
    }
    return value;
  }

  readInstrIdx(
    state: SpecializationState,
    idx: InstrIdx,
    context: string,
  ): ConcreteInstr[] {
    const value = state.instrValues[idx];
    if (value === null || value === undefined) {
      throw new Error(
        `unresolved instruction idx ${idx} while instantiating ${context}`,
      );
    }
    return value;
  }

  evalCtBlock(
    template: TemplateFunction,
    typeArgs: Type[],
    state: SpecializationState,
    instrs: CtInstr[],
  ): CtValue {
    const regs = new Map<string, CtValue>();

    const read = (name: string): CtValue => {
      const value = regs.get(name);
      if (!value) throw new Error(`missing CT register ${name}`);
      return value;
    };

    const expectConst = (reg: string): number => {
      const value = read(reg);
      if (value.kind !== "const")
        throw new Error(`expected const in register ${reg}`);
      return value.value;
    };

    const getFieldByIndex = (
      layout: Layout,
      index: number,
    ): { name: string; offset: number; ty: Type } => {
      const entries = Object.entries(layout.fields);
      const field = entries[index];
      if (!field) throw new Error(`unknown field index ${index}`);
      const [name, data] = field;
      return { name, offset: data.offset, ty: data.ty };
    };

    const ensureTarget = (target: number): number => {
      if (!Number.isInteger(target) || target < 0 || target >= instrs.length) {
        throw new Error(`invalid jump target ${target}`);
      }
      return target;
    };

    let nextPc = 0;
    for (let pc = 0; pc < instrs.length; pc = nextPc) {
      const instr = instrs[pc];
      nextPc = pc + 1;

      switch (instr.op) {
        case "get_type_arg": {
          regs.set(instr.out, {
            kind: "type",
            value: typeArgs[instr.index],
          });
          break;
        }

        case "resolve_type_expr": {
          regs.set(instr.out, {
            kind: "type",
            value: this.readTypeIdx(state, instr.typeIdx, "resolve_type_expr"),
          });
          break;
        }

        case "get_layout": {
          const t = read(instr.typeReg);
          if (t.kind !== "type") throw new Error("expected type");

          regs.set(instr.out, {
            kind: "layout",
            value: this.getLayout(t.value),
          });
          break;
        }

        case "field_offset": {
          const l = read(instr.layoutReg);
          if (l.kind !== "layout") throw new Error("expected layout");

          const field = l.value.fields[instr.field];
          if (!field) throw new Error(`unknown field ${instr.field}`);

          regs.set(instr.out, {
            kind: "const",
            value: field.offset,
          });
          break;
        }

        case "field_type": {
          const l = read(instr.layoutReg);
          if (l.kind !== "layout") throw new Error("expected layout");

          const field = l.value.fields[instr.field];
          if (!field) throw new Error(`unknown field ${instr.field}`);

          regs.set(instr.out, {
            kind: "type",
            value: field.ty,
          });
          break;
        }

        case "field_count": {
          const l = read(instr.layoutReg);
          if (l.kind !== "layout") throw new Error("expected layout");
          regs.set(instr.out, {
            kind: "const",
            value: Object.keys(l.value.fields).length,
          });
          break;
        }

        case "field_offset_at": {
          const l = read(instr.layoutReg);
          if (l.kind !== "layout") throw new Error("expected layout");

          const index = expectConst(instr.indexReg);
          const field = getFieldByIndex(l.value, index);
          regs.set(instr.out, {
            kind: "const",
            value: field.offset,
          });
          break;
        }

        case "field_type_at": {
          const l = read(instr.layoutReg);
          if (l.kind !== "layout") throw new Error("expected layout");

          const index = expectConst(instr.indexReg);
          const field = getFieldByIndex(l.value, index);
          regs.set(instr.out, {
            kind: "type",
            value: field.ty,
          });
          break;
        }

        case "const_lit": {
          regs.set(instr.out, {
            kind: "const",
            value: instr.value,
          });
          break;
        }

        case "add_const": {
          const lhs = expectConst(instr.lhsReg);
          const rhs = expectConst(instr.rhsReg);
          regs.set(instr.out, {
            kind: "const",
            value: lhs + rhs,
          });
          break;
        }

        case "branch_lt": {
          const left = expectConst(instr.leftReg);
          const right = expectConst(instr.rightReg);
          if (left < right) {
            nextPc = ensureTarget(instr.target);
          }
          break;
        }

        case "goto": {
          nextPc = ensureTarget(instr.target);
          break;
        }

        case "init_instr_chunk": {
          regs.set(instr.out, {
            kind: "instr_chunk",
            value: [],
          });
          break;
        }

        case "build_instr_chunk": {
          const offset = expectConst(instr.offsetReg);
          const typeVal = read(instr.typeReg);
          if (typeVal.kind !== "type") throw new Error("expected type");
          const fnVal = read(instr.fnReg);
          if (fnVal.kind !== "symbol") throw new Error("expected symbol");
          const index = expectConst(instr.indexReg);
          const ptr = `${instr.ptrPrefix}${index}`;
          const val = `${instr.valPrefix}${index}`;

          regs.set(instr.out, {
            kind: "instr_chunk",
            value: [
              { op: "field_ptr", out: ptr, base: instr.base, offset },
              { op: "load", out: val, ptr, ty: typeVal.value },
              {
                op: "call",
                out: `${instr.valPrefix}_call${index}`,
                fn: fnVal.value,
                args: [val],
              },
            ],
          });
          break;
        }

        case "append_instr_chunk": {
          const target = read(instr.toReg);
          if (target.kind !== "instr_chunk")
            throw new Error("expected instruction chunk target");
          const chunk = read(instr.chunkReg);
          if (chunk.kind !== "instr_chunk")
            throw new Error("expected instruction chunk");
          target.value.push(...chunk.value);
          break;
        }

        case "resolve_trait": {
          const t = read(instr.typeReg);
          if (t.kind !== "type") throw new Error("expected type");

          regs.set(instr.out, {
            kind: "impl",
            value: this.resolveTrait(instr.trait, t.value),
          });
          break;
        }

        case "trait_method": {
          const impl = read(instr.implReg);
          if (impl.kind !== "impl") throw new Error("expected impl");

          const method = impl.value.methods[instr.method];
          if (!method) {
            throw new Error(`trait impl has no method ${instr.method}`);
          }

          regs.set(instr.out, {
            kind: "symbol",
            value: method,
          });
          break;
        }

        case "prove_trait_bound": {
          const t = read(instr.typeReg);
          if (t.kind !== "type") throw new Error("expected type");

          this.resolveTrait(instr.trait, t.value);
          regs.set(instr.out, {
            kind: "trait_ref",
            value: {
              trait: instr.trait,
              forType: t.value,
            },
          });
          break;
        }

        case "project_assoc_type": {
          const traitRef = read(instr.traitRefReg);
          if (traitRef.kind !== "trait_ref")
            throw new Error("expected trait ref");

          const impl = this.resolveTrait(
            traitRef.value.trait,
            traitRef.value.forType,
          );
          const ty = impl.assocTypes[instr.assocType];
          if (!ty) {
            throw new Error(
              `impl ${traitRef.value.trait} for ${showType(traitRef.value.forType)} has no associated type ${instr.assocType}`,
            );
          }

          regs.set(instr.out, {
            kind: "assoc_type",
            value: {
              traitRef: traitRef.value,
              name: instr.assocType,
              ty,
            },
          });
          break;
        }

        case "resolve_method_call": {
          const traitRef = read(instr.traitRefReg);
          if (traitRef.kind !== "trait_ref")
            throw new Error("expected trait ref");

          const impl = this.resolveTrait(
            traitRef.value.trait,
            traitRef.value.forType,
          );
          const method = impl.methods[instr.method];
          if (!method) {
            throw new Error(
              `impl ${traitRef.value.trait} for ${showType(traitRef.value.forType)} has no method ${instr.method}`,
            );
          }

          const sig = impl.methodSigs[instr.method];
          if (sig) {
            regs.set(`${instr.out}_sig`, {
              kind: "fn_sig",
              value: {
                symbol: method,
                sig,
              },
            });
          }

          regs.set(instr.out, {
            kind: "symbol",
            value: method,
          });
          break;
        }

        case "resolve_function_symbol": {
          const callee = this.templates.get(instr.fn);
          if (!callee) throw new Error(`unknown template function ${instr.fn}`);

          regs.set(instr.out, {
            kind: "symbol",
            value: callee.id,
          });
          break;
        }

        case "request_fn_instantiation": {
          const fn = read(instr.fnReg);
          if (fn.kind !== "symbol") throw new Error("expected symbol");

          const callee = this.templates.get(fn.value);
          if (!callee) throw new Error(`unknown template function ${fn.value}`);

          const typeArgsForCall = instr.typeArgRegs.map((reg) => {
            const value = read(reg);
            if (value.kind === "type") return value.value;
            if (value.kind === "assoc_type") return value.value.ty;
            throw new Error("expected type-like register");
          });

          if (typeArgsForCall.length !== callee.typeParams.length) {
            throw new Error(
              `function ${fn.value} expected ${callee.typeParams.length} type args, got ${typeArgsForCall.length}`,
            );
          }

          this.request(callee.id, typeArgsForCall);
          break;
        }

        case "instantiate_generic_symbol": {
          const symbol = read(instr.symbolReg);
          if (symbol.kind !== "symbol") throw new Error("expected symbol");

          const typeArgsForSymbol = instr.typeArgRegs.map((reg) => {
            const value = read(reg);
            if (value.kind === "type") return value.value;
            if (value.kind === "assoc_type") return value.value.ty;
            throw new Error("expected type-like register");
          });

          regs.set(instr.out, {
            kind: "symbol",
            value: this.instantiateSymbol(symbol.value, typeArgsForSymbol),
          });
          break;
        }

        case "return": {
          return read(instr.valueReg);
        }
      }
    }

    throw new Error("CT block did not return");
  }

  getLayout(t: Type): Layout {
    const key = showType(t);
    const layout = this.layouts.get(key);
    if (!layout) throw new Error(`no layout for ${key}`);
    return layout;
  }

  resolveTrait(trait: string, t: Type): Impl {
    const impl = this.impls.find(
      (i) => i.trait === trait && sameType(i.forType, t),
    );
    if (!impl) throw new Error(`no impl ${trait} for ${showType(t)}`);
    return impl;
  }

  instantiateSymbol(symbol: SymbolId, typeArgs: Type[]): SymbolId {
    if (typeArgs.length === 0) return symbol;
    return `${symbol}__${typeArgs.map(showType).join("__")}`;
  }

  substType(template: TemplateFunction, typeArgs: Type[], t: Type): Type {
    if (t.kind !== "generic") return t;

    const index = template.typeParams.indexOf(t.name);
    if (index === -1) return t;

    return typeArgs[index];
  }

  mangle(fn: string, typeArgs: Type[]): string {
    if (typeArgs.length === 0) return fn;
    return `${fn}__${typeArgs.map(showType).join("__")}`;
  }
}

// -----------------------------
// AST lowering
// -----------------------------

type LoweredExpr = {
  reg: string;
  tyIdx: TypeIdx;
};

type LowerCtx = {
  template: TemplateFunction;
  functions: Map<string, FnAst>;
  locals: Map<string, TypeIdx>;
  nextReg(): string;
  allocTypeValue(t: Type): TypeIdx;
  allocConstValue(n: number): ConstIdx;
  allocSymbolValue(s: SymbolId): SymbolIdx;
  allocTypeTarget(instrs: CtInstr[]): TypeIdx;
  allocConstTarget(instrs: CtInstr[]): ConstIdx;
  allocSymbolTarget(instrs: CtInstr[]): SymbolIdx;
  allocInstrTarget(instrs: CtInstr[]): InstrIdx;
};

function lowerFunction(
  ast: FnAst,
  functions: Map<string, FnAst>,
): TemplateFunction {
  let regCounter = 0;

  const template: TemplateFunction = {
    id: ast.name,
    typeParams: ast.typeParams,
    runtime: [],
    specialize: [],
    typeValues: [],
    constValues: [],
    symbolValues: [],
    instrValues: [],
  };

  const ctx: LowerCtx = {
    template,
    functions,
    locals: new Map(),

    nextReg() {
      return `%${regCounter++}`;
    },

    allocTypeValue(t: Type) {
      const idx = template.typeValues.length;
      template.typeValues.push(t);
      return idx;
    },

    allocConstValue(n: number) {
      const idx = template.constValues.length;
      template.constValues.push(n);
      return idx;
    },

    allocSymbolValue(s: SymbolId) {
      const idx = template.symbolValues.length;
      template.symbolValues.push(s);
      return idx;
    },

    allocTypeTarget(instrs: CtInstr[]) {
      const idx = template.typeValues.length;
      template.typeValues.push(null);
      template.specialize.push({
        target: { kind: "type", idx },
        instrs,
      });
      return idx;
    },

    allocConstTarget(instrs: CtInstr[]) {
      const idx = template.constValues.length;
      template.constValues.push(null);
      template.specialize.push({
        target: { kind: "const", idx },
        instrs,
      });
      return idx;
    },

    allocSymbolTarget(instrs: CtInstr[]) {
      const idx = template.symbolValues.length;
      template.symbolValues.push(null);
      template.specialize.push({
        target: { kind: "symbol", idx },
        instrs,
      });
      return idx;
    },

    allocInstrTarget(instrs: CtInstr[]) {
      const idx = template.instrValues.length;
      template.instrValues.push(null);
      template.specialize.push({
        target: { kind: "instr", idx },
        instrs,
      });
      return idx;
    },
  };

  for (const param of ast.params) {
    const tyIdx = ctx.allocTypeValue(param.ty);
    ctx.locals.set(param.name, tyIdx);

    template.runtime.push({
      op: "param",
      name: param.name,
      tyIdx,
    });
  }

  const result = lowerExpr(ast.body, ctx);

  template.runtime.push({
    op: "return",
    value: result.reg,
  });

  return template;
}

function lowerExpr(expr: ExprAst, ctx: LowerCtx): LoweredExpr {
  switch (expr.kind) {
    case "var": {
      const tyIdx = ctx.locals.get(expr.name);
      if (tyIdx === undefined) throw new Error(`unknown local ${expr.name}`);
      return { reg: expr.name, tyIdx };
    }

    case "field":
      return lowerField(expr, ctx);

    case "binary":
      return lowerAdd(expr.left, expr.right, ctx);

    case "call":
      return lowerCall(expr, ctx);
  }
}

function substFnType(
  t: Type,
  callee: FnAst,
  callTypeArgs: TypeIdx[],
  ctx: LowerCtx,
): TypeIdx {
  if (t.kind !== "generic") return ctx.allocTypeValue(t);

  const index = callee.typeParams.indexOf(t.name);
  if (index === -1) return ctx.allocTypeValue(t);
  return callTypeArgs[index];
}

function lowerCall(
  expr: Extract<ExprAst, { kind: "call" }>,
  ctx: LowerCtx,
): LoweredExpr {
  const callee = ctx.functions.get(expr.fn);
  if (!callee) throw new Error(`unknown function ${expr.fn}`);

  if (callee.params.length !== expr.args.length) {
    throw new Error(
      `function ${expr.fn} expected ${callee.params.length} args, got ${expr.args.length}`,
    );
  }

  if (callee.typeParams.length !== expr.typeArgs.length) {
    throw new Error(
      `function ${expr.fn} expected ${callee.typeParams.length} type args, got ${expr.typeArgs.length}`,
    );
  }

  const loweredArgs = expr.args.map((arg) => lowerExpr(arg, ctx));
  const callTypeArgs: TypeIdx[] = expr.typeArgs.map((ty) =>
    ctx.allocTypeValue(ty),
  );
  const typeArgRegs: string[] = [];
  const instrs: CtInstr[] = [];

  for (let i = 0; i < callTypeArgs.length; i++) {
    const reg = `T${i}`;
    instrs.push({
      op: "resolve_type_expr",
      out: reg,
      typeIdx: callTypeArgs[i],
    });
    typeArgRegs.push(reg);
  }

  instrs.push({ op: "resolve_function_symbol", out: "FnBase", fn: expr.fn });
  instrs.push({ op: "request_fn_instantiation", fnReg: "FnBase", typeArgRegs });
  instrs.push({
    op: "instantiate_generic_symbol",
    out: "Fn",
    symbolReg: "FnBase",
    typeArgRegs,
  });
  instrs.push({ op: "return", valueReg: "Fn" });

  const symbolIdx = ctx.allocSymbolTarget(instrs);

  const out = ctx.nextReg();
  ctx.template.runtime.push({
    op: "call",
    out,
    fnIdx: symbolIdx,
    args: loweredArgs.map((arg) => arg.reg),
  });

  return {
    reg: out,
    tyIdx: substFnType(callee.returnTy, callee, callTypeArgs, ctx),
  };
}

function lowerField(
  expr: Extract<ExprAst, { kind: "field" }>,
  ctx: LowerCtx,
): LoweredExpr {
  const base = lowerExpr(expr.base, ctx);

  const offsetIdx = ctx.allocConstTarget([
    { op: "resolve_type_expr", out: "Base", typeIdx: base.tyIdx },
    { op: "get_layout", out: "Layout", typeReg: "Base" },
    {
      op: "field_offset",
      out: "Offset",
      layoutReg: "Layout",
      field: expr.field,
    },
    { op: "return", valueReg: "Offset" },
  ]);

  const tyIdx = ctx.allocTypeTarget([
    { op: "resolve_type_expr", out: "Base", typeIdx: base.tyIdx },
    { op: "get_layout", out: "Layout", typeReg: "Base" },
    {
      op: "field_type",
      out: "FieldType",
      layoutReg: "Layout",
      field: expr.field,
    },
    { op: "return", valueReg: "FieldType" },
  ]);

  const ptr = ctx.nextReg();
  const out = ctx.nextReg();

  ctx.template.runtime.push({
    op: "field_ptr",
    out: ptr,
    base: base.reg,
    offsetIdx,
  });

  ctx.template.runtime.push({
    op: "load",
    out,
    ptr,
    tyIdx,
  });

  return {
    reg: out,
    tyIdx,
  };
}

function lowerAdd(
  leftAst: ExprAst,
  rightAst: ExprAst,
  ctx: LowerCtx,
): LoweredExpr {
  const left = lowerExpr(leftAst, ctx);
  const right = lowerExpr(rightAst, ctx);

  const methodIdx = ctx.allocSymbolTarget([
    { op: "resolve_type_expr", out: "T", typeIdx: left.tyIdx },
    { op: "prove_trait_bound", out: "AddRef", trait: "Add", typeReg: "T" },
    {
      op: "resolve_method_call",
      out: "FnRaw",
      traitRefReg: "AddRef",
      method: "add",
    },
    {
      op: "instantiate_generic_symbol",
      out: "Fn",
      symbolReg: "FnRaw",
      typeArgRegs: ["T"],
    },
    { op: "return", valueReg: "Fn" },
  ]);

  const resultTyIdx = ctx.allocTypeTarget([
    { op: "resolve_type_expr", out: "T", typeIdx: left.tyIdx },
    { op: "prove_trait_bound", out: "AddRef", trait: "Add", typeReg: "T" },
    {
      op: "project_assoc_type",
      out: "Output",
      traitRefReg: "AddRef",
      assocType: "Output",
    },
    { op: "return", valueReg: "Output" },
  ]);

  const out = ctx.nextReg();

  ctx.template.runtime.push({
    op: "call",
    out,
    fnIdx: methodIdx,
    args: [left.reg, right.reg],
  });

  return {
    reg: out,
    tyIdx: resultTyIdx,
  };
}

// -----------------------------
// Pretty printing
// -----------------------------

function printTemplate(fn: TemplateFunction) {
  console.log(`template fn ${fn.id}<${fn.typeParams.join(", ")}>`);
  console.log("runtime:");
  for (const instr of fn.runtime) {
    console.log("  " + JSON.stringify(instr));
  }

  console.log("type values:");
  for (let i = 0; i < fn.typeValues.length; i++) {
    console.log(
      `  [${i}] = ${fn.typeValues[i] ? showType(fn.typeValues[i]!) : "null"}`,
    );
  }
  console.log("const values:");
  for (let i = 0; i < fn.constValues.length; i++) {
    console.log(`  [${i}] = ${fn.constValues[i] ?? "null"}`);
  }
  console.log("symbol values:");
  for (let i = 0; i < fn.symbolValues.length; i++) {
    console.log(`  [${i}] = ${fn.symbolValues[i] ?? "null"}`);
  }
  console.log("instr values:");
  for (let i = 0; i < fn.instrValues.length; i++) {
    const chunk = fn.instrValues[i];
    console.log(`  [${i}] = ${chunk ? JSON.stringify(chunk) : "null"}`);
  }

  console.log("specialize writes:");
  for (const write of fn.specialize) {
    console.log(`  write ${write.target.kind}[${write.target.idx}]:`);
    for (const instr of write.instrs) {
      console.log("    " + JSON.stringify(instr));
    }
  }
}

function printConcrete(name: string, body: ConcreteInstr[]) {
  console.log(`fn ${name}`);
  for (const instr of body) {
    switch (instr.op) {
      case "param":
        console.log(`  param ${instr.name}: ${showType(instr.ty)}`);
        break;
      case "field_ptr":
        console.log(
          `  ${instr.out} = field_ptr ${instr.base}, offset ${instr.offset}`,
        );
        break;
      case "load":
        console.log(
          `  ${instr.out} = load ${instr.ptr}: ${showType(instr.ty)}`,
        );
        break;
      case "call":
        console.log(
          `  ${instr.out} = call ${instr.fn}(${instr.args.join(", ")})`,
        );
        break;
      case "return":
        console.log(`  return ${instr.value}`);
        break;
    }
  }
}

// -----------------------------
// Run demo
// -----------------------------

type DemoRequest = { fn: string; typeArgs: Type[] };

type DemoScenario = {
  name: string;
  programFns?: FnAst[];
  manualTemplates?: TemplateFunction[];
  requests: DemoRequest[];
  expectedEmittedExact?: string[];
  expectedErrorContains?: string;
  showTemplates?: boolean;
};

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function assertEqualList(actual: string[], expected: string[], label: string) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} mismatch\nexpected: ${expectedSorted.join(", ")}\nactual: ${actualSorted.join(", ")}`,
    );
  }
}

function registerBaseEnvironment(compiler: Compiler, includeIntAddImpl = true) {
  compiler.traits.set("Add", {
    name: "Add",
    typeParams: ["Rhs"],
    assocTypes: ["Output"],
    methods: {
      add: {
        name: "add",
        typeParams: [],
        params: [
          { name: "lhs", ty: { kind: "generic", name: "Self" } },
          { name: "rhs", ty: { kind: "generic", name: "Rhs" } },
        ],
        returnTy: { kind: "generic", name: "Output" },
        where: [],
      },
    },
  });

  compiler.traits.set("Print", {
    name: "Print",
    typeParams: [],
    assocTypes: [],
    methods: {
      print: {
        name: "print",
        typeParams: [],
        params: [{ name: "value", ty: { kind: "generic", name: "Self" } }],
        returnTy: { kind: "generic", name: "Self" },
        where: [],
      },
    },
  });

  compiler.layouts.set(showType(Int), {
    size: 8,
    align: 8,
    fields: {},
  });

  compiler.layouts.set(showType(Point), {
    size: 16,
    align: 8,
    fields: {
      x: { offset: 0, ty: Int },
      y: { offset: 8, ty: Int },
    },
  });

  compiler.layouts.set(showType(Pixel), {
    size: 24,
    align: 8,
    fields: {
      tag: { offset: 0, ty: Int },
      x: { offset: 8, ty: Int },
      y: { offset: 16, ty: Int },
    },
  });

  if (!includeIntAddImpl) return;
  compiler.impls.push({
    trait: "Add",
    forType: Int,
    where: [],
    methods: {
      add: "Int_add",
    },
    assocTypes: {
      Output: Int,
    },
    methodSigs: {
      add: {
        name: "add",
        typeParams: [],
        params: [
          { name: "lhs", ty: Int },
          { name: "rhs", ty: Int },
        ],
        returnTy: Int,
        where: [],
      },
    },
  });

  compiler.impls.push({
    trait: "Print",
    forType: Int,
    where: [],
    methods: {
      print: "Int_print",
    },
    assocTypes: {},
    methodSigs: {
      print: {
        name: "print",
        typeParams: [],
        params: [{ name: "value", ty: Int }],
        returnTy: Int,
        where: [],
      },
    },
  });

  compiler.impls.push({
    trait: "Print",
    forType: Float,
    where: [],
    methods: {
      print: "Float_print",
    },
    assocTypes: {},
    methodSigs: {
      print: {
        name: "print",
        typeParams: [],
        params: [{ name: "value", ty: Float }],
        returnTy: Float,
        where: [],
      },
    },
  });
}

function makeTypeArgTemplate(): TemplateFunction {
  return {
    id: "manualTypeArg",
    typeParams: ["T"],
    runtime: [
      { op: "param", name: "x", tyIdx: 0 },
      { op: "return", value: "x" },
    ],
    specialize: [
      {
        target: { kind: "type", idx: 0 },
        instrs: [
          { op: "get_type_arg", out: "T0", index: 0 },
          { op: "return", valueReg: "T0" },
        ],
      },
    ],
    typeValues: [null],
    constValues: [],
    symbolValues: [],
    instrValues: [],
  };
}

function makeLegacyAddTemplate(): TemplateFunction {
  return {
    id: "legacyAdd",
    typeParams: ["T"],
    runtime: [
      { op: "param", name: "a", tyIdx: 0 },
      { op: "param", name: "b", tyIdx: 0 },
      { op: "call", out: "%0", fnIdx: 0, args: ["a", "b"] },
      { op: "return", value: "%0" },
    ],
    specialize: [
      {
        target: { kind: "type", idx: 0 },
        instrs: [
          { op: "get_type_arg", out: "T0", index: 0 },
          { op: "return", valueReg: "T0" },
        ],
      },
      {
        target: { kind: "symbol", idx: 0 },
        instrs: [
          { op: "get_type_arg", out: "T0", index: 0 },
          { op: "resolve_trait", out: "Impl", trait: "Add", typeReg: "T0" },
          { op: "trait_method", out: "FnRaw", implReg: "Impl", method: "add" },
          {
            op: "instantiate_generic_symbol",
            out: "Fn",
            symbolReg: "FnRaw",
            typeArgRegs: ["T0"],
          },
          { op: "return", valueReg: "Fn" },
        ],
      },
    ],
    typeValues: [null],
    constValues: [],
    symbolValues: [null],
    instrValues: [],
  };
}

function makePrintStructTemplate(): TemplateFunction {
  return {
    id: "printStruct",
    typeParams: ["T"],
    runtime: [
      { op: "param", name: "value", tyIdx: 0 },
      { op: "splice", instrIdx: 0 },
      { op: "return", value: "value" },
    ],
    specialize: [
      {
        target: { kind: "type", idx: 0 },
        instrs: [
          { op: "get_type_arg", out: "T0", index: 0 },
          { op: "return", valueReg: "T0" },
        ],
      },
      {
        target: { kind: "instr", idx: 0 },
        instrs: [
          { op: "get_type_arg", out: "T", index: 0 },
          { op: "get_layout", out: "Layout", typeReg: "T" },
          { op: "field_count", out: "FieldCount", layoutReg: "Layout" },
          { op: "init_instr_chunk", out: "All" },
          { op: "const_lit", out: "I", value: 0 },
          { op: "const_lit", out: "One", value: 1 },
          { op: "branch_lt", leftReg: "I", rightReg: "FieldCount", target: 8 },
          { op: "goto", target: 17 },
          {
            op: "field_offset_at",
            out: "Off",
            layoutReg: "Layout",
            indexReg: "I",
          },
          {
            op: "field_type_at",
            out: "FieldTy",
            layoutReg: "Layout",
            indexReg: "I",
          },
          {
            op: "prove_trait_bound",
            out: "PrintRef",
            trait: "Print",
            typeReg: "FieldTy",
          },
          {
            op: "resolve_method_call",
            out: "PrintFnRaw",
            traitRefReg: "PrintRef",
            method: "print",
          },
          {
            op: "instantiate_generic_symbol",
            out: "PrintFn",
            symbolReg: "PrintFnRaw",
            typeArgRegs: ["FieldTy"],
          },
          {
            op: "build_instr_chunk",
            out: "Chunk",
            base: "value",
            offsetReg: "Off",
            typeReg: "FieldTy",
            fnReg: "PrintFn",
            indexReg: "I",
            ptrPrefix: "%pf_",
            valPrefix: "%vf_",
          },
          { op: "append_instr_chunk", toReg: "All", chunkReg: "Chunk" },
          { op: "add_const", out: "I", lhsReg: "I", rhsReg: "One" },
          { op: "goto", target: 6 },
          { op: "return", valueReg: "All" },
        ],
      },
    ],
    typeValues: [null],
    constValues: [],
    symbolValues: [],
    instrValues: [null],
  };
}

function runScenario(
  scenario: DemoScenario,
  setup?: (compiler: Compiler) => void,
) {
  console.log(`\n=== Scenario: ${scenario.name} ===\n`);

  const compiler = new Compiler();
  registerBaseEnvironment(compiler);
  setup?.(compiler);

  try {
    const programFns = scenario.programFns ?? [];
    const fnIndex = new Map(programFns.map((fn) => [fn.name, fn] as const));
    const lowered = programFns.map((fn) => lowerFunction(fn, fnIndex));
    const templates = [...lowered, ...(scenario.manualTemplates ?? [])];

    for (const template of templates) {
      compiler.templates.set(template.id, template);
    }

    if (scenario.showTemplates) {
      for (const template of templates) {
        printTemplate(template);
        console.log("");
      }
    }

    for (const request of scenario.requests) {
      compiler.request(request.fn, request.typeArgs);
    }

    compiler.run();

    const emittedNames = [...compiler.emitted.keys()].sort();
    console.log("emitted:", emittedNames.join(", "));

    if (scenario.expectedErrorContains) {
      throw new Error(
        `expected scenario to fail with: ${scenario.expectedErrorContains}`,
      );
    }

    if (scenario.expectedEmittedExact) {
      assertEqualList(
        emittedNames,
        scenario.expectedEmittedExact,
        scenario.name,
      );
    }

    for (const name of emittedNames) {
      printConcrete(name, compiler.emitted.get(name)!);
    }
  } catch (e) {
    const message = errorMessage(e);
    if (!scenario.expectedErrorContains) throw e;
    if (!message.includes(scenario.expectedErrorContains)) {
      throw new Error(
        `${scenario.name} expected error containing "${scenario.expectedErrorContains}" but got "${message}"`,
      );
    }
    console.log(`expected error: ${message}`);
  }
}

const scenarios: Array<{
  scenario: DemoScenario;
  setup?: (compiler: Compiler) => void;
}> = [
  {
    scenario: {
      name: "field reflection + trait dispatch + assoc projection",
      programFns: [addXAst],
      requests: [
        { fn: "addX", typeArgs: [Point] },
        { fn: "addX", typeArgs: [Pixel] },
        { fn: "addX", typeArgs: [PointF] },
      ],
      expectedEmittedExact: ["addX__Point", "addX__Pixel", "addX__PointF"],
      showTemplates: true,
    },
    setup: (compiler) => {
      compiler.layouts.set(showType(PointF), {
        size: 16,
        align: 8,
        fields: {
          x: { offset: 0, ty: Float },
          y: { offset: 8, ty: Float },
        },
      });

      compiler.impls.push({
        trait: "Add",
        forType: Float,
        where: [],
        methods: {
          add: "Float_add",
        },
        assocTypes: {
          Output: Float,
        },
        methodSigs: {
          add: {
            name: "add",
            typeParams: [],
            params: [
              { name: "lhs", ty: Float },
              { name: "rhs", ty: Float },
            ],
            returnTy: Float,
            where: [],
          },
        },
      });
    },
  },
  {
    scenario: {
      name: "generic -> generic + regular -> generic",
      programFns: [genericInnerAst, genericOuterAst, regularFnAst],
      requests: [
        { fn: "regularFn", typeArgs: [] },
        { fn: "genericOuter", typeArgs: [Float] },
      ],
      expectedEmittedExact: [
        "regularFn",
        "genericOuter__Int",
        "genericInner__Int",
        "genericOuter__Float",
        "genericInner__Float",
      ],
      showTemplates: true,
    },
  },
  {
    scenario: {
      name: "dedup across repeated requests",
      programFns: [genericInnerAst, genericOuterAst, regularFnAst],
      requests: [
        { fn: "regularFn", typeArgs: [] },
        { fn: "regularFn", typeArgs: [] },
        { fn: "genericOuter", typeArgs: [Int] },
        { fn: "genericInner", typeArgs: [Int] },
      ],
      expectedEmittedExact: [
        "regularFn",
        "genericOuter__Int",
        "genericInner__Int",
      ],
    },
  },
  {
    scenario: {
      name: "manual get_type_arg",
      manualTemplates: [makeTypeArgTemplate()],
      requests: [{ fn: "manualTypeArg", typeArgs: [Int] }],
      expectedEmittedExact: ["manualTypeArg__Int"],
    },
  },
  {
    scenario: {
      name: "legacy resolve_trait + trait_method",
      manualTemplates: [makeLegacyAddTemplate()],
      requests: [{ fn: "legacyAdd", typeArgs: [Int] }],
      expectedEmittedExact: ["legacyAdd__Int"],
    },
  },
  {
    scenario: {
      name: "printStruct ct-loop unroll",
      manualTemplates: [makePrintStructTemplate()],
      requests: [
        { fn: "printStruct", typeArgs: [Point] },
        { fn: "printStruct", typeArgs: [PointF] },
      ],
      expectedEmittedExact: ["printStruct__Point", "printStruct__PointF"],
      showTemplates: true,
    },
    setup: (compiler) => {
      compiler.layouts.set(showType(PointF), {
        size: 16,
        align: 8,
        fields: {
          x: { offset: 0, ty: Float },
          y: { offset: 8, ty: Float },
        },
      });
    },
  },
  {
    scenario: {
      name: "error missing print impl",
      manualTemplates: [makePrintStructTemplate()],
      requests: [{ fn: "printStruct", typeArgs: [Flagged] }],
      expectedErrorContains: "no impl Print for Bool",
    },
    setup: (compiler) => {
      compiler.layouts.set(showType(Flagged), {
        size: 8,
        align: 8,
        fields: {
          enabled: { offset: 0, ty: Bool },
        },
      });
    },
  },
  {
    scenario: {
      name: "error missing field",
      programFns: [addXAst],
      requests: [{ fn: "addX", typeArgs: [Pair] }],
      expectedErrorContains: "unknown field x",
    },
    setup: (compiler) => {
      compiler.layouts.set(showType(Pair), {
        size: 16,
        align: 8,
        fields: {
          a: { offset: 0, ty: Int },
          b: { offset: 8, ty: Int },
        },
      });
    },
  },
  {
    scenario: {
      name: "error missing trait impl",
      programFns: [addXAst],
      requests: [{ fn: "addX", typeArgs: [PointF] }],
      expectedErrorContains: "no impl Add for Float",
    },
    setup: (compiler) => {
      compiler.layouts.set(showType(PointF), {
        size: 16,
        align: 8,
        fields: {
          x: { offset: 0, ty: Float },
          y: { offset: 8, ty: Float },
        },
      });
    },
  },
  {
    scenario: {
      name: "error bad generic arity",
      programFns: [genericInnerAst, genericOuterAst, badArityCallAst],
      requests: [],
      expectedErrorContains:
        "function genericOuter expected 1 type args, got 0",
    },
  },
  {
    scenario: {
      name: "error unknown callee",
      programFns: [badUnknownCallAst],
      requests: [],
      expectedErrorContains: "unknown function doesNotExist",
    },
  },
];

for (const item of scenarios) {
  runScenario(item.scenario, item.setup);
}

console.log(`\nall scenarios passed: ${scenarios.length}/${scenarios.length}`);
