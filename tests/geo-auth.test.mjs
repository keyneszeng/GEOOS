import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../geo/store.mjs";
import { openAuth, canWrite } from "../geo/auth.mjs";
const password = "test-password-12345";
test("bootstrap preserves existing workspaces, no default password, token expiration and revocation", () => {
  const s = openStore(":memory:");
  try {
    const old = s.createWorkspace({ name: "Existing", brand: "Acme" });
    assert.throws(() => openAuth(s));
    let t = 100000;
    const a = openAuth(s, { bootstrapUser: "admin", bootstrapPassword: password, clock: () => t });
    assert.equal(a.login({ username: "admin", password: "wrong" }), null);
    const token = a.login({ username: "admin", password }),
      req = { headers: { cookie: "geo_session=" + token } };
    const u = a.authenticate(req);
    assert.equal(a.role(old.id, u.id), "owner");
    assert.equal(a.list(u.id).length, 1);
    assert.notEqual(s.db.prepare("SELECT token_hash FROM geo_sessions").get().token_hash, token);
    t += 9 * 3600000;
    assert.equal(a.authenticate(req), undefined);
    const second = a.login({ username: "admin", password });
    const req2 = { headers: { cookie: "geo_session=" + second } };
    a.logout(req2);
    assert.equal(a.authenticate(req2), undefined);
  } finally {
    s.db.close();
  }
});
test("roles, no cross-tenant visibility, owner protection and audit", () => {
  const s = openStore(":memory:");
  try {
    const a = openAuth(s, { bootstrapUser: "admin", bootstrapPassword: password });
    const token = a.login({ username: "admin", password }),
      admin = a.authenticate({ headers: { cookie: "geo_session=" + token } });
    const w = a.createWorkspace(admin.id, { name: "A", brand: "Acme" }),
      b = a.provision(admin, { username: "editor", password });
    assert.equal(a.list(b.id).length, 0);
    a.setMember(w.id, admin.id, { username: "editor", role: "editor" });
    assert.equal(a.list(b.id)[0].role, "editor");
    assert.equal(canWrite("editor", "facts", "review"), false);
    assert.equal(canWrite("reviewer", "actions", "transition", "approved"), true);
    assert.equal(canWrite("reviewer", "agent", "run"), false);
    assert.equal(canWrite("viewer", "samples"), false);
    assert.throws(() => a.setMember(w.id, b.id, { username: "editor", role: "owner" }));
    assert.throws(() => a.removeMember(w.id, admin.id, { username: "admin" }));
    a.removeMember(w.id, admin.id, { username: "editor" });
    assert.equal(a.list(b.id).length, 0);
    assert.equal(a.logs(w.id).length, 3);
  } finally {
    s.db.close();
  }
});
