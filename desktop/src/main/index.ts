import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startApplication } from "./app/bootstrap";

startApplication(dirname(fileURLToPath(import.meta.url)));
