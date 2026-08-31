/** Entry point for the listenOrExit tests in ../run-if-main.test.ts. */
import express from "express";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

runIfMain(import.meta.url, async () => {
  const app = express();
  app.get("/probe", (_request, response) => response.status(200).send("ok"));

  const port = demoPort();
  const host = process.env.HOST ?? "0.0.0.0";

  if (process.env.EXIT_ONCE_LISTENING) {
    // Prove it is really serving, not just that it said so, then stop: a
    // successful bind would otherwise keep this process alive forever.
    setTimeout(async () => {
      try {
        const response = await fetch(`http://${host}:${port}/probe`);
        console.log(`SELF REQUEST STATUS ${response.status}`);
      } catch (error) {
        console.error("SELF REQUEST FAILED", error);
        process.exitCode = 2;
      }
      process.exit(process.exitCode ?? 0);
    }, 750);
  }

  listenOrExit(app, "bind-probe", port);
});
