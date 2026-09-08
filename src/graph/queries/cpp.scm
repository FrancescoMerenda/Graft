(struct_specifier name: (type_identifier) @name body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(function_declarator declarator: (identifier) @name) @definition.function

(function_declarator declarator: (field_identifier) @name) @definition.function

(function_declarator declarator: (qualified_identifier scope: (namespace_identifier) @local.scope name: (identifier) @name)) @definition.method

(type_definition declarator: (type_identifier) @name) @definition.type

(enum_specifier name: (type_identifier) @name) @definition.type

(class_specifier name: (type_identifier) @name) @definition.class

; graft: call sites (upstream cpp tags.scm is definition-only)
(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
    (qualified_identifier name: (identifier) @name)
  ]) @reference.call

; graft: inheritance. Upstream cpp tags.scm captures no supertypes at all, so a
; C++ graph had no `extends` edges — the relation an object-oriented codebase is
; most often read for. A base list reaches graft in four shapes: a plain name, a
; namespaced one, a template instantiation, and a namespaced template.
(base_class_clause (type_identifier) @name) @reference.extends

(base_class_clause
  (qualified_identifier name: (type_identifier) @name)) @reference.extends

(base_class_clause
  (template_type name: (type_identifier) @name)) @reference.extends

(base_class_clause
  (qualified_identifier name: (template_type name: (type_identifier) @name))) @reference.extends

; graft: `new Derived()` names a type without inheriting from it — a reference,
; deliberately a different verb from the base list above.
(new_expression type: (type_identifier) @name) @reference.class

(new_expression
  type: (qualified_identifier name: (type_identifier) @name)) @reference.class
