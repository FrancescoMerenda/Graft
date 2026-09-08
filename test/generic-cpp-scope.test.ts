/**
 * Scope-qualified ids in the breadth tier.
 *
 * The generic extractor used to id every symbol by its bare name within a file, so
 * two classes with a `toString` in one translation unit collapsed into `#toString`
 * and `#toString~2` — an arbitrary, unstable split that made call edges land on
 * whichever one happened to be minted first. In a Qt/C++ tree, where out-of-line
 * definitions put the class in the declarator rather than around the body, that
 * read as every instance method belonging to one giant class.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmGenericGrammars, extractGeneric } from "../src/graph/generic.js";

const CPP = `namespace elm {

class Logger {
public:
    void write();
};

void Logger::write() {}

}

class DbColumn {
public:
    QString toString() const;
};

class DbField {
public:
    QString toString() const;
};

QString DbColumn::toString() const { return name; }

QString DbField::toString() const { return other; }

int main() { return 0; }
`;

test("breadth-tier ids carry the enclosing class and namespace", async () => {
  await warmGenericGrammars(["cpp"]);
  const { nodes } = extractGeneric("db.cpp", CPP, "cpp");
  const ids = nodes.filter((n) => n.kind !== "file").map((n) => n.id.split("#")[1]);

  // The bug: both classes' `toString` collapsed to `toString` / `toString~2`.
  assert.ok(
    ids.some((id) => id.startsWith("DbColumn.toString")),
    `DbColumn.toString missing (got ${ids.join(", ")})`,
  );
  assert.ok(
    ids.some((id) => id.startsWith("DbField.toString")),
    `DbField.toString missing (got ${ids.join(", ")})`,
  );
  assert.ok(!ids.includes("toString"), "a bare `toString` id means the class was dropped");

  // An out-of-line definition inside a namespace carries both qualifiers.
  assert.ok(
    ids.some((id) => id.startsWith("elm.Logger.write")),
    `elm.Logger.write missing (got ${ids.join(", ")})`,
  );

  // A free function is not given a scope it does not have.
  assert.ok(ids.includes("main"), `main should stay unqualified (got ${ids.join(", ")})`);

  // Display names stay bare, matching the depth tier: the id disambiguates, the
  // label stays readable.
  const names = nodes.filter((n) => n.kind !== "file").map((n) => n.name);
  assert.ok(names.includes("toString"), "node.name stays the bare symbol name");
});
