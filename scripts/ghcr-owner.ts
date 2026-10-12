#!/usr/bin/env bun
import { ownerFromRepository } from "../packages/core/src/ghcr.ts";

const repository = process.argv[2];
if (!repository) throw new Error("A GHCR repository is required");
process.stdout.write(ownerFromRepository(repository));
