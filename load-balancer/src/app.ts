import express from "express";
import { createServer } from "./controllers/servers.create.ts";
import { provisionServer } from "./controllers/servers.provision.ts";

export const app = express();

app.use(express.json());

app.get("/servers/provision", provisionServer);
app.post("/servers/create", createServer);
