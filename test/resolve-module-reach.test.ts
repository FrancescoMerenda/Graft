/**
 * A bare-name match in a module you never import is not a call.
 *
 * The breadth tier hands every call over as a bare name — tags.scm cannot type a
 * receiver — and the unique-name fallback then treats the whole repo as one
 * namespace. On a real C++ tree that turned `db.commit()` into a call into an
 * SNMP table, `QVariant::fromValue` into a call into a DSC manager, and every
 * `instance()` in the repo into a call into one singleton: 994 of 1357
 * cross-module call edges, none with an include to stand on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmGenericGrammars, extractGeneric } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import type { NodeV1 } from "../src/graph/types.js";
import type { RawEdge } from "../src/graph/extract.js";

/** Two modules, each with the header/source split C++ uses. */
const FILES: Record<string, string> = {
  "libs/sql/sources/Query.cpp": `
#include "sql/Query.h"
namespace sql {
void Query::transact() { commit(); helper(); }
}
`,
  "libs/sql/headers/sql/Query.h": `
namespace sql {
class Query { public: void transact(); };
void helper();
}
`,
  // The only definition of `commit` in the repo, in a module elmSql never includes.
  "libs/snmp/headers/Table.h": `
namespace snmp {
class Table { public: void commit() {} };
}
`,
};

async function graphOf(): Promise<{ nodes: NodeV1[]; raw: RawEdge[] }> {
  await warmGenericGrammars(["cpp"]);
  const nodes: NodeV1[] = [];
  const raw: RawEdge[] = [];
  for (const [path, src] of Object.entries(FILES)) {
    const r = extractGeneric(path, src, "cpp");
    nodes.push(...r.nodes);
    raw.push(...r.rawEdges);
  }
  return { nodes, raw };
}

const calls = (nodes: NodeV1[], raw: RawEdge[]): string[] => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return resolveEdges(nodes, raw)
    .filter((e) => e.relation === "calls")
    .map((e) => `${byId.get(e.source)?.path} -> ${byId.get(e.target)?.path}`);
};

test("a unique cross-module name is not a call when nothing imports that module", async () => {
  const { nodes, raw } = await graphOf();
  const hits = calls(nodes, raw);
  assert.ok(
    !hits.some((h) => h.includes("libs/snmp/")),
    `commit() must not resolve into a module Query.cpp never includes (got ${hits.join(", ")})`,
  );
});

test("the same call resolves once the caller includes that module", async () => {
  const { nodes, raw } = await graphOf();
  // One added include is the whole difference: the name was always unique, so a
  // rule that ignores includes cannot tell these two repos apart.
  const withInclude: RawEdge[] = [
    ...raw,
    {
      source: "libs/sql/sources/Query.cpp",
      relation: "imports",
      file: "libs/sql/sources/Query.cpp",
      specifier: "Table.h",
    },
  ];
  const hits = calls(nodes, withInclude);
  assert.ok(
    hits.some((h) => h.includes("libs/snmp/")),
    `an included module stays reachable (got ${hits.join(", ")})`,
  );
});

test("a header and its own source are one module, not two", async () => {
  const { nodes, raw } = await graphOf();
  // `helper` is declared in `headers/`, called from `sources/` — one module split
  // by C++ convention. A rule keyed on the directory would call those two places
  // different modules and drop the edge between a declaration and its own caller,
  // which is most of what a C++ graph is made of.
  const hits = calls(nodes, raw);
  assert.ok(
    hits.some((h) => h === "libs/sql/sources/Query.cpp -> libs/sql/headers/sql/Query.h"),
    `a call within one module resolves across headers/ and sources/ (got ${hits.join(", ")})`,
  );
});
