import fs from "fs";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const testEnv = await initializeTestEnvironment({
  projectId: "recargaspacuba-7aaa8",
  firestore: {
    host: "127.0.0.1",
    port: 8080,
    rules: fs.readFileSync("../../firestore.rules", "utf8"),
  },
});

const aaa = testEnv.authenticatedContext("AAA").firestore();

await assertFails(setDoc(doc(aaa, "mb_orders", "clientCreate"), { uid: "AAA" }));
await assertFails(updateDoc(doc(aaa, "mb_orders", "test1"), { any: "x" }));
await assertFails(deleteDoc(doc(aaa, "mb_orders", "test1")));

console.log("PASS: mb_orders write rules (create/update/delete denied from client)");
await testEnv.cleanup();
