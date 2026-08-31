/** Entry point for the runIfMain rejection test in ../run-if-main.test.ts. */
import { runIfMain } from "../run-if-main";

runIfMain(import.meta.url, async () => {
  console.log("MAIN RAN");
  throw new Error("no API key for you");
});
