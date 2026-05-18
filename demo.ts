// demo.ts
// Self-contained staged monomorphisation demo:
// - AST lowers to runtime-template IR
// - Runtime-template IR contains holes
// - Holes point to CT/specialisation blocks
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
const Point: Type = { kind: "struct", name: "Point" };
const Pixel: Type = { kind: "struct", name: "Pixel" };
const Pair: Type = { kind: "struct", name: "Pair" };
const PointF: Type = { kind: "struct", name: "PointF" };

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

type HoleId = string;
type SymbolId = string;

type TypeExpr =
  | { kind: "type"; value: Type }
  | { kind: "hole"; id: HoleId };

type SymbolExpr =
  | { kind: "symbol"; value: SymbolId }
  | { kind: "hole"; id: HoleId };

type ConstExpr =
  | { kind: "const"; value: number }
  | { kind: "hole"; id: HoleId };

type WhereClause =
  | {
      kind: "trait_bound";
      typeExpr: TypeExpr;
      trait: string;
    }
  | {
      kind: "assoc_eq";
      typeExpr: TypeExpr;
      trait: string;
      assocType: string;
      equals: TypeExpr;
    };

type MethodSig = {
  name: string;
  typeParams: string[];
  params: { name: string; ty: TypeExpr }[];
  returnTy: TypeExpr;
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
  | { op: "param"; name: string; ty: TypeExpr }
  | { op: "field_ptr"; out: string; base: string; offset: ConstExpr }
  | { op: "load"; out: string; ptr: string; ty: TypeExpr }
  | { op: "call"; out: string; fn: SymbolExpr; args: string[] }
  | { op: "return"; value: string };

type TemplateFunction = {
  id: string;
  typeParams: string[];
  runtime: RuntimeInstr[];
  holes: Record<HoleId, CtBlock>;
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
  | { kind: "fn_sig"; value: FnSigRef };

type CtInstr =
  | { op: "get_type_arg"; out: string; index: number }
  | { op: "resolve_type_expr"; out: string; typeExpr: TypeExpr }
  | { op: "get_layout"; out: string; typeReg: string }
  | { op: "field_offset"; out: string; layoutReg: string; field: string }
  | { op: "field_type"; out: string; layoutReg: string; field: string }
  | { op: "resolve_trait"; out: string; trait: string; typeReg: string }
  | { op: "trait_method"; out: string; implReg: string; method: string }
  | { op: "prove_trait_bound"; out: string; trait: string; typeReg: string }
  | { op: "project_assoc_type"; out: string; traitRefReg: string; assocType: string }
  | { op: "resolve_method_call"; out: string; traitRefReg: string; method: string }
  | { op: "resolve_function_symbol"; out: string; fn: string }
  | { op: "request_fn_instantiation"; fnReg: string; typeArgRegs: string[] }
  | { op: "instantiate_generic_symbol"; out: string; symbolReg: string; typeArgRegs: string[] }
  | { op: "return"; valueReg: string };

type CtBlock = {
  instrs: CtInstr[];
};

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

  holeCache = new Map<string, CtValue>();

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
    return template.runtime.map((instr): ConcreteInstr => {
      switch (instr.op) {
        case "param":
          return {
            op: "param",
            name: instr.name,
            ty: this.resolveTypeExpr(template, typeArgs, instr.ty),
          };

        case "field_ptr":
          return {
            op: "field_ptr",
            out: instr.out,
            base: instr.base,
            offset: this.resolveConstExpr(template, typeArgs, instr.offset),
          };

        case "load":
          return {
            op: "load",
            out: instr.out,
            ptr: instr.ptr,
            ty: this.resolveTypeExpr(template, typeArgs, instr.ty),
          };

        case "call":
          return {
            op: "call",
            out: instr.out,
            fn: this.resolveSymbolExpr(template, typeArgs, instr.fn),
            args: instr.args,
          };

        case "return":
          return instr;
      }
    });
  }

  resolveTypeExpr(template: TemplateFunction, typeArgs: Type[], expr: TypeExpr): Type {
    if (expr.kind === "type") {
      return this.substType(template, typeArgs, expr.value);
    }

    const v = this.resolveHole(template, typeArgs, expr.id);
    if (v.kind === "type") return v.value;
    if (v.kind === "assoc_type") return v.value.ty;
    throw new Error(`hole ${expr.id} did not return type`);
  }

  resolveConstExpr(template: TemplateFunction, typeArgs: Type[], expr: ConstExpr): number {
    if (expr.kind === "const") return expr.value;

    const v = this.resolveHole(template, typeArgs, expr.id);
    if (v.kind !== "const") throw new Error(`hole ${expr.id} did not return const`);
    return v.value;
  }

  resolveSymbolExpr(template: TemplateFunction, typeArgs: Type[], expr: SymbolExpr): SymbolId {
    if (expr.kind === "symbol") return expr.value;

    const v = this.resolveHole(template, typeArgs, expr.id);
    if (v.kind !== "symbol") throw new Error(`hole ${expr.id} did not return symbol`);
    return v.value;
  }

  resolveHole(template: TemplateFunction, typeArgs: Type[], holeId: HoleId): CtValue {
    const key = `${this.mangle(template.id, typeArgs)}:${holeId}`;
    const cached = this.holeCache.get(key);
    if (cached) return cached;

    const block = template.holes[holeId];
    if (!block) throw new Error(`missing hole ${holeId}`);

    const value = this.evalCtBlock(template, typeArgs, block);
    this.holeCache.set(key, value);
    return value;
  }

  evalCtBlock(template: TemplateFunction, typeArgs: Type[], block: CtBlock): CtValue {
    const regs = new Map<string, CtValue>();

    const read = (name: string): CtValue => {
      const value = regs.get(name);
      if (!value) throw new Error(`missing CT register ${name}`);
      return value;
    };

    for (const instr of block.instrs) {
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
            value: this.resolveTypeExpr(template, typeArgs, instr.typeExpr),
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
          if (traitRef.kind !== "trait_ref") throw new Error("expected trait ref");

          const impl = this.resolveTrait(traitRef.value.trait, traitRef.value.forType);
          const ty = impl.assocTypes[instr.assocType];
          if (!ty) {
            throw new Error(
              `impl ${traitRef.value.trait} for ${showType(traitRef.value.forType)} has no associated type ${instr.assocType}`
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
          if (traitRef.kind !== "trait_ref") throw new Error("expected trait ref");

          const impl = this.resolveTrait(traitRef.value.trait, traitRef.value.forType);
          const method = impl.methods[instr.method];
          if (!method) {
            throw new Error(
              `impl ${traitRef.value.trait} for ${showType(traitRef.value.forType)} has no method ${instr.method}`
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

          const typeArgsForCall = instr.typeArgRegs.map(reg => {
            const value = read(reg);
            if (value.kind === "type") return value.value;
            if (value.kind === "assoc_type") return value.value.ty;
            throw new Error("expected type-like register");
          });

          if (typeArgsForCall.length !== callee.typeParams.length) {
            throw new Error(
              `function ${fn.value} expected ${callee.typeParams.length} type args, got ${typeArgsForCall.length}`
            );
          }

          this.request(callee.id, typeArgsForCall);
          break;
        }

        case "instantiate_generic_symbol": {
          const symbol = read(instr.symbolReg);
          if (symbol.kind !== "symbol") throw new Error("expected symbol");

          const typeArgsForSymbol = instr.typeArgRegs.map(reg => {
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
    const impl = this.impls.find(i => i.trait === trait && sameType(i.forType, t));
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
  ty: TypeExpr;
};

type LowerCtx = {
  template: TemplateFunction;
  functions: Map<string, FnAst>;
  locals: Map<string, TypeExpr>;
  nextReg(): string;
  nextHole(name: string): HoleId;
};

function lowerFunction(ast: FnAst, functions: Map<string, FnAst>): TemplateFunction {
  let regCounter = 0;
  let holeCounter = 0;

  const template: TemplateFunction = {
    id: ast.name,
    typeParams: ast.typeParams,
    runtime: [],
    holes: {},
  };

  const ctx: LowerCtx = {
    template,
    functions,
    locals: new Map(),

    nextReg() {
      return `%${regCounter++}`;
    },

    nextHole(name: string) {
      return `${name}_${holeCounter++}`;
    },
  };

  for (const param of ast.params) {
    const ty: TypeExpr = { kind: "type", value: param.ty };

    ctx.locals.set(param.name, ty);

    template.runtime.push({
      op: "param",
      name: param.name,
      ty,
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
      const ty = ctx.locals.get(expr.name);
      if (!ty) throw new Error(`unknown local ${expr.name}`);
      return { reg: expr.name, ty };
    }

    case "field":
      return lowerField(expr, ctx);

    case "binary":
      return lowerAdd(expr.left, expr.right, ctx);

    case "call":
      return lowerCall(expr, ctx);
  }
}

function substFnType(t: Type, callee: FnAst, callTypeArgs: TypeExpr[]): TypeExpr {
  if (t.kind !== "generic") return { kind: "type", value: t };

  const index = callee.typeParams.indexOf(t.name);
  if (index === -1) return { kind: "type", value: t };
  return callTypeArgs[index];
}

function lowerCall(expr: Extract<ExprAst, { kind: "call" }>, ctx: LowerCtx): LoweredExpr {
  const callee = ctx.functions.get(expr.fn);
  if (!callee) throw new Error(`unknown function ${expr.fn}`);

  if (callee.params.length !== expr.args.length) {
    throw new Error(`function ${expr.fn} expected ${callee.params.length} args, got ${expr.args.length}`);
  }

  if (callee.typeParams.length !== expr.typeArgs.length) {
    throw new Error(`function ${expr.fn} expected ${callee.typeParams.length} type args, got ${expr.typeArgs.length}`);
  }

  const loweredArgs = expr.args.map(arg => lowerExpr(arg, ctx));
  const callTypeArgs: TypeExpr[] = expr.typeArgs.map(ty => ({ kind: "type", value: ty }));

  const symbolHole = ctx.nextHole(`call_${expr.fn}`);
  const typeArgRegs: string[] = [];
  const instrs: CtInstr[] = [];

  for (let i = 0; i < callTypeArgs.length; i++) {
    const reg = `T${i}`;
    instrs.push({
      op: "resolve_type_expr",
      out: reg,
      typeExpr: callTypeArgs[i],
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

  ctx.template.holes[symbolHole] = { instrs };

  const out = ctx.nextReg();
  ctx.template.runtime.push({
    op: "call",
    out,
    fn: { kind: "hole", id: symbolHole },
    args: loweredArgs.map(arg => arg.reg),
  });

  return {
    reg: out,
    ty: substFnType(callee.returnTy, callee, callTypeArgs),
  };
}

function lowerField(expr: Extract<ExprAst, { kind: "field" }>, ctx: LowerCtx): LoweredExpr {
  const base = lowerExpr(expr.base, ctx);

  const offsetHole = ctx.nextHole(`offset_${expr.field}`);
  const typeHole = ctx.nextHole(`type_${expr.field}`);

  ctx.template.holes[offsetHole] = {
    instrs: [
      { op: "resolve_type_expr", out: "Base", typeExpr: base.ty },
      { op: "get_layout", out: "Layout", typeReg: "Base" },
      { op: "field_offset", out: "Offset", layoutReg: "Layout", field: expr.field },
      { op: "return", valueReg: "Offset" },
    ],
  };

  ctx.template.holes[typeHole] = {
    instrs: [
      { op: "resolve_type_expr", out: "Base", typeExpr: base.ty },
      { op: "get_layout", out: "Layout", typeReg: "Base" },
      { op: "field_type", out: "FieldType", layoutReg: "Layout", field: expr.field },
      { op: "return", valueReg: "FieldType" },
    ],
  };

  const ptr = ctx.nextReg();
  const out = ctx.nextReg();

  ctx.template.runtime.push({
    op: "field_ptr",
    out: ptr,
    base: base.reg,
    offset: { kind: "hole", id: offsetHole },
  });

  ctx.template.runtime.push({
    op: "load",
    out,
    ptr,
    ty: { kind: "hole", id: typeHole },
  });

  return {
    reg: out,
    ty: { kind: "hole", id: typeHole },
  };
}

function lowerAdd(leftAst: ExprAst, rightAst: ExprAst, ctx: LowerCtx): LoweredExpr {
  const left = lowerExpr(leftAst, ctx);
  const right = lowerExpr(rightAst, ctx);

  const methodHole = ctx.nextHole("add_method");
  const resultTypeHole = ctx.nextHole("add_result");

  ctx.template.holes[methodHole] = {
    instrs: [
      { op: "resolve_type_expr", out: "T", typeExpr: left.ty },
      { op: "prove_trait_bound", out: "AddRef", trait: "Add", typeReg: "T" },
      { op: "resolve_method_call", out: "FnRaw", traitRefReg: "AddRef", method: "add" },
      {
        op: "instantiate_generic_symbol",
        out: "Fn",
        symbolReg: "FnRaw",
        typeArgRegs: ["T"],
      },
      { op: "return", valueReg: "Fn" },
    ],
  };

  ctx.template.holes[resultTypeHole] = {
    instrs: [
      { op: "resolve_type_expr", out: "T", typeExpr: left.ty },
      { op: "prove_trait_bound", out: "AddRef", trait: "Add", typeReg: "T" },
      { op: "project_assoc_type", out: "Output", traitRefReg: "AddRef", assocType: "Output" },
      { op: "return", valueReg: "Output" },
    ],
  };

  const out = ctx.nextReg();

  ctx.template.runtime.push({
    op: "call",
    out,
    fn: { kind: "hole", id: methodHole },
    args: [left.reg, right.reg],
  });

  return {
    reg: out,
    ty: { kind: "hole", id: resultTypeHole },
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

  console.log("holes:");
  for (const [id, block] of Object.entries(fn.holes)) {
    console.log(`  hole ${id}:`);
    for (const instr of block.instrs) {
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
        console.log(`  ${instr.out} = field_ptr ${instr.base}, offset ${instr.offset}`);
        break;
      case "load":
        console.log(`  ${instr.out} = load ${instr.ptr}: ${showType(instr.ty)}`);
        break;
      case "call":
        console.log(`  ${instr.out} = call ${instr.fn}(${instr.args.join(", ")})`);
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
      `${label} mismatch\nexpected: ${expectedSorted.join(", ")}\nactual: ${actualSorted.join(", ")}`
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
          { name: "lhs", ty: { kind: "type", value: { kind: "generic", name: "Self" } } },
          { name: "rhs", ty: { kind: "type", value: { kind: "generic", name: "Rhs" } } },
        ],
        returnTy: { kind: "type", value: { kind: "generic", name: "Output" } },
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
          { name: "lhs", ty: { kind: "type", value: Int } },
          { name: "rhs", ty: { kind: "type", value: Int } },
        ],
        returnTy: { kind: "type", value: Int },
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
      { op: "param", name: "x", ty: { kind: "hole", id: "arg_ty" } },
      { op: "return", value: "x" },
    ],
    holes: {
      arg_ty: {
        instrs: [
          { op: "get_type_arg", out: "T0", index: 0 },
          { op: "return", valueReg: "T0" },
        ],
      },
    },
  };
}

function makeLegacyAddTemplate(): TemplateFunction {
  return {
    id: "legacyAdd",
    typeParams: ["T"],
    runtime: [
      { op: "param", name: "a", ty: { kind: "hole", id: "arg_ty" } },
      { op: "param", name: "b", ty: { kind: "hole", id: "arg_ty" } },
      { op: "call", out: "%0", fn: { kind: "hole", id: "add_fn" }, args: ["a", "b"] },
      { op: "return", value: "%0" },
    ],
    holes: {
      arg_ty: {
        instrs: [
          { op: "get_type_arg", out: "T0", index: 0 },
          { op: "return", valueReg: "T0" },
        ],
      },
      add_fn: {
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
    },
  };
}

function runScenario(
  scenario: DemoScenario,
  setup?: (compiler: Compiler) => void
) {
  console.log(`\n=== Scenario: ${scenario.name} ===\n`);

  const compiler = new Compiler();
  registerBaseEnvironment(compiler);
  setup?.(compiler);

  try {
    const programFns = scenario.programFns ?? [];
    const fnIndex = new Map(programFns.map(fn => [fn.name, fn] as const));
    const lowered = programFns.map(fn => lowerFunction(fn, fnIndex));
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
      throw new Error(`expected scenario to fail with: ${scenario.expectedErrorContains}`);
    }

    if (scenario.expectedEmittedExact) {
      assertEqualList(emittedNames, scenario.expectedEmittedExact, scenario.name);
    }

    for (const name of emittedNames) {
      printConcrete(name, compiler.emitted.get(name)!);
    }
  } catch (e) {
    const message = errorMessage(e);
    if (!scenario.expectedErrorContains) throw e;
    if (!message.includes(scenario.expectedErrorContains)) {
      throw new Error(
        `${scenario.name} expected error containing "${scenario.expectedErrorContains}" but got "${message}"`
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
    setup: compiler => {
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
              { name: "lhs", ty: { kind: "type", value: Float } },
              { name: "rhs", ty: { kind: "type", value: Float } },
            ],
            returnTy: { kind: "type", value: Float },
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
      expectedEmittedExact: ["regularFn", "genericOuter__Int", "genericInner__Int"],
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
      name: "error missing field",
      programFns: [addXAst],
      requests: [{ fn: "addX", typeArgs: [Pair] }],
      expectedErrorContains: "unknown field x",
    },
    setup: compiler => {
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
    setup: compiler => {
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
      expectedErrorContains: "function genericOuter expected 1 type args, got 0",
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