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
const Point: Type = { kind: "struct", name: "Point" };

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
  | { kind: "binary"; op: "+"; left: ExprAst; right: ExprAst };

type FnAst = {
  name: string;
  typeParams: string[];
  params: { name: string; ty: Type }[];
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
  | { kind: "impl"; value: Impl }
  | { kind: "symbol"; value: SymbolId };

type CtInstr =
  | { op: "get_type_arg"; out: string; index: number }
  | { op: "resolve_type_expr"; out: string; typeExpr: TypeExpr }
  | { op: "get_layout"; out: string; typeReg: string }
  | { op: "field_offset"; out: string; layoutReg: string; field: string }
  | { op: "field_type"; out: string; layoutReg: string; field: string }
  | { op: "resolve_trait"; out: string; trait: string; typeReg: string }
  | { op: "trait_method"; out: string; implReg: string; method: string }
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

type Impl = {
  trait: string;
  forType: Type;
  methods: Record<string, SymbolId>;
};

// -----------------------------
// Compiler
// -----------------------------

class Compiler {
  templates = new Map<string, TemplateFunction>();
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
    if (v.kind !== "type") throw new Error(`hole ${expr.id} did not return type`);
    return v.value;
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
  locals: Map<string, TypeExpr>;
  nextReg(): string;
  nextHole(name: string): HoleId;
};

function lowerFunction(ast: FnAst): TemplateFunction {
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
  }
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
      { op: "resolve_trait", out: "Impl", trait: "Add", typeReg: "T" },
      { op: "trait_method", out: "Fn", implReg: "Impl", method: "add" },
      { op: "return", valueReg: "Fn" },
    ],
  };

  // Tiny demo simplification: Add<T>.Output = T.
  ctx.template.holes[resultTypeHole] = {
    instrs: [
      { op: "resolve_type_expr", out: "T", typeExpr: left.ty },
      { op: "return", valueReg: "T" },
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

const compiler = new Compiler();

compiler.layouts.set("Int", {
  size: 8,
  align: 8,
  fields: {},
});

compiler.layouts.set("Point", {
  size: 16,
  align: 8,
  fields: {
    x: { offset: 0, ty: Int },
    y: { offset: 8, ty: Int },
  },
});

compiler.impls.push({
  trait: "Add",
  forType: Int,
  methods: {
    add: "Int_add",
  },
});

const template = lowerFunction(addXAst);

compiler.templates.set(template.id, template);

console.log("\n=== Lowered template IR ===\n");
printTemplate(template);

compiler.request("addX", [Point]);
compiler.run();

console.log("\n=== Specialised concrete IR ===\n");

for (const [name, body] of compiler.emitted) {
  printConcrete(name, body);
}