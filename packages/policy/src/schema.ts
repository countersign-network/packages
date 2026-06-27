/**
 * The policy CONTRACT (schema + type + validators) moved to @countersign/core — the open interface
 * package — so the public front door can describe and validate a policy without this package's
 * proprietary compiler. Re-exported here so `@countersign/policy` keeps its existing public surface
 * and the compiler/evaluator (./compile, ./native, ./evaluate) can keep importing the shape from
 * "./schema" unchanged. The IP in this package is the lowering/semantics — not the shape.
 */
export { UnifiedPolicySchema, parsePolicy, definePolicy, type UnifiedPolicy } from "@countersign/core";
