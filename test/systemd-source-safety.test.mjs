import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("optional original systemd receiver is read-only and no longer writes orphan JSON",()=>{
 const text=readFileSync(new URL("../systemd/github-reconcile.service",import.meta.url),"utf8");
 assert.match(text,/^ProtectSystem=strict$/mu);
 assert.match(text,/^NoNewPrivileges=yes$/mu);
 assert.match(text,/^CapabilityBoundingSet=$/mu);
 assert.match(text,/^ExecStart=.*github-reconcile\.mjs/mu);
 assert.doesNotMatch(text,/\s--apply(?:\s|$)/mu);
 assert.doesNotMatch(text,/\s--register(?:\s|$)/mu);
 assert.doesNotMatch(text,/^StateDirectory=/mu);
 assert.match(text,/--org red-cup-engineering/u);
});
