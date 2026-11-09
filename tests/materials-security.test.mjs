import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { authenticate, requireCourseOwner, validateFile, MAX_FILE_SIZE } from "../netlify/lib/materials-security.mjs";
import { projectId } from "../netlify/lib/firebase-project.mjs";

const { privateKey, publicKey } = await generateKeyPair("RS256");
async function signedRequest(overrides = {}, key = privateKey) {
  const token = await new SignJWT({
    sub: "teacher-a", aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256" }).sign(key);
  return new Request("https://example.test", { headers: { Authorization: `Bearer ${token}` } });
}

test("accepts a signed Firebase session for this project", async () => {
  assert.equal((await authenticate(await signedRequest(), publicKey)).uid, "teacher-a");
});

test("rejects absent, expired, wrong-project, wrong-issuer and forged sessions", async () => {
  await assert.rejects(authenticate(new Request("https://example.test"), publicKey), { status: 401 });
  for (const claims of [{ exp: 1 }, { aud: "other-project" }, { iss: "https://attacker.test" }, { sub: "" }]) {
    await assert.rejects(authenticate(await signedRequest(claims), publicKey), { status: 401 });
  }
  const other = await generateKeyPair("RS256");
  await assert.rejects(authenticate(await signedRequest({}, other.privateKey), publicKey), { status: 401 });
});

function firestore(owner, role, status = 200) {
  return async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer session");
    const fields = url.includes("/courses/")
      ? { teacherId: { stringValue: owner } }
      : { role: { stringValue: role } };
    return Response.json({ fields }, { status });
  };
}
const session = { uid: "teacher-a", token: "session" };

test("only the course's actual teacher may write or delete", async () => {
  await requireCourseOwner(session, "course-a", firestore("teacher-a", "docente"));
  for (const [owner, role] of [["teacher-b", "docente"], ["teacher-a", "estudiante"], ["teacher-a", "direccion"]]) {
    await assert.rejects(requireCourseOwner(session, "course-a", firestore(owner, role)), { status: 403 });
  }
});

test("missing or unreadable courses fail closed", async () => {
  for (const [status, expected] of [[404, 404], [403, 403], [500, 503]]) {
    await assert.rejects(requireCourseOwner(session, "course-a", firestore("teacher-a", "docente", status)), { status: expected });
  }
});

test("accepts supported file signatures and rejects spoofing, SVG, empty and oversized files", () => {
  for (const [type, bytes] of [
    ["application/pdf", [37, 80, 68, 70, 45]],
    ["image/jpeg", [255, 216, 255]],
    ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
    ["image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
  ]) {
    validateFile({ type, size: bytes.length }, new Uint8Array(bytes).buffer);
  }
  for (const file of [
    { type: "application/pdf", size: 5 },
    { type: "image/svg+xml", size: 5 },
    { type: "image/jpeg", size: 0 },
    { type: "image/jpeg", size: MAX_FILE_SIZE + 1 },
  ]) {
    assert.throws(() => validateFile(file, new Uint8Array([60, 104, 116, 109, 108]).buffer), { status: 400 });
  }
});
