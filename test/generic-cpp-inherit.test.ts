/**
 * C++ inheritance, and the `extends` verb in the breadth tier.
 *
 * `cpp.scm` captured no supertypes at all, so a C++ graph had zero inheritance
 * edges — the one relation people most want from an object-oriented codebase.
 * And the breadth tier flattened every structural reference to `references`, so
 * even the grammars that did capture a supertype could only say "mentions".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmGenericGrammars, extractGeneric } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";

const CPP = `
namespace elm {

class Base {
public:
    virtual void run();
};

struct Mixin {
    void help();
};

class Derived : public Base, private Mixin {
public:
    void run() override;
};

class Owner {
public:
    void make();
};

void Owner::make() { Base* b = new Derived(); }

}
`;

test("cpp inheritance becomes extends edges, attributed to the derived class", async () => {
  await warmGenericGrammars(["cpp"]);
  const { nodes, rawEdges } = extractGeneric("d.cpp", CPP, "cpp");

  // A broken query silently disables the whole tags path, so assert the ordinary
  // extraction still works before believing anything about the new edges.
  const names = nodes.filter((n) => n.kind !== "file").map((n) => n.name);
  assert.ok(names.includes("Derived"), `classes still extract (got ${names.join(", ")})`);

  const edges = resolveEdges(nodes, rawEdges);
  const pair = (rel: string) =>
    edges.filter((e) => e.relation === rel).map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1]}`);

  const ext = pair("extends");
  // Both bases, and both attributed to the derived class rather than to the file.
  assert.ok(ext.includes("elm.Derived→elm.Base"), `Derived extends Base (got ${ext.join(", ")})`);
  assert.ok(ext.includes("elm.Derived→elm.Mixin"), `Derived extends Mixin (got ${ext.join(", ")})`);
  // A base list is not a call.
  assert.ok(!pair("calls").some((p) => p.includes("→Base")), "a base class is not called");
});

test("cpp `new Derived()` is a reference, not inheritance", async () => {
  await warmGenericGrammars(["cpp"]);
  const { nodes, rawEdges } = extractGeneric("d.cpp", CPP, "cpp");
  const edges = resolveEdges(nodes, rawEdges);
  const refs = edges
    .filter((e) => e.relation === "references")
    .map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1]}`);
  // `~2` because the declaration in the class and the out-of-line definition both
  // mint `elm.Owner.make`; which one wins is not what this test is about.
  assert.ok(
    refs.some((p) => /^elm\.Owner\.make(~\d+)?→elm\.Derived$/.test(p)),
    `make() instantiates Derived (got ${refs.join(", ")})`,
  );
  // Instantiating is not inheriting — the two must not collapse into one verb.
  const ext = edges.filter((e) => e.relation === "extends").map((e) => e.source.split("#")[1]);
  assert.ok(!ext.some((e) => e.startsWith("elm.Owner.make")), "make() does not extend anything");
});

test("a class that resolves to itself is dropped, not drawn as a self-loop", async () => {
  await warmGenericGrammars(["cpp"]);
  // `enchantum::array : std::array` — the base name matches the derived class's
  // own name, so bare-name resolution lands it on itself.
  const src = `
namespace enchantum {
class array : public std::array<int, 4> {};
}
`;
  const { nodes, rawEdges } = extractGeneric("a.hpp", src, "cpp");
  const edges = resolveEdges(nodes, rawEdges);
  assert.ok(!edges.some((e) => e.source === e.target), "no self-loops of any relation");
});
