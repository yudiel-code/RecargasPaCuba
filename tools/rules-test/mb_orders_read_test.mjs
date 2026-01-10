import fs from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const testEnv = await initializeTestEnvironment({
  projectId: "recargaspacuba-7aaa8",
  firestore: {
    host: "127.0.0.1",
    port: 8080,
    rules: fs.readFileSync("../../firestore.rules", "utf8"),
  },
});

await testEnv.withSecurityRulesDisabled(async (context) => {
  const adminDb = context.firestore();
  await setDoc(doc(adminDb, "mb_orders", "test1"), { uid: "AAA" });
});

const aaa = testEnv.authenticatedContext("AAA").firestore();
const bbb = testEnv.authenticatedContext("BBB").firestore();
const unauth = testEnv.unauthenticatedContext().firestore();

await assertSucceeds(getDoc(doc(aaa, "mb_orders", "test1")));
await assertFails(getDoc(doc(bbb, "mb_orders", "test1")));
await assertFails(getDoc(doc(unauth, "mb_orders", "test1")));

console.log("PASS: mb_orders read rules (AAA allow / BBB deny / unauth deny)");
await testEnv.cleanup();
