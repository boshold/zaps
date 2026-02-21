/* eslint-disable import/no-namespace */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeProcess from "node:process";
import * as url from "node:url";
/* eslint-enable import/no-namespace */

export const nodeModules = { path, fs, process: nodeProcess, url, os, child_process };

export type NodeModules = typeof nodeModules;
